import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface, type Interface } from "node:readline";
import {
  BRIDGE_PROTOCOL_VERSION,
  MAX_BRIDGE_FRAME_BYTES,
  type BridgeCallModelFrame,
  type BridgeDecision,
  type BridgeModelErrorFrame,
  type BridgeModelResultFrame,
  type BridgeStartFrame,
  type ClassifierResult,
} from "./protocol.js";

const SAFE_ENVIRONMENT_KEYS = ["HOME", "LANG", "LC_ALL", "PATH", "RUST_BACKTRACE", "TERM", "TMPDIR"] as const;

export interface ResolveDecisionOptions {
  decisionId: string;
  task: string;
  weakThreshold: number;
  weakCapabilityDescription?: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  callClassifier: (request: BridgeCallModelFrame) => Promise<ClassifierResult>;
}

interface ReadyFrame {
  type: "ready";
  protocolVersion: number;
}

interface ErrorFrame {
  type: "error";
  decisionId?: string;
  kind: string;
  message: string;
}

type OutputFrame = ReadyFrame | BridgeCallModelFrame | ({ type: "decision" } & BridgeDecision) | ErrorFrame;

export class BridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeProtocolError";
  }
}

function sanitizedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    SAFE_ENVIRONMENT_KEYS.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  );
}

