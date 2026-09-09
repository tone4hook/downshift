import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerMockPiProvider } from "./mock-pi-provider.js";

const [authPath, baseUrl] = process.argv.slice(2);
if (!authPath || !baseUrl) throw new Error("auth worker requires auth path and base URL");
const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
registerMockPiProvider(runtime, "mock", baseUrl);
const auth = await runtime.getAuth("mock", { minOAuthValidityMs: 1 });
if (!auth?.auth.apiKey) throw new Error("worker did not resolve auth");
process.stdout.write(`${auth.auth.apiKey}\n`);
