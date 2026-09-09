import process from "node:process";
import { resolve } from "node:path";
import {
  attachValidationResult,
  readAttempt,
  type ExecutionStatus,
} from "../artifacts/run-artifacts.js";
import { loadTaskDefinition, type EvaluationRoots } from "./task.js";
import { exportSubmission, materializeTask } from "./workspace.js";
import { readSubmission, validateSubmission, verifyReference } from "./validator.js";

function roots(): EvaluationRoots {
  return {
    tasksRoot: process.env.LAB_TASKS_ROOT ?? "/evaluation/tasks",
    fixturesRoot: process.env.LAB_FIXTURES_ROOT ?? "/evaluation/fixtures",
    evaluatorRoot: process.env.LAB_EVALUATOR_ROOT ?? "/evaluation/evaluator",
  };
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return resolve(value);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "ready") {
    process.stdout.write('{"ready":true,"role":"evaluator"}\n');
    return;
  }
  const taskId = process.argv[3];
  if (!taskId) throw new Error(`${command ?? "command"} requires a task ID`);
  const task = await loadTaskDefinition(taskId, roots());
  if (command === "materialize") {
    const result = await materializeTask(task, required(process.argv[4], "workspace"));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "export") {
    const result = await exportSubmission(
      task,
      required(process.argv[4], "workspace"),
      required(process.argv[5], "output directory"),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "validate") {
    const submission = await readSubmission(required(process.argv[4], "submission"));
    const attemptDirectory = process.argv[6] ? required(process.argv[6], "attempt directory") : null;
    let executionStatus: ExecutionStatus = "completed";
    if (attemptDirectory) {
      const attempt = await readAttempt(attemptDirectory);
      if (attempt.status !== "finalized" || attempt.result === null) {
        throw new Error("Validation attachment requires a finalized attempt");
      }
      executionStatus = attempt.result.execution.status;
    }
    const result = await validateSubmission(
      task,
      submission,
      required(process.argv[5], "output directory"),
      executionStatus,
    );
    if (attemptDirectory) await attachValidationResult(attemptDirectory, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "pass" ? 0 : result.status === "fail" ? 1 : 3;
    return;
  }
  if (command === "verify-reference") {
    const result = await verifyReference(task, required(process.argv[4], "output directory"));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(`Unknown evaluator command: ${command ?? "<missing>"}`);
}

await main();
