import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/transfer.ts`).href;
const { transfer } = await import(modulePath);

function repository(initial, failOnSecondWrite = false) {
  const balances = new Map(Object.entries(initial));
  let transactions = 0;
  return {
    balances,
    repo: {
      async getBalance(id) {
        return balances.get(id) ?? null;
      },
      async setBalance(id, cents) {
        balances.set(id, cents);
      },
      async transaction(work) {
        transactions++;
        const draft = new Map(balances);
        let writes = 0;
        const view = {
          async getBalance(id) {
            return draft.get(id) ?? null;
          },
          async setBalance(id, cents) {
            writes++;
            if (failOnSecondWrite && writes === 2) throw new Error("storage failed");
            draft.set(id, cents);
          },
        };
        const result = await work(view);
        balances.clear();
        for (const entry of draft) balances.set(...entry);
        return result;
      },
    },
    transactionCount: () => transactions,
  };
}

test("uses one transaction and conserves the total", async () => {
  const state = repository({ a: 100, b: 25 });
  await transfer(state.repo, "a", "b", 40);
  assert.equal(state.transactionCount(), 1);
  assert.deepEqual([...state.balances], [["a", 60], ["b", 65]]);
});

test("rolls back when the second write fails", async () => {
  const state = repository({ a: 100, b: 25 }, true);
  await assert.rejects(transfer(state.repo, "a", "b", 40), /storage failed/);
  assert.equal(state.transactionCount(), 1);
  assert.deepEqual([...state.balances], [["a", 100], ["b", 25]]);
});

test("validates with stable codes in the required order", async () => {
  const cases = [
    { args: ["missing", "missing", 0], code: "INVALID_AMOUNT" },
    { args: ["a", "a", 1], code: "SAME_ACCOUNT" },
    { args: ["a", "missing", 1], code: "NOT_FOUND" },
    { args: ["a", "b", 101], code: "INSUFFICIENT_FUNDS" },
  ];
  for (const { args, code } of cases) {
    const state = repository({ a: 100, b: 25 });
    await assert.rejects(transfer(state.repo, ...args), (error) => error.message === code);
    assert.deepEqual([...state.balances], [["a", 100], ["b", 25]]);
  }
  const state = repository({ a: 10, b: Number.MAX_SAFE_INTEGER });
  await assert.rejects(
    transfer(state.repo, "a", "b", 1),
    (error) => error.message === "INVALID_AMOUNT",
  );
});
