import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/import.ts`).href;
const { importRows } = await import(modulePath);

test("retains valid rows and reports every invalid row stably", () => {
  const rows = [
    { id: "taken", title: "Existing" },
    { id: " good ", title: " Good title " },
    { id: "good", title: "Duplicate" },
    { id: "", title: 42 },
    { id: "bad-title", title: "x".repeat(81) },
    { id: "Case", title: "Upper" },
    { id: "case", title: "Lower" },
  ];
  const existing = new Set(["taken"]);
  const result = importRows(rows, existing);
  assert.deepEqual(result.accepted, [
    { id: "good", title: "Good title" },
    { id: "Case", title: "Upper" },
    { id: "case", title: "Lower" },
  ]);
  assert.deepEqual(result.errors, [
    { row: 0, fields: ["id"] },
    { row: 2, fields: ["id"] },
    { row: 3, fields: ["id", "title"] },
    { row: 4, fields: ["title"] },
  ]);
  assert.deepEqual(rows[1], { id: " good ", title: " Good title " });
  assert.deepEqual([...existing], ["taken"]);
});

test("a rejected row does not reserve its ID", () => {
  assert.deepEqual(importRows([
    { id: "reusable", title: "" },
    { id: "reusable", title: "Valid later row" },
  ], new Set()), {
    accepted: [{ id: "reusable", title: "Valid later row" }],
    errors: [{ row: 0, fields: ["title"] }],
  });
});
