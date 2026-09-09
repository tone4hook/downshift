import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeProtocolError, SwitchyardBridgeClient } from "../../src/bridge/client.js";

const executable = resolve("rust/switchyard-bridge/target/debug/switchyard-bridge");
const clients: SwitchyardBridgeClient[] = [];

function verdict(pSolve: number): string {
  return JSON.stringify({
    crux: "bounded task",
    primary_rule: "SUP-1",
    capability_boundary: "supported",
    p_solve: pSolve,
  });
}

async function client(): Promise<SwitchyardBridgeClient> {
  const value = await SwitchyardBridgeClient.start(executable);
  clients.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.dispose()));
});

describe("Switchyard stdio bridge", () => {
  it.each(["duplicate", "missing-id", "invalid-request", "invalid-decision"])("rejects malformed bridge protocol: %s", async (scenario) => {
    const root = await mkdtemp("/tmp/routing-bridge-regression-");
    const path = resolve(root, "bridge");
    await writeFile(path, `#!/usr/bin/env node
const emit = value => console.log(JSON.stringify(value));
emit({type:'ready',protocolVersion:1});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 if(frame.type!=='start') return;
 const call={type:'call_model',decisionId:frame.decisionId,callId:'same',targetAlias:'classifier',request:{messages:[]}};
 if(${JSON.stringify(scenario)}==='missing-id') delete call.decisionId;
 if(${JSON.stringify(scenario)}==='invalid-request') call.request.messages=null;
 emit(call);
 if(${JSON.stringify(scenario)}==='duplicate') emit(call);
 emit({type:'decision',decisionId:frame.decisionId,selectedAlias:'outside',evidence:{kind:'validated_verdict',weakSolveProbability:4}});
});`, { mode: 0o700 });
    const bridge = await SwitchyardBridgeClient.start(path);
    let calls = 0;
    try {
      await expect(bridge.resolveDecision({ decisionId: "protocol-test", task: "task", weakThreshold: 0.75,
        maxOutputTokens: 100, callClassifier: async () => { calls++; return { text: verdict(0.9) }; } }))
        .rejects.toThrow(/invalid|duplicate/);
      expect(calls).toBe(scenario === "missing-id" || scenario === "invalid-request" ? 0 : 1);
    } finally { await bridge.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it.each([
    [0.749, "strong"],
    [0.75, "weak"],
    [0.751, "weak"],
  ] as const)("keeps thresholding inside Switchyard for p=%s", async (pSolve, selectedAlias) => {
    const bridge = await client();
    let calls = 0;
    const decision = await bridge.resolveDecision({
      decisionId: `decision-${pSolve}`,
      task: "Edit a TypeScript file.",
      weakThreshold: 0.75,
      maxOutputTokens: 512,
      callClassifier: async (request) => {
        calls++;
        expect(request.targetAlias).toBe("classifier");
        expect(request.request.output?.response_format).toBeDefined();
        return { text: verdict(pSolve), usage: { inputTokens: 10, outputTokens: 5 } };
      },
    });
    expect(calls).toBe(1);
    expect(decision).toEqual({
      decisionId: `decision-${pSolve}`,
      selectedAlias,
      evidence: { kind: "validated_verdict", weakSolveProbability: pSolve },
    });
  });

  it.each(["not json", verdict(Number.NaN), '{"p_solve":0.9}'])(
    "uses only Switchyard's bounded invalid-verdict fallback",
    async (reply) => {
      const bridge = await client();
      const decision = await bridge.resolveDecision({
        decisionId: "fallback",
        task: "Edit a TypeScript file.",
        weakThreshold: 0.75,
        maxOutputTokens: 512,
        callClassifier: async () => ({ text: reply }),
      });
      expect(decision.selectedAlias).toBe("strong");
      expect(decision.evidence).toEqual({ kind: "fallback", reason: "invalid_verdict" });
    },
  );

  it.each(["auth", "provider", "transport", "quota"] as const)(
    "keeps %s failures out of classifier fallback",
    async (kind) => {
      const bridge = await client();
      await expect(
        bridge.resolveDecision({
          decisionId: `error-${kind}`,
          task: "Edit a TypeScript file.",
          weakThreshold: 0.75,
          maxOutputTokens: 512,
          callClassifier: async () => ({ error: { kind, message: `${kind} failed` } }),
        }),
      ).rejects.toThrow(BridgeProtocolError);
    },
  );

  it("rejects mismatched response identifiers", async () => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    const lines: string[] = [];
    child.stdout.on("data", (chunk: string) => lines.push(...chunk.trim().split("\n")));
    await new Promise((resolveReady) => child.stdout.once("data", resolveReady));
    child.stdin.write(
      `${JSON.stringify({
        type: "start",
        protocolVersion: 1,
        decisionId: "expected",
        task: "task",
        policy: { weakThreshold: 0.75, maxOutputTokens: 512 },
        targetAliases: { classifier: "classifier", weak: "weak", strong: "strong" },
      })}\n`,
    );
    await new Promise((resolveCall) => child.stdout.once("data", resolveCall));
    child.stdin.write(
      `${JSON.stringify({
        type: "model_result",
        decisionId: "wrong",
        callId: "call-1",
        response: { text: verdict(0.9) },
      })}\n`,
    );
    await new Promise((resolveError) => child.stdout.once("data", resolveError));
    expect(lines.join("\n")).toContain("mismatched bridge frame");
    child.kill("SIGTERM");
    await once(child, "exit");
  });

  it("cancels an active decision without selecting a tier", async () => {
    const bridge = await client();
    const controller = new AbortController();
    const decision = bridge.resolveDecision({
      decisionId: "cancelled",
      task: "task",
      weakThreshold: 0.75,
      maxOutputTokens: 512,
      signal: controller.signal,
      callClassifier: async () => {
        controller.abort();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        return { text: verdict(0.9) };
      },
    });
    await expect(decision).rejects.toThrow(/cancelled/);
  });

  it("keeps identical tasks in distinct decision identities", async () => {
    const bridge = await client();
    const decide = (decisionId: string) =>
      bridge.resolveDecision({
        decisionId,
        task: "same task",
        weakThreshold: 0.75,
        maxOutputTokens: 512,
        callClassifier: async () => ({ text: verdict(0.9) }),
      });
    await expect(decide("session-a")).resolves.toMatchObject({ decisionId: "session-a" });
    await expect(decide("session-b")).resolves.toMatchObject({ decisionId: "session-b" });
  });

  it("does not inherit credential or provider environment into the bridge", async () => {
    const sentinel = "phase01-secret-sentinel";
    const bridge = await SwitchyardBridgeClient.start(executable, {
      env: {
        ...process.env,
        PI_AUTH_TOKEN: sentinel,
        PROVIDER_BASE_URL: `https://${sentinel}.invalid`,
      },
    });
    clients.push(bridge);
    await bridge.resolveDecision({
      decisionId: "redaction",
      task: "task",
      weakThreshold: 0.75,
      maxOutputTokens: 512,
      callClassifier: async (frame) => {
        expect(JSON.stringify(frame)).not.toContain(sentinel);
        return { text: verdict(0.9) };
      },
    });
  });

  it("surfaces a child crash instead of manufacturing a decision", async () => {
    const bridge = await client();
    const result = bridge.resolveDecision({
      decisionId: "crash",
      task: "task",
      weakThreshold: 0.75,
      maxOutputTokens: 512,
      callClassifier: async () => {
        bridge.process.kill("SIGKILL");
        return { text: verdict(0.9) };
      },
    });
    await expect(result).rejects.toThrow(/exited|backpressure|write/i);
  });
});
