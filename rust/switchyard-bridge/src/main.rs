use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use switchyard_libsy::{
    CapabilityClassifierDecision, CapabilityClassifierEvidence, LlmClassifierConfig,
    LlmTaskClassifier, TaskClassifierConfig, drive_with_decision,
};
use switchyard_protocol::{
    LlmResponse, Metadata, Request, Response, Usage, text_request, text_response,
};
use tokio::{
    io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};

const PROTOCOL_VERSION: u8 = 1;
const MAX_FRAME_BYTES: usize = 1024 * 1024;

type Reader = Arc<Mutex<BufReader<io::Stdin>>>;
type Writer = Arc<Mutex<io::Stdout>>;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InputFrame {
    Start {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[serde(rename = "decisionId")]
        decision_id: String,
        task: String,
        policy: Policy,
        #[serde(rename = "targetAliases")]
        target_aliases: TargetAliases,
    },
    ModelResult {
        #[serde(rename = "decisionId")]
        decision_id: String,
        #[serde(rename = "callId")]
        call_id: String,
        response: ModelResponse,
    },
    ModelError {
        #[serde(rename = "decisionId")]
        decision_id: String,
        #[serde(rename = "callId")]
        call_id: String,
        error: ModelError,
    },
    Cancel {
        #[serde(rename = "decisionId")]
        decision_id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    #[serde(rename = "weakThreshold")]
    weak_threshold: f64,
    #[serde(
        rename = "weakCapabilityDescription",
        default = "default_weak_capability_description"
    )]
    weak_capability_description: String,
    #[serde(rename = "maxOutputTokens")]
    max_output_tokens: u64,
}

