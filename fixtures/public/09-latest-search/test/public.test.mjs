import assert from "node:assert/strict";
import test from "node:test";
import { createSearchController } from "../src/search.ts";

test("publishes a successful search", async () => {
  const states = [];
  const controller = createSearchController(async (query) => [query.toUpperCase()], (state) => {
    states.push(state);
  });
  await controller.search("term");
  assert.deepEqual(states, [{ query: "term", results: ["TERM"], error: null }]);
});
