import assert from "node:assert/strict";
import test from "node:test";
import { createSubmitter } from "../src/submitter.ts";

test("forwards a submission result", async () => {
  const submitter = createSubmitter(async (key, value) => `${key}:${value}`);
  assert.equal(await submitter.submit("a", "first"), "a:first");
});
