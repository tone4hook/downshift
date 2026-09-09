import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
export { registerMockPiProvider, type ScriptedResponse } from "../../src/pi/mock-provider.js";
import type { ScriptedResponse } from "../../src/pi/mock-provider.js";

interface ServerState {
  loginCount: number;
  refreshCount: number;
  inferenceModels: string[];
  inferenceToolCounts: number[];
  inferenceBodies: string[];
  issuedAccessTokens: string[];
  revoked: boolean;
}

export interface MockPiServer {
  baseUrl: string;
  state: ServerState;
  enqueue(...responses: ScriptedResponse[]): void;
  revoke(): void;
  close(): Promise<void>;
}

function consumeBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export async function startMockPiServer(
  options: { tokenLifetimeMs?: number; inferenceDelayMs?: number } = {},
): Promise<MockPiServer> {
  const queue: ScriptedResponse[] = [];
  const state: ServerState = {
    loginCount: 0,
    refreshCount: 0,
    inferenceModels: [],
    inferenceToolCounts: [],
    inferenceBodies: [],
    issuedAccessTokens: [],
    revoked: false,
  };
  const tokenLifetimeMs = options.tokenLifetimeMs ?? 60_000;
  const server: Server = createServer(async (request, response) => {
    const requestBody = await consumeBody(request);
    response.setHeader("content-type", "application/json");
    if (request.url === "/oauth/login" && request.method === "POST") {
      state.loginCount++;
      const access = `access-${state.loginCount}`;
      state.issuedAccessTokens.push(access);
      response.end(JSON.stringify({ access, refresh: "refresh-1", expires: Date.now() + tokenLifetimeMs }));
      return;
    }
    if (request.url === "/oauth/refresh" && request.method === "POST") {
      state.refreshCount++;
      if (state.revoked) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "revoked" }));
        return;
      }
      const access = `refreshed-${state.refreshCount}`;
      state.issuedAccessTokens.push(access);
      response.end(
        JSON.stringify({
          access,
          refresh: `refresh-${state.refreshCount + 1}`,
          expires: Date.now() + 10 * 60_000,
        }),
      );
      return;
    }
    if (request.url === "/infer" && request.method === "POST") {
      if (options.inferenceDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.inferenceDelayMs));
      }
      if (state.revoked) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "revoked credentials" }));
        return;
      }
      if (typeof request.headers["x-api-key"] !== "string") {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "missing auth" }));
        return;
      }
      const script = queue.shift();
      if (!script) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "no scripted response" }));
        return;
      }
      const model = request.headers["x-model-id"];
      state.inferenceModels.push(typeof model === "string" ? model : "");
      state.inferenceBodies.push(requestBody.toString("utf8"));
      const payload = JSON.parse(requestBody.toString("utf8")) as { tools?: unknown[] };
      state.inferenceToolCounts.push(payload.tools?.length ?? 0);
      if (script.type === "error") {
        response.statusCode = script.status;
        response.end(JSON.stringify({ error: script.message }));
        return;
      }
      response.end(JSON.stringify(script));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    enqueue: (...responses) => queue.push(...responses),
    revoke: () => {
      state.revoked = true;
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
