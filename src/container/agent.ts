import process from "node:process";
import { SwitchyardBridgeClient } from "../bridge/client.js";
import { assertContainerStateWritable, resolveContainerPaths } from "./paths.js";
import {
  runContainerAuthMode,
  runContainerInteractiveMode,
  runContainerScriptedMode,
  validatePiProfile,
} from "./session-runtime.js";
import {
  probeRouting,
  checkConfig,
  configProfile,
  doctor,
  listModels,
  renderModelCatalog,
} from "./setup-commands.js";

async function checkContainer(): Promise<void> {
  const paths = resolveContainerPaths();
  await assertContainerStateWritable(paths);
  await validatePiProfile(paths.authPath);
  const bridge = await SwitchyardBridgeClient.start(paths.bridgeExecutable);
  await bridge.dispose();
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      role: "agent",
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      authProfile: paths.authProfile,
      bridgeProtocolVersion: 1,
    })}\n`,
  );
}

async function holdBridge(): Promise<void> {
  const paths = resolveContainerPaths();
  await assertContainerStateWritable(paths);
  const bridge = await SwitchyardBridgeClient.start(paths.bridgeExecutable);
  process.stdout.write("bridge-ready\n");
  await new Promise<void>((resolve) => {
    const stop = (signal: NodeJS.Signals) => {
      bridge.process.kill(signal);
      bridge.process.once("exit", () => {
        process.exitCode = signal === "SIGINT" ? 130 : 143;
        resolve();
      });
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
}

const command = process.argv[2] ?? "--check";
if (command === "--check") {
  await checkContainer();
} else if (command === "--bridge-hold") {
  await holdBridge();
} else if (command === "--interactive") {
  const promptIndex = process.argv.indexOf("--prompt");
  const prompt = promptIndex === -1 ? undefined : process.argv[promptIndex + 1];
  if (promptIndex !== -1 && prompt === undefined) throw new Error("--prompt requires one argument");
  await runContainerInteractiveMode(process.env, prompt);
} else if (command === "--scripted") {
  const promptIndex = process.argv.indexOf("--prompt");
  const prompt = promptIndex === -1 ? undefined : process.argv[promptIndex + 1];
  if (prompt === undefined) throw new Error("--scripted requires --prompt");
  await runContainerScriptedMode(prompt);
} else if (command === "--auth") {
  await runContainerAuthMode(process.env, false);
} else if (command === "--auth-test") {
  await runContainerAuthMode(process.env, true);
} else if (command === "--probe-routing") {
  const configIndex = process.argv.indexOf("--config");
  const configPath = process.argv[configIndex + 1];
  if (configIndex < 0 || !configPath) throw new Error("Routing probe requires --config");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { chunks.push(Buffer.from(chunk)); if (chunks.reduce((n,b)=>n+b.length,0)>1048576) throw new Error("Probe plan exceeds 1 MiB"); }
  await probeRouting(configPath, Buffer.concat(chunks).toString("utf8"));
} else if (command === "--config-profile") {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex === -1 ? undefined : process.argv[configIndex + 1];
  if (!configPath) throw new Error("--config-profile requires --config");
  process.stdout.write(`${await configProfile(configPath)}\n`);
} else if (command === "--config-check") {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex === -1 ? undefined : process.argv[configIndex + 1];
  if (!configPath) throw new Error("--config-check requires --config");
  process.stdout.write(`${JSON.stringify(await checkConfig(configPath))}\n`);
} else if (command === "--models") {
  const result = await listModels({ refresh: process.argv.includes("--refresh") });
  process.stdout.write(
    process.argv.includes("--json") ? `${JSON.stringify(result)}\n` : renderModelCatalog(result),
  );
} else if (command === "--doctor") {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex === -1 ? undefined : process.argv[configIndex + 1];
  if (!configPath) throw new Error("--doctor requires --config");
  process.stdout.write(
    `${JSON.stringify(await doctor(configPath, { probeModels: process.argv.includes("--probe-models") }))}\n`,
  );
} else {
  throw new Error(`Unknown agent container command: ${command}`);
}