function parseFrame(line: string): OutputFrame {
  if (Buffer.byteLength(line, "utf8") > MAX_BRIDGE_FRAME_BYTES) {
    throw new BridgeProtocolError(`Bridge frame exceeds ${MAX_BRIDGE_FRAME_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new BridgeProtocolError(`Bridge emitted invalid JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || typeof parsed.type !== "string") {
    throw new BridgeProtocolError("Bridge emitted a frame without a string type");
  }
  const frame = parsed as Record<string, unknown>;
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const id = (value: unknown) => typeof value === "string" && value.length > 0;
  const messages = (value: unknown) => Array.isArray(value) && value.every((message: unknown) =>
    object(message) && typeof message.role === "string" && Array.isArray(message.content) &&
    message.content.every((block: unknown) => object(block) && typeof block.type === "string" &&
      (block.text === undefined || typeof block.text === "string")));
  let valid = false;
  if (frame.type === "ready") valid = frame.protocolVersion === BRIDGE_PROTOCOL_VERSION;
  if (frame.type === "error") valid = id(frame.decisionId) && id(frame.kind) && typeof frame.message === "string";
  if (frame.type === "call_model") {
    const request = frame.request;
    valid = id(frame.decisionId) && id(frame.callId) && frame.targetAlias === "classifier" &&
      object(request) && messages(request.messages) &&
      (request.instructions === undefined || request.instructions === null || messages(request.instructions)) &&
      (request.output === undefined || request.output === null || (object(request.output) &&
        (request.output.max_output_tokens === undefined || request.output.max_output_tokens === null ||
          (Number.isSafeInteger(request.output.max_output_tokens) && Number(request.output.max_output_tokens) > 0))));
  }
  if (frame.type === "decision" && object(frame.evidence)) {
    const evidence = frame.evidence;
    valid = id(frame.decisionId) && (frame.selectedAlias === "weak" || frame.selectedAlias === "strong") &&
      ((evidence.kind === "fallback" && evidence.reason === "invalid_verdict" && frame.selectedAlias === "strong") ||
       (evidence.kind === "validated_verdict" && typeof evidence.weakSolveProbability === "number" &&
        Number.isFinite(evidence.weakSolveProbability) && evidence.weakSolveProbability >= 0 && evidence.weakSolveProbability <= 1));
  }
  if (!valid) throw new BridgeProtocolError(`Bridge emitted an invalid ${frame.type} frame`);
  return frame as unknown as OutputFrame;
}

export class SwitchyardBridgeClient {
  readonly process: ChildProcessWithoutNullStreams;
  readonly lines: Interface;
  readonly iterator: AsyncIterator<string>;
  private stderr = "";
  private closed = false;
  private active = false;

  private constructor(process: ChildProcessWithoutNullStreams) {
    this.process = process;
    this.lines = createInterface({ input: process.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    this.iterator = this.lines[Symbol.asyncIterator]();
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8192);
    });
  }

  static async start(
    executable: string,
    options: { readyTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
  ): Promise<SwitchyardBridgeClient> {
    const child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizedEnvironment(options.env ?? process.env),
    });
    const client = new SwitchyardBridgeClient(child);
    const timeoutMs = options.readyTimeoutMs ?? 5000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BridgeProtocolError("Bridge ready timeout")), timeoutMs);
      timer.unref();
    });
    try {
      const ready = await Promise.race([client.nextFrame(), timeout]);
      if (ready.type !== "ready" || ready.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
        throw new BridgeProtocolError("Bridge emitted an incompatible ready frame");
      }
      return client;
    } catch (error) {
      await client.dispose();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async resolveDecision(options: ResolveDecisionOptions): Promise<BridgeDecision> {
    if (this.closed) throw new BridgeProtocolError("Bridge exited or was disposed");
    if (this.active) throw new BridgeProtocolError("Bridge already has an active decision");
    options.signal?.throwIfAborted();
    this.active = true;
    const start: BridgeStartFrame = {
      type: "start",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      decisionId: options.decisionId,
      task: options.task,
      policy: {
        weakThreshold: options.weakThreshold,
        weakCapabilityDescription:
          options.weakCapabilityDescription ?? "Use Switchyard's packaged efficient-agent capability card.",
        maxOutputTokens: options.maxOutputTokens,
      },
      targetAliases: {
        classifier: "classifier",
        weak: "weak",
        strong: "strong",
      },
    };
    let classifierCalled = false;

    const onAbort = () => {
      this.writeFrame({ type: "cancel", decisionId: options.decisionId });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.writeFrame(start);
      while (true) {
        const frame = await this.nextFrame();
        if ("decisionId" in frame && frame.decisionId !== undefined && frame.decisionId !== options.decisionId) {
          throw new BridgeProtocolError("Bridge returned a mismatched decision ID");
        }
        if (frame.type === "call_model") {
          if (classifierCalled) throw new BridgeProtocolError("Bridge requested duplicate classifier inference");
          classifierCalled = true;
          if (frame.targetAlias !== "classifier") {
            throw new BridgeProtocolError("Bridge requested an unconfigured routing-time alias");
          }
          const result = await options.callClassifier(frame);
          if ("error" in result) {
            const response: BridgeModelErrorFrame = {
              type: "model_error",
              decisionId: frame.decisionId,
              callId: frame.callId,
              error: result.error,
            };
            this.writeFrame(response);
          } else {
            const response: BridgeModelResultFrame = {
              type: "model_result",
              decisionId: frame.decisionId,
              callId: frame.callId,
              response: {
                text: result.text,
                ...(result.usage
                  ? {
                      usage: {
                        ...(result.usage.inputTokens === undefined
                          ? {}
                          : { inputTokens: result.usage.inputTokens }),
                        ...(result.usage.outputTokens === undefined
                          ? {}
                          : { outputTokens: result.usage.outputTokens }),
                      },
                    }
                  : {}),
              },
            };
            this.writeFrame(response);
          }
          continue;
        }
        if (frame.type === "decision") {
          if (!classifierCalled) throw new BridgeProtocolError("Bridge returned a decision before classifier inference");
          return {
            decisionId: frame.decisionId,
            selectedAlias: frame.selectedAlias,
            evidence: frame.evidence,
          };
        }
        if (frame.type === "error") {
          throw new BridgeProtocolError(`${frame.kind}: ${frame.message}`);
        }
        throw new BridgeProtocolError(`Unexpected bridge frame: ${frame.type}`);
      }
    } finally {
      this.active = false;
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill("SIGTERM");
      await once(this.process, "exit");
    }
  }

  private writeFrame(frame: object): void {
    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized, "utf8") > MAX_BRIDGE_FRAME_BYTES) {
      throw new BridgeProtocolError(`Bridge frame exceeds ${MAX_BRIDGE_FRAME_BYTES} bytes`);
    }
    if (!this.process.stdin.write(`${serialized}\n`)) {
      throw new BridgeProtocolError("Bridge input backpressure exceeded");
    }
  }

  private async nextFrame(): Promise<OutputFrame> {
    const next = await this.iterator.next();
    if (next.done) {
      throw new BridgeProtocolError(
        `Bridge exited before completing the protocol${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
      );
    }
    return parseFrame(next.value);
  }
}
