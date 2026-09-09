import { writeSync } from "node:fs";
import { tap } from "node:test/reporters";

/** Runs in Node's supervisor, outside the process importing the submission. */
export default async function* reporter(events: Parameters<typeof tap>[0]) {
  let passed = 0;
  let successfulSummary = false;
  async function* observed() {
    for await (const event of events) {
      // Node reports a synthetic file-level PASS at 1:1 after process.exit(0).
      if (event.type === "test:pass" && event.data.line !== undefined &&
          !(event.data.line === 1 && event.data.column === 1) && !event.data.skip && !event.data.todo) passed++;
      if (event.type === "test:summary") successfulSummary = event.data.success === true;
      yield event;
    }
    // This pipe belongs to the supervisor; test workers do not inherit it.
    writeSync(3, JSON.stringify({ completed: successfulSummary && passed > 0, passed }));
  }
  yield* tap(observed());
}
