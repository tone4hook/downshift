import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ErrorObject } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const MODEL_ROLES = ["classifier", "weak", "strong"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  currency: "USD";
  asOf: string;
}

export interface PiModelIdentity {
  provider: string;
  model: string;
}

export interface LabModelRole extends PiModelIdentity {
  billing: "unknown" | "subscription" | "per-token";
  pricing?: ModelPricing;
}

export type PiRoleConfig = Record<ModelRole, PiModelIdentity>;

export interface LabConfig {
  schemaVersion: 1;
  authProfile: string;
  models: Record<ModelRole, LabModelRole>;
  routing: {
    weakThreshold: number;
    weakCapabilityDescription: string;
  };
  execution: {
    maxAgentTurns: number;
    timeoutSeconds: number;
    requestTimeoutSeconds: number;
    validationTimeoutSeconds: number;
    contextTokenCap: number;
    maxOutputTokens: number;
    thinking: "off";
  };
}

export interface ResolvedPiRoleModels {
  classifier: Model<Api>;
  weak: Model<Api>;
  strong: Model<Api>;
}

export interface CommonModelEnvelope {
  contextTokenCap: number;
  maxOutputTokens: number;
  classifierMaxOutputTokens: number;
  thinking: "off";
}

export interface LibraryPolicy {
  weakThreshold: number;
  weakCapabilityDescription: string;
  maxOutputTokens: number;
}

export interface ConfigFingerprint {
  value: string;
  configHash: string;
  modelMetadataHash: string;
  providerConfigHash: string;
  capabilityCardHash: string;
}

const profilePattern = "^[a-z0-9][a-z0-9-]{0,31}$";
const positiveInteger = { type: "integer", minimum: 1, maximum: 2_147_483_647 } as const;
const pricingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inputPerMillion", "outputPerMillion", "currency", "asOf"],
  properties: {
    inputPerMillion: { type: "number", minimum: 0 },
    outputPerMillion: { type: "number", minimum: 0 },
    cacheReadPerMillion: { type: "number", minimum: 0 },
    cacheWritePerMillion: { type: "number", minimum: 0 },
    currency: { const: "USD" },
    asOf: { type: "string", format: "date" },
  },
} as const;
const modelRoleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider", "model"],
  properties: {
    provider: { type: "string", minLength: 1, pattern: "\\S" },
    model: { type: "string", minLength: 1, pattern: "\\S" },
    billing: { enum: ["unknown", "subscription", "per-token"] },
    pricing: pricingSchema,
  },
  allOf: [
    {
      if: {
        type: "object",
        properties: { billing: { const: "per-token" } },
        required: ["billing"],
      },
      then: { properties: { pricing: pricingSchema }, required: ["pricing"] },
      else: { properties: { pricing: false } },
    },
  ],
} as const;

export const LAB_CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "authProfile", "models", "routing", "execution"],
  properties: {
    schemaVersion: { const: 1 },
    authProfile: { type: "string", pattern: profilePattern },
    models: {
      type: "object",
      additionalProperties: false,
      required: MODEL_ROLES,
      properties: {
        classifier: modelRoleSchema,
        weak: modelRoleSchema,
        strong: modelRoleSchema,
      },
    },
    routing: {
      type: "object",
      additionalProperties: false,
      required: ["weakThreshold", "weakCapabilityDescription"],
      properties: {
        weakThreshold: { type: "number", minimum: 0, maximum: 1 },
        weakCapabilityDescription: { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S" },
      },
    },
    execution: {
      type: "object",
      additionalProperties: false,
      required: [
        "maxAgentTurns",
        "timeoutSeconds",
        "requestTimeoutSeconds",
        "validationTimeoutSeconds",
        "contextTokenCap",
        "maxOutputTokens",
        "thinking",
      ],
      properties: {
        maxAgentTurns: positiveInteger,
        timeoutSeconds: positiveInteger,
        requestTimeoutSeconds: positiveInteger,
        validationTimeoutSeconds: positiveInteger,
        contextTokenCap: positiveInteger,
        maxOutputTokens: positiveInteger,
        thinking: { const: "off" },
      },
    },
  },
} as const;

