import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/search.ts`).href;
const { createSearchController } = await import(modulePath);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("ignores stale success after a newer success", async () => {
  const requests = new Map();
  const states = [];
  const controller = createSearchController((query) => {
    const item = deferred();
    requests.set(query, item);
    return item.promise;
  }, (state) => states.push(state));
  const oldSearch = controller.search("old");
  const newSearch = controller.search("new");
  requests.get("new").resolve(["new result"]);
  await newSearch;
  requests.get("old").resolve(["stale result"]);
  await oldSearch;
  assert.deepEqual(states, [{ query: "new", results: ["new result"], error: null }]);
});

test("ignores stale rejection and handles the latest rejection", async () => {
  const requests = [];
  const states = [];
  const controller = createSearchController(() => {
    const item = deferred();
    requests.push(item);
    return item.promise;
  }, (state) => states.push(state));
  const oldSearch = controller.search("old");
  const newSearch = controller.search("new");
  requests[0].reject(new Error("stale"));
  await oldSearch;
  assert.deepEqual(states, []);
  requests[1].reject(new Error("current"));
  await newSearch;
  assert.deepEqual(states, [{ query: "new", results: [], error: "current" }]);
});
