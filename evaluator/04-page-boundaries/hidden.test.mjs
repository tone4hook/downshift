import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

const modulePath = pathToFileURL(`${process.env.LAB_SUBMISSION_ROOT}/src/paginate.ts`).href;
const { paginate } = await import(modulePath);

test("handles rounded, empty, and past-end boundaries", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2, 2), {
    items: [3, 4],
    total: 5,
    pageCount: 3,
  });
  assert.deepEqual(paginate([1, 2, 3], 4, 2), {
    items: [],
    total: 3,
    pageCount: 2,
  });
  assert.deepEqual(paginate([], 1, 10), {
    items: [],
    total: 0,
    pageCount: 0,
  });
});

test("rejects non-positive and non-integer boundaries", () => {
  for (const [page, pageSize] of [[0, 1], [-1, 1], [1.5, 1], [1, 0], [1, -1], [1, 2.5]]) {
    assert.throws(() => paginate([1, 2], page, pageSize), RangeError);
  }
});

test("preserves input order and identity", () => {
  const first = { id: "first" };
  const second = { id: "second" };
  const rows = [first, second];
  assert.deepEqual(paginate(rows, 1, 3).items, [first, second]);
  assert.deepEqual(rows, [first, second]);
});