const ajv = new Ajv2020Module.default({ allErrors: true, strict: true });
ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
const validateLabConfig = ajv.compile(LAB_CONFIG_SCHEMA);

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => {
      const location = error.instancePath || "/";
      if (error.keyword === "additionalProperties") {
        return `${location} contains unknown field ${String(error.params.additionalProperty)}`;
      }
      return `${location} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}

function normalizeRole(identity: PiModelIdentity & Partial<LabModelRole>): LabModelRole {
  return {
    provider: identity.provider,
    model: identity.model,
    billing: identity.billing ?? "unknown",
    ...(identity.pricing === undefined ? {} : { pricing: { ...identity.pricing } }),
  };
}

export function validateConfig(value: unknown): LabConfig {
  if (!validateLabConfig(value)) {
    throw new Error(`Invalid lab configuration: ${validationMessage(validateLabConfig.errors)}`);
  }
  const config = structuredClone(value) as LabConfig;
  for (const role of MODEL_ROLES) config.models[role] = normalizeRole(config.models[role]);
  if (config.execution.requestTimeoutSeconds > config.execution.timeoutSeconds) {
    throw new Error("Invalid lab configuration: /execution/requestTimeoutSeconds must not exceed timeoutSeconds");
  }
  return config;
}

export async function loadConfig(path: string): Promise<LabConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read lab configuration: ${path}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid lab configuration JSON: ${path}`, { cause: error });
  }
  return validateConfig(parsed);
}

export function resolveCommonModelEnvelope(
  config: LabConfig,
  roles: ResolvedPiRoleModels,
): CommonModelEnvelope {
  const contextTokenCap = Math.min(
    config.execution.contextTokenCap,
    roles.weak.contextWindow,
    roles.strong.contextWindow,
  );
  const maxOutputTokens = Math.min(
    config.execution.maxOutputTokens,
    roles.weak.maxTokens,
    roles.strong.maxTokens,
    contextTokenCap,
  );
  const classifierMaxOutputTokens = Math.min(
    config.execution.maxOutputTokens,
    roles.classifier.maxTokens,
    roles.classifier.contextWindow,
  );
  if (contextTokenCap < 1 || maxOutputTokens < 1 || classifierMaxOutputTokens < 1) {
    throw new Error("Configured Pi roles do not expose compatible positive context and output limits");
  }
  return { contextTokenCap, maxOutputTokens, classifierMaxOutputTokens, thinking: "off" };
}

export function createLibraryPolicy(config: LabConfig, roles: ResolvedPiRoleModels): LibraryPolicy {
  const envelope = resolveCommonModelEnvelope(config, roles);
  return {
    weakThreshold: config.routing.weakThreshold,
    weakCapabilityDescription: config.routing.weakCapabilityDescription,
    maxOutputTokens: envelope.classifierMaxOutputTokens,
  };
}

/** The pinned Pi SDK cannot lower coding limits independently of native metadata. */
export function validateCodingCompatibility(config: LabConfig, roles: ResolvedPiRoleModels): CommonModelEnvelope {
  const envelope = resolveCommonModelEnvelope(config, roles);
  if ([roles.weak, roles.strong].some((model) =>
    model.contextWindow !== envelope.contextTokenCap || model.maxTokens !== envelope.maxOutputTokens)) {
    throw new Error(
      "Pi 0.85.0 does not expose per-session coding context/output overrides; " +
      "choose execution models with matching native limits and configure those limits. " +
      `Weak: contextTokenCap=${roles.weak.contextWindow}, maxOutputTokens=${roles.weak.maxTokens}; ` +
      `strong: contextTokenCap=${roles.strong.contextWindow}, maxOutputTokens=${roles.strong.maxTokens}`,
    );
  }
  return envelope;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function publicModelMetadata(model: Model<Api>) {
  return {
    provider: model.provider,
    model: model.id,
    api: model.api,
    name: model.name,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input].sort(),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevelMap: model.thinkingLevelMap ?? null,
    compat: model.compat ?? null,
  };
}

const SECRET_KEY = /(?:^|[-_])(auth|authorization|credential|secret|token|api[-_]?key|account|expiry|expires)(?:$|[-_])/i;

function nonSecretProviderConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nonSecretProviderConfig);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, child]) => [key, nonSecretProviderConfig(child)]),
  );
}

export function configFingerprint(
  config: LabConfig,
  roles: ResolvedPiRoleModels,
  runtime: ModelRuntime,
  authProfile = config.authProfile,
): ConfigFingerprint {
  const canonicalConfig = { ...config, authProfile };
  const metadata = Object.fromEntries(MODEL_ROLES.map((role) => [role, publicModelMetadata(roles[role])]));
  const providerConfig = Object.fromEntries(
    [...new Set(MODEL_ROLES.map((role) => roles[role].provider))]
      .sort()
      .map((provider) => [provider, nonSecretProviderConfig(runtime.getRegisteredProviderConfig(provider) ?? null)]),
  );
  const configHash = hash(canonicalConfig);
  const modelMetadataHash = hash(metadata);
  const providerConfigHash = hash(providerConfig);
  const capabilityCardHash = hash(config.routing.weakCapabilityDescription);
  return {
    value: hash({ configHash, modelMetadataHash, providerConfigHash, capabilityCardHash, authProfile }),
    configHash,
    modelMetadataHash,
    providerConfigHash,
    capabilityCardHash,
  };
}