fn default_weak_capability_description() -> String {
    "Use Switchyard's packaged efficient-agent capability card.".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetAliases {
    classifier: String,
    weak: String,
    strong: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelResponse {
    text: String,
    #[serde(default)]
    usage: ModelUsage,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelUsage {
    #[serde(rename = "inputTokens")]
    input_tokens: Option<u64>,
    #[serde(rename = "outputTokens")]
    output_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelError {
    kind: String,
    message: String,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutputFrame<'a> {
    Ready {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
    },
    CallModel {
        #[serde(rename = "decisionId")]
        decision_id: &'a str,
        #[serde(rename = "callId")]
        call_id: &'a str,
        #[serde(rename = "targetAlias")]
        target_alias: &'a str,
        request: &'a switchyard_protocol::LlmRequest,
    },
    Decision {
        #[serde(rename = "decisionId")]
        decision_id: &'a str,
        #[serde(rename = "selectedAlias")]
        selected_alias: &'a str,
        evidence: DecisionEvidence,
    },
    Error {
        #[serde(rename = "decisionId", skip_serializing_if = "Option::is_none")]
        decision_id: Option<&'a str>,
        kind: &'a str,
        message: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DecisionEvidence {
    ValidatedVerdict {
        #[serde(rename = "weakSolveProbability")]
        weak_solve_probability: f64,
    },
    Fallback {
        reason: String,
    },
}

async fn read_frame(reader: &Reader) -> Result<Option<InputFrame>, String> {
    let mut line = String::new();
    let bytes = reader
        .lock()
        .await
        .read_line(&mut line)
        .await
        .map_err(|error| format!("failed to read bridge frame: {error}"))?;
    if bytes == 0 {
        return Ok(None);
    }
    if bytes > MAX_FRAME_BYTES {
        return Err(format!("bridge frame exceeds {MAX_FRAME_BYTES} bytes"));
    }
    serde_json::from_str(line.trim_end())
        .map(Some)
        .map_err(|error| format!("invalid bridge frame: {error}"))
}

async fn write_frame(writer: &Writer, frame: &OutputFrame<'_>) -> Result<(), String> {
    let mut bytes =
        serde_json::to_vec(frame).map_err(|error| format!("failed to serialize bridge frame: {error}"))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(format!("bridge frame exceeds {MAX_FRAME_BYTES} bytes"));
    }
    bytes.push(b'\n');
    let mut output = writer.lock().await;
    output
        .write_all(&bytes)
        .await
        .map_err(|error| format!("failed to write bridge frame: {error}"))?;
    output
        .flush()
        .await
        .map_err(|error| format!("failed to flush bridge frame: {error}"))
}

async fn resolve_decision(
    reader: Reader,
    writer: Writer,
    decision_id: String,
    task: String,
    policy: Policy,
    targets: TargetAliases,
) -> Result<(), String> {
    if policy.max_output_tokens == 0 {
        return Err("maxOutputTokens must be at least 1".to_string());
    }
    if policy.weak_capability_description.trim().is_empty() {
        return Err("weakCapabilityDescription must not be empty".to_string());
    }

    let mut config = TaskClassifierConfig::default();
    config.base_threshold = policy.weak_threshold;
    config.threshold_step = 0.0;
    config.max_output_tokens = policy.max_output_tokens;

    let classifier = Arc::new(
        LlmTaskClassifier::new(LlmClassifierConfig::Capability {
            judge_target: targets.classifier.clone().into(),
            efficient_target: targets.weak.clone().into(),
            capable_target: targets.strong.clone().into(),
            config,
        })
        .map_err(|error| error.to_string())?,
    );
    let task_with_capability = format!(
        "Configured efficient-agent capability description (qualitative evidence only):\n{}\n\nTask to forecast:\n{}",
        policy.weak_capability_description, task
    );
    let request = Request {
        llm_request: text_request(Some("auto".to_string()), task_with_capability),
        raw_request: None,
        metadata: Some(Metadata {
            session_id: Some(decision_id.clone()),
            ..Metadata::default()
        }),
    };
    let call_sequence = Arc::new(AtomicU64::new(0));
    let expected_decision_id = decision_id.clone();
    let expected_classifier = targets.classifier.clone();
    let callback_writer = Arc::clone(&writer);

    let detailed = drive_with_decision(classifier, request, move |call| {
        let reader = Arc::clone(&reader);
        let writer = Arc::clone(&callback_writer);
        let decision_id = expected_decision_id.clone();
        let classifier = expected_classifier.clone();
        let call_id = format!("call-{}", call_sequence.fetch_add(1, Ordering::Relaxed) + 1);
        async move {
            let target = call
                .request
                .model_id()
                .ok_or_else(|| switchyard_libsy::LibsyError::AlgorithmError {
                    message: "classifier call has no target".to_string(),
                })?
                .to_string();
            if target != classifier || call.models.len() != 1 {
                return Err(switchyard_libsy::LibsyError::AlgorithmError {
                    message: "routing-time call targeted an unexpected alias".to_string(),
                });
            }
            write_frame(
                &writer,
                &OutputFrame::CallModel {
                    decision_id: &decision_id,
                    call_id: &call_id,
                    target_alias: &target,
                    request: &call.request.llm_request,
                },
            )
            .await
            .map_err(|message| switchyard_libsy::LibsyError::AlgorithmError { message })?;

            let response = read_frame(&reader)
                .await
                .map_err(|message| switchyard_libsy::LibsyError::AlgorithmError { message })?
                .ok_or_else(|| switchyard_libsy::LibsyError::AlgorithmError {
                    message: "bridge input closed before model result".to_string(),
                })?;
            match response {
                InputFrame::ModelResult {
                    decision_id: received_decision,
                    call_id: received_call,
                    response,
                } if received_decision == decision_id && received_call == call_id => {
                    let mut aggregate = text_response(Some(classifier), response.text);
                    aggregate.usage = Usage {
                        input_tokens: response.usage.input_tokens,
                        output_tokens: response.usage.output_tokens,
                        total_tokens: match (response.usage.input_tokens, response.usage.output_tokens) {
                            (Some(input), Some(output)) => Some(input + output),
                            _ => None,
                        },
                        ..Usage::default()
                    };
                    call.respond(Ok(Response {
                        llm_response: LlmResponse::Agg(aggregate),
                        metadata: None,
                    }))
                }
                InputFrame::ModelError {
                    decision_id: received_decision,
                    call_id: received_call,
                    error,
                } if received_decision == decision_id && received_call == call_id => {
                    call.respond(Err(switchyard_libsy::LibsyError::AlgorithmError {
                        message: format!("model_error:{}:{}", error.kind, error.message),
                    }))
                }
                InputFrame::Cancel {
                    decision_id: received_decision,
                } if received_decision == decision_id => Err(switchyard_libsy::LibsyError::AlgorithmError {
                    message: "decision cancelled".to_string(),
                }),
                _ => Err(switchyard_libsy::LibsyError::AlgorithmError {
                    message: "unsolicited, duplicate, or mismatched bridge frame".to_string(),
                }),
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?;

    let selected = detailed
        .outcome
        .selected_model_id()
        .map_err(|error| error.to_string())?
        .to_string();
    if selected != targets.weak && selected != targets.strong {
        return Err("Switchyard selected an unconfigured alias".to_string());
    }
    let decision = detailed
        .decision()
        .and_then(|value| value.as_any().downcast_ref::<CapabilityClassifierDecision>())
        .ok_or_else(|| "Switchyard returned no capability evidence".to_string())?;
    let evidence = match decision.evidence() {
        CapabilityClassifierEvidence::ValidatedVerdict { p_solve } => {
            DecisionEvidence::ValidatedVerdict {
                weak_solve_probability: p_solve,
            }
        }
        CapabilityClassifierEvidence::Fallback { reason } => DecisionEvidence::Fallback {
            reason: reason.as_str().to_string(),
        },
    };
    write_frame(
        &writer,
        &OutputFrame::Decision {
            decision_id: &decision_id,
            selected_alias: &selected,
            evidence,
        },
    )
    .await
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let reader = Arc::new(Mutex::new(BufReader::new(io::stdin())));
    let writer = Arc::new(Mutex::new(io::stdout()));
    if let Err(message) = write_frame(
        &writer,
        &OutputFrame::Ready {
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .await
    {
        eprintln!("{message}");
        std::process::exit(1);
    }

    loop {
        let frame = match read_frame(&reader).await {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(message) => {
                let _ = write_frame(
                    &writer,
                    &OutputFrame::Error {
                        decision_id: None,
                        kind: "protocol",
                        message,
                    },
                )
                .await;
                continue;
            }
        };
        match frame {
            InputFrame::Start {
                protocol_version,
                decision_id,
                task,
                policy,
                target_aliases,
            } => {
                let result = if protocol_version != PROTOCOL_VERSION {
                    Err(format!(
                        "unsupported protocol version {protocol_version}; expected {PROTOCOL_VERSION}"
                    ))
                } else {
                    resolve_decision(
                        Arc::clone(&reader),
                        Arc::clone(&writer),
                        decision_id.clone(),
                        task,
                        policy,
                        target_aliases,
                    )
                    .await
                };
                if let Err(message) = result {
                    let _ = write_frame(
                        &writer,
                        &OutputFrame::Error {
                            decision_id: Some(&decision_id),
                            kind: if message.contains("cancelled") {
                                "cancelled"
                            } else if message.contains("model_error:") {
                                "model"
                            } else {
                                "protocol"
                            },
                            message,
                        },
                    )
                    .await;
                }
            }
            _ => {
                let _ = write_frame(
                    &writer,
                    &OutputFrame::Error {
                        decision_id: None,
                        kind: "protocol",
                        message: "expected a start frame".to_string(),
                    },
                )
                .await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_frames_never_serialize_secret_fields() {
        let request = text_request(Some("classifier".to_string()), "task");
        let frame = OutputFrame::CallModel {
            decision_id: "decision-1",
            call_id: "call-1",
            target_alias: "classifier",
            request: &request,
        };
        let encoded = serde_json::to_string(&frame).expect("frame serializes");
        for forbidden in ["authorization", "access_token", "refresh_token", "provider_url"] {
            assert!(!encoded.contains(forbidden));
        }
    }
}
