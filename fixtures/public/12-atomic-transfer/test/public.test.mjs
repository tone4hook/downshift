import assert from "node:assert/strict";
import test from "node:test";
import { transfer } from "../src/transfer.ts";

test("moves funds between existing accounts", async () => {
  const balances = new Map([["a", 100], ["b", 20]]);
  const repo = {
    getBalance: async (id) => balances.get(id) ?? null,
    setBalance: async (id, value) => { balances.set(id, value); },
    transaction: async (work) => work(repo),
  };
  await transfer(repo, "a", "b", 30);
  assert.deepEqual([...balances], [["a", 70], ["b", 50]]);
});
