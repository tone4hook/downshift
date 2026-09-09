export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const MAX_BRIDGE_FRAME_BYTES = 1024 * 1024;

export interface BridgeStartFrame {
  type: "start";
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  decisionId: string;
  task: string;
  policy: {
    weakThreshold: number;
    weakCapabilityDescription: string;
    maxOutputTokens: number;
  };
  targetAliases: {
    classifier: "classifier";
    weak: "weak";
    strong: "strong";
  };
}

export interface BridgeCallModelFrame {
  type: "call_model";
  decisionId: string;
  callId: string;
  targetAlias: "classifier";
  request: {
    model?: string | null;
    instructions?: Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    messages: Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
    output?: {
      max_output_tokens?: number | null;
      response_format?: unknown;
    };
  };
}

export interface BridgeModelResultFrame {
  type: "model_result";
  decisionId: string;
  callId: string;
  response: {
    text: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      totalTokens?: number;
    };
    provider?: string;
    model?: string;
    providerReportedModelId?: string;
  };
}

export interface BridgeModelErrorFrame {
  type: "model_error";
  decisionId: string;
  callId: string;
  error: {
    kind: "auth" | "provider" | "quota" | "rate_limit" | "transport" | "cancelled";
    message: string;
  };
}

export interface BridgeDecision {
  decisionId: string;
  selectedAlias: "weak" | "strong";
  evidence:
    | {
        kind: "validated_verdict";
        weakSolveProbability: number;
      }
    | {
        kind: "fallback";
        reason: "invalid_verdict";
      };
}

export type ClassifierResult =
  | BridgeModelResultFrame["response"]
  | {
      error: BridgeModelErrorFrame["error"];
    };
