import { mkdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type InlineExtension,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { SwitchyardBridgeClient } from "../bridge/client.js";
import { RuntimeArtifactRecorder } from "../artifacts/runtime-recorder.js";
import { loadConfig } from "../config/lab-config.js";
import { registerMockPiProvider } from "../pi/mock-provider.js";
import {
  SessionRoutingController,
  type SessionMode,
  type SessionRoutingEvent,
} from "../pi/session-routing.js";
import { resolveContainerPaths, type ContainerPaths } from "./paths.js";

export interface ContainerRuntime {
  paths: ContainerPaths;
  modelRuntime: ModelRuntime;
  sessionRuntime: AgentSessionRuntime;
  mockAuthReused: boolean | null;
  routing: SessionRoutingController | null;
  artifacts: RuntimeArtifactRecorder | null;
}

export interface ContainerRuntimeOptions {
  setupMode?: boolean;
  bridge?: SwitchyardBridgeClient;
}

function evaluationArtifactContext(environment: NodeJS.ProcessEnv): {
  artifactCollection?: "attempts";
  experimentId: string | null;
  taskId: string | null;
  repetition: number | null;
  taskHash: string | null;
  sourceHash: string | null;
  validatorHash: string | null;
} {
  if (environment.LAB_ARTIFACT_COLLECTION !== "attempts") {
    return {
      experimentId: null,
      taskId: null,
      repetition: null,
      taskHash: null,
      sourceHash: null,
      validatorHash: null,
    };
  }
  const required = [
    "LAB_ARTIFACT_ROOT",
    "LAB_EXPERIMENT_ID",
    "LAB_TASK_ID",
    "LAB_REPETITION",
    "LAB_TASK_HASH",
    "LAB_SOURCE_HASH",
    "LAB_VALIDATOR_HASH",
  ] as const;
  for (const name of required) {
    if (!environment[name]) throw new Error(`${name} is required for evaluation artifacts`);
  }
  if (!/^\d+$/.test(environment.LAB_REPETITION!)) {
    throw new Error("LAB_REPETITION must be a nonnegative integer");
  }
  for (const name of ["LAB_TASK_HASH", "LAB_SOURCE_HASH", "LAB_VALIDATOR_HASH"] as const) {
    if (!/^[0-9a-f]{64}$/.test(environment[name]!)) {
      throw new Error(`${name} must be a SHA-256 hash`);
    }
  }
  return {
    artifactCollection: "attempts",
    experimentId: environment.LAB_EXPERIMENT_ID!,
    taskId: environment.LAB_TASK_ID!,
    repetition: Number.parseInt(environment.LAB_REPETITION!, 10),
    taskHash: environment.LAB_TASK_HASH!,
    sourceHash: environment.LAB_SOURCE_HASH!,
    validatorHash: environment.LAB_VALIDATOR_HASH!,
  };
}

const setupGuard: InlineExtension = {
  name: "routing-lab-auth-guard",
  hidden: true,
  factory: (pi) => {
    pi.on("input", (event, context) => {
      if (/^\/(?:login|logout|quit|exit|help)(?:\s|$)/.test(event.text)) {
        return { action: "continue" };
      }
      context.ui.notify("Authentication setup accepts only /login, /logout, /help, and /quit.", "warning");
      return { action: "handled" };
    });
  },
};

export async function validatePiProfile(authPath: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(authPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Pi credential store is corrupt: ${authPath}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Pi credential store is corrupt: ${authPath}`);
  }
}

export async function createContainerRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  options: ContainerRuntimeOptions = {},
): Promise<ContainerRuntime> {
  const setupStartedAt = performance.now();
  const paths = resolveContainerPaths(environment);
  await Promise.all([
    mkdir(paths.projectAgentDir, { recursive: true }),
    mkdir(paths.sessionDirectory, { recursive: true }),
  ]);
  await validatePiProfile(paths.authPath);
  const modelRuntime = await ModelRuntime.create({
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    allowModelNetwork: false,
  });
  let artifacts: RuntimeArtifactRecorder | null = null;
  let mockAuthReused: boolean | null = null;
  const bufferedAuthEvents: Array<{
    action: "login" | "refresh";
    outcome: "success" | "error";
  }> = [];
  const mockBaseUrl = environment.LAB_MOCK_BASE_URL;
  if (mockBaseUrl) {
    registerMockPiProvider(modelRuntime, "mock", mockBaseUrl, undefined, (event) => {
      if (artifacts) {
        artifacts.recordAuthEvent(event);
      } else {
        bufferedAuthEvents.push(event);
      }
    });
    if (!options.setupMode) {
      mockAuthReused = Boolean(await modelRuntime.checkAuth("mock"));
      if (!mockAuthReused) {
        await modelRuntime.login("mock", "oauth", {
          prompt: async () => "unused",
          notify: () => {},
        });
      }
    }
  }
  const configPath = environment.LAB_CONFIG_PATH;
  let routing: SessionRoutingController | null = null;
  const artifactRecorders = new Map<string, RuntimeArtifactRecorder>();
  const attemptRunIds = new Map<string, string>();
  const attemptCounts = new Map<string, number>();
  const bufferedRoutingEvents: SessionRoutingEvent[] = [];
  let routingConfig: Awaited<ReturnType<typeof loadConfig>> | null = null;
  let routingMode: SessionMode | null = null;
  const baseRunId = environment.LAB_INVOCATION_ID;
  const runIdForSession = (sessionId: string): string => {
    const existing = attemptRunIds.get(sessionId);
    if (existing) return existing;
    if (!baseRunId) throw new Error("LAB_INVOCATION_ID is required for routed Pi sessions");
    const count = (attemptCounts.get(sessionId) ?? 0) + 1;
    attemptCounts.set(sessionId, count);
    const runId =
      attemptRunIds.size === 0
        ? baseRunId
        : `${baseRunId}-${sessionId}${count === 1 ? "" : `-${count}`}`;
    attemptRunIds.set(sessionId, runId);
    return runId;
  };
  if (configPath && !options.setupMode) {
    if (!options.bridge) throw new Error("A Switchyard bridge is required for a routed Pi session");
    const mode = environment.LAB_MODE;
    if (mode !== "weak-only" && mode !== "strong-only" && mode !== "routed") {
      throw new Error("LAB_MODE must be weak-only, strong-only, or routed");
    }
    routingMode = mode;
    const projectId = environment.LAB_PROJECT_ID;
    const runId = environment.LAB_INVOCATION_ID;
    if (!projectId || !runId) {
      throw new Error("LAB_PROJECT_ID and LAB_INVOCATION_ID are required for routed Pi sessions");
    }
    const config = await loadConfig(configPath);
    routingConfig = config;
    routing = new SessionRoutingController({
      config,
      authProfile: paths.authProfile,
      projectId,
      runId,
      runIdForSession,
      stateRoot: paths.projectStateRoot,
      runtime: modelRuntime,
      bridge: options.bridge,
      mode,
      onEvent: (event) => {
        if (artifacts) {
          artifacts.recordRoutingEvent(event);
        } else {
          bufferedRoutingEvents.push(event);
        }
      },
    });
  }
  const selectedProvider = environment.LAB_MODEL_PROVIDER;
  const selectedModelId = environment.LAB_MODEL_ID;
  if (Boolean(selectedProvider) !== Boolean(selectedModelId)) {
    throw new Error("LAB_MODEL_PROVIDER and LAB_MODEL_ID must be provided together");
  }
  const selectedModel =
    selectedProvider && selectedModelId ? modelRuntime.getModel(selectedProvider, selectedModelId) : undefined;
  if (selectedProvider && !selectedModel) {
    throw new Error(`Configured Pi model is unavailable: ${selectedProvider}/${selectedModelId}`);
  }
  const factory: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    if (routing && routingConfig && routingMode) {
      const sessionId = sessionManager.getSessionId();
      const existing = artifactRecorders.get(sessionId);
      if (existing?.isFinalized) attemptRunIds.delete(sessionId);
      artifacts =
        existing && !existing.isFinalized
          ? existing
          : await RuntimeArtifactRecorder.start({
              ...evaluationArtifactContext(environment),
              stateRoot: environment.LAB_ARTIFACT_ROOT ?? paths.projectStateRoot,
              workspace: paths.workspace,
              projectId: environment.LAB_PROJECT_ID!,
              piSessionId: sessionId,
              runId: runIdForSession(sessionId),
              mode: routingMode,
              evidenceKind: environment.LAB_MOCK_BASE_URL ? "mock" : "live",
              authProfile: paths.authProfile,
              config: routingConfig,
              roles: routing.roles,
              fingerprint: routing.fingerprint,
              environment,
              setupDurationMs: Math.max(0, Math.round(performance.now() - setupStartedAt)),
            });
      artifactRecorders.set(sessionId, artifacts);
      for (const event of bufferedAuthEvents.splice(0)) artifacts.recordAuthEvent(event);
      for (const event of bufferedRoutingEvents.splice(0)) artifacts.recordRoutingEvent(event);
    }
    const settingsManager = SettingsManager.create(cwd, agentDir);
    if (routing) settingsManager.setRetryEnabled(false);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      ...(options.setupMode
        ? {
            resourceLoaderOptions: {
              noContextFiles: true,
              extensionFactories: [setupGuard],
            },
          }
        : routing
          ? {
              resourceLoaderOptions: {
                noExtensions: true,
                extensionFactories: [
                  routing.extension(),
                  ...(artifacts ? [artifacts.extension()] : []),
                ],
              },
            }
          : {}),
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(routing
        ? {
            model: routing.roles.strong,
            thinkingLevel: "off" as const,
            scopedModels: [
              { model: routing.roles.classifier, thinkingLevel: "off" as const },
              { model: routing.roles.weak, thinkingLevel: "off" as const },
              { model: routing.roles.strong, thinkingLevel: "off" as const },
            ],
          }
        : selectedModel
          ? { model: selectedModel }
          : {}),
      ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
    });
    routing?.attachSession(created.session);
    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };
  let sessionManager: SessionManager;
  let sessionStartEvent: SessionStartEvent | undefined;
  const resumeSessionId = environment.LAB_RESUME_SESSION_ID;
  if (resumeSessionId) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(resumeSessionId)) {
      throw new Error(
        "Pi session ID must contain only alphanumeric characters, '-', '_', and '.', with alphanumeric boundaries",
      );
    }
    const matches = (await SessionManager.list(paths.workspace, paths.sessionDirectory)).filter(
      (session) => session.id === resumeSessionId,
    );
    if (matches.length > 1) throw new Error(`Multiple Pi sessions matched resume ID ${resumeSessionId}`);
    if (matches[0]) {
      sessionManager = SessionManager.open(matches[0].path, paths.sessionDirectory, paths.workspace);
    } else if (routing && (await routing.store.read(resumeSessionId))) {
      sessionManager = SessionManager.create(paths.workspace, paths.sessionDirectory, {
        id: resumeSessionId,
      });
    } else {
      throw new Error(`Pi session not found for resume ID ${resumeSessionId}`);
    }
    sessionStartEvent = { type: "session_start", reason: "resume" };
  } else {
    sessionManager = SessionManager.create(paths.workspace, paths.sessionDirectory);
  }
  const sessionRuntime = await createAgentSessionRuntime(factory, {
    cwd: paths.workspace,
    agentDir: paths.projectAgentDir,
    sessionManager,
    ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
  });
  const disposeSessionRuntime = sessionRuntime.dispose.bind(sessionRuntime);
  sessionRuntime.dispose = async () => {
    await disposeSessionRuntime();
    for (const recorder of artifactRecorders.values()) await recorder.flush();
  };
  return {
    paths,
    modelRuntime,
    sessionRuntime,
    mockAuthReused,
    routing,
    get artifacts() {
      return artifacts;
    },
  };
}

export async function runContainerInteractiveMode(
  environment: NodeJS.ProcessEnv = process.env,
  initialMessage?: string,
): Promise<void> {
  const paths = resolveContainerPaths(environment);
  const bridge = await SwitchyardBridgeClient.start(paths.bridgeExecutable);
  let runtime: ContainerRuntime | undefined;
  let runError: unknown;
  try {
    runtime = await createContainerRuntime(environment, { bridge });
    process.stdout.write(
      `${JSON.stringify({
        ready: true,
        projectId: environment.LAB_PROJECT_ID,
        invocationId: environment.LAB_INVOCATION_ID,
        sessionId: runtime.sessionRuntime.session.sessionId,
      })}\n`,
    );
    try {
      await new InteractiveMode(runtime.sessionRuntime, {
        ...(initialMessage === undefined ? {} : { initialMessage }),
      }).run();
    } catch (error) {
      runError = error;
    }
    if (runtime.artifacts) {
      await runtime.artifacts.captureWorkspacePatch(runtime.paths.workspace);
      await runtime.artifacts.finalize(runError);
    }
    if (runError !== undefined) throw runError;
  } finally {
    await bridge.dispose();
    await runtime?.sessionRuntime.dispose();
  }
}

export async function runContainerScriptedMode(
  prompt: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = resolveContainerPaths(environment);
  const bridge = await SwitchyardBridgeClient.start(paths.bridgeExecutable);
  let runtime: ContainerRuntime | undefined;
  let runError: unknown;
  try {
    runtime = await createContainerRuntime(environment, { bridge });
    const bindScriptedSession = (session: AgentSessionRuntime["session"]) =>
      session.bindExtensions({
        mode: "json",
        onError: (error) => {
          if (runtime?.routing) runtime.routing.lastError = error.error;
        },
      });
    runtime.sessionRuntime.setRebindSession(bindScriptedSession);
    await bindScriptedSession(runtime.sessionRuntime.session);
    process.stdout.write(
      `${JSON.stringify({
        ready: true,
        projectId: environment.LAB_PROJECT_ID,
        invocationId: environment.LAB_INVOCATION_ID,
        sessionId: runtime.sessionRuntime.session.sessionId,
        mockAuth: runtime.mockAuthReused ? "reused" : "created",
      })}\n`,
    );
    try {
      await runtime.sessionRuntime.session.prompt(prompt);
      if (runtime.routing?.limitError) throw runtime.routing.limitError;
      if (runtime.routing?.lastError) throw new Error(runtime.routing.lastError);
    } catch (error) {
      runError = error;
    }
    const decision = runtime.routing
      ? await runtime.routing.store.read(runtime.sessionRuntime.session.sessionId)
      : null;
    if (decision) process.stdout.write(`${JSON.stringify({ routingDecision: decision })}\n`);
    if (runtime.artifacts) {
      await runtime.artifacts.captureWorkspacePatch(runtime.paths.workspace);
      const result = await runtime.artifacts.finalize(runError);
      process.stdout.write(
        `${JSON.stringify({
          runArtifact: runtime.artifacts.store.directory,
          executionStatus: result.execution.status,
        })}\n`,
      );
    }
    if (runError !== undefined) throw runError;
    const holdSeconds = Number.parseInt(environment.LAB_TEST_HOLD_SECONDS ?? "0", 10);
    if (Number.isFinite(holdSeconds) && holdSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
    }
  } finally {
    await bridge.dispose();
    await runtime?.sessionRuntime.dispose();
  }
}

export async function runContainerAuthMode(
  environment: NodeJS.ProcessEnv = process.env,
  scripted = false,
): Promise<void> {
  const runtime = await createContainerRuntime(environment, { setupMode: true });
  try {
    if (scripted) {
      if (!environment.LAB_MOCK_BASE_URL) throw new Error("Scripted auth is available only to mock tests");
      const reused = Boolean(await runtime.modelRuntime.checkAuth("mock"));
      if (!reused) {
        await runtime.modelRuntime.login("mock", "oauth", {
          prompt: async () => "unused",
          notify: () => {},
        });
      }
      process.stdout.write(`${JSON.stringify({ authReady: true, mockAuth: reused ? "reused" : "created" })}\n`);
      return;
    }
    await new InteractiveMode(runtime.sessionRuntime, { verbose: true }).run();
  } finally {
    await runtime.sessionRuntime.dispose();
  }
}
