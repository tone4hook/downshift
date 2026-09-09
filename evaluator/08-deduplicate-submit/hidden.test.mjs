import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/submitter.ts`).href;
const { createSubmitter } = await import(modulePath);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("coalesces only concurrent work by key", async () => {
  const pending = [];
  const calls = [];
  const submitter = createSubmitter((key, value) => {
    calls.push([key, value]);
    const item = deferred();
    pending.push(item);
    return item.promise;
  });
  const first = submitter.submit("a", "first");
  const duplicate = submitter.submit("a", "ignored");
  const other = submitter.submit("b", "other");
  assert.equal(first, duplicate);
  assert.notEqual(first, other);
  assert.deepEqual(calls, [["a", "first"], ["b", "other"]]);
  pending[0].resolve("saved-a");
  pending[1].resolve("saved-b");
  assert.deepEqual(await Promise.all([first, duplicate, other]), ["saved-a", "saved-a", "saved-b"]);
  const next = submitter.submit("a", "next");
  assert.equal(calls.length, 3);
  pending[2].resolve("saved-next");
  assert.equal(await next, "saved-next");
});

test("rejection releases only the rejected key", async () => {
  const attempts = [];
  const submitter = createSubmitter(() => {
    const item = deferred();
    attempts.push(item);
    return item.promise;
  });
  const failed = submitter.submit("a", "first");
  attempts[0].reject(new Error("save failed"));
  await assert.rejects(failed, /save failed/);
  const retry = submitter.submit("a", "second");
  assert.equal(attempts.length, 2);
  attempts[1].resolve("saved");
  assert.equal(await retry, "saved");
});
