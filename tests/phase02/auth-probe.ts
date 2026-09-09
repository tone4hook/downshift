import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerMockPiProvider } from "../phase01/mock-pi-provider.js";

const mode = process.argv[2];
const baseUrl = process.env.MOCK_BASE_URL;
const authPath = process.env.PI_AUTH_PATH ?? "/pi-profile/auth.json";
if (!mode || !baseUrl) throw new Error("auth probe requires a mode and MOCK_BASE_URL");

const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
registerMockPiProvider(runtime, "mock", baseUrl);

if (mode === "login") {
  await runtime.login("mock", "oauth", { prompt: async () => "unused", notify: () => {} });
  process.stdout.write("login-persisted\n");
} else if (mode === "check") {
  if (!(await runtime.checkAuth("mock"))) throw new Error("mock login was not persisted");
  process.stdout.write("login-present\n");
} else if (mode === "refresh") {
  const auth = await runtime.getAuth("mock", { minOAuthValidityMs: 1 });
  if (!auth) throw new Error("mock auth unavailable");
  process.stdout.write("refresh-complete\n");
} else if (mode === "logout") {
  await runtime.logout("mock");
  process.stdout.write("logout-complete\n");
} else if (mode === "check-absent") {
  if (await runtime.checkAuth("mock")) throw new Error("mock login remained after logout");
  process.stdout.write("login-absent\n");
} else if (mode === "cancel-refresh") {
  const controller = new AbortController();
  const refresh = runtime.getAuth("mock", { minOAuthValidityMs: 1, signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  await refresh;
  throw new Error("cancelled refresh unexpectedly completed");
} else {
  throw new Error(`unknown auth probe mode: ${mode}`);
}
