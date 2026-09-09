import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/create.ts`).href;
const { validateCreate } = await import(modulePath);

function expectFields(input, fields) {
  const result = validateCreate(input);
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.errors).sort(), fields.sort());
  for (const messages of Object.values(result.errors)) {
    assert.ok(messages.length > 0);
    assert.ok(messages.every((message) => typeof message === "string" && message.length > 0));
  }
}

test("accumulates title and quantity errors", () => {
  expectFields({ title: "   ", quantity: 0 }, ["quantity", "title"]);
  expectFields({ title: "x".repeat(81), quantity: 101 }, ["quantity", "title"]);
});

test("rejects nonobjects, coercion, and non-finite quantities", () => {
  for (const input of [null, undefined, [], "item"]) {
    expectFields(input, ["quantity", "title"]);
  }
  for (const quantity of ["2", 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expectFields({ title: "valid", quantity }, ["quantity"]);
  }
});

test("normalizes valid data without mutating input", () => {
  const input = { title: "  washers  ", quantity: 100 };
  assert.deepEqual(validateCreate(input), {
    ok: true,
    value: { title: "washers", quantity: 100 },
  });
  assert.deepEqual(input, { title: "  washers  ", quantity: 100 });
});
