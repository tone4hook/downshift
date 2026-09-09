export type ExecutionLimitStatus = "timeout" | "budget-exhausted";

/** Keep locally enforced limits distinct from provider errors and user cancellation. */
export class ExecutionLimitError extends Error {
  constructor(readonly status: ExecutionLimitStatus, message: string) {
    super(message);
    this.name = "ExecutionLimitError";
  }
}
