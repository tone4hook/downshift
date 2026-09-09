import { createServer } from "node:http";

const port = Number.parseInt(process.env.MOCK_PORT ?? "8080", 10);
const tokenLifetimeMs = Number.parseInt(process.env.MOCK_CREDENTIAL_LIFETIME_MS ?? "-1", 10);
const refreshDelayMs = Number.parseInt(process.env.MOCK_REFRESH_DELAY_MS ?? "0", 10);
let loginCount = 0;
let refreshCount = 0;
let inferenceCount = 0;
const providerLedger: Array<Record<string, unknown>> = [];
let revoked = false;
const taskId = process.env.MOCK_TASK_ID;

const smokeSolutions: Record<string, { path: string; reference: string; weak?: string }> = {
  "01-null-summary": {
    path: "src/customer.ts",
    reference: `export interface Customer {
  name?: string | null;
}

export function displayName(customer: Customer): string {
  const name = customer.name?.trim();
  return name ? name : "Unknown customer";
}
`,
  },
  "02-create-validation": {
    path: "src/create.ts",
    reference: `export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string[]> };

export interface CreateItem {
  title: string;
  quantity: number;
}

export function validateCreate(input: unknown): ValidationResult<CreateItem> {
  const record =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const quantity = record.quantity;
  const errors: Record<string, string[]> = {};
  if (title.length < 1 || title.length > 80) {
    errors.title = ["Title must contain between 1 and 80 characters."];
  }
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 100
  ) {
    errors.quantity = ["Quantity must be an integer between 1 and 100."];
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, value: { title, quantity: quantity as number } };
}
`,
    weak: `export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string[]> };

export interface CreateItem {
  title: string;
  quantity: number;
}

export function validateCreate(input: unknown): ValidationResult<CreateItem> {
  const value = input as CreateItem;
  const errors: Record<string, string[]> = {};
  if (!value.title) errors.title = ["Title is required."];
  if (!value.quantity || value.quantity < 1 || value.quantity > 100) {
    errors.quantity = ["Quantity must be between 1 and 100."];
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, value: { title: value.title.trim(), quantity: value.quantity } };
}
`,
  },
  "03-stable-filter": {
    path: "src/items.ts",
    reference: `export interface Item {
  id: string;
  title: string;
  status: "active" | "archived";
  quantity: number;
}

export interface ItemQuery {
  text?: string;
  status?: Item["status"];
}

export function filterItems(items: Item[], query: ItemQuery): Item[] {
  const text = query.text?.trim().toLowerCase() ?? "";
  return items.filter(
    (item) =>
      (text.length === 0 || item.title.toLowerCase().includes(text)) &&
      (query.status === undefined || item.status === query.status),
  );
}
`,
  },
  "07-tenant-authorization": {
    path: "src/authorization.ts",
    reference: `export interface User {
  id: string;
  role: "admin" | "member";
  tenantId: string;
}

export interface RecordIdentity {
  ownerId: string;
  tenantId: string;
}

export function canEdit(user: User, record: RecordIdentity): boolean {
  return user.tenantId === record.tenantId &&
    (user.role === "admin" || user.id === record.ownerId);
}
`,
  },
  "08-deduplicate-submit": {
    path: "src/submitter.ts",
    reference: `export type Save = (key: string, value: string) => Promise<string>;

export function createSubmitter(save: Save): {
  submit(key: string, value: string): Promise<string>;
} {
  const pending = new Map<string, Promise<string>>();
  return {
    submit(key, value) {
      const existing = pending.get(key);
      if (existing) return existing;
      const request = save(key, value);
      pending.set(key, request);
      void request.then(
        () => {
          if (pending.get(key) === request) pending.delete(key);
        },
        () => {
          if (pending.get(key) === request) pending.delete(key);
        },
      );
      return request;
    },
  };
}
`,
    weak: `export type Save = (key: string, value: string) => Promise<string>;

export function createSubmitter(save: Save): {
  submit(key: string, value: string): Promise<string>;
} {
  const saved = new Map<string, Promise<string>>();
  return {
    submit(key, value) {
      const existing = saved.get(key);
      if (existing) return existing;
      const request = save(key, value);
      saved.set(key, request);
      return request;
    },
  };
}
`,
  },
  "09-latest-search": {
    path: "src/search.ts",
    reference: `export interface SearchState {
  query: string;
  results: string[];
  error: string | null;
}

export function createSearchController(
  fetchResults: (query: string) => Promise<string[]>,
  publish: (state: SearchState) => void,
): { search(query: string): Promise<void> } {
  let latest = 0;
  return {
    async search(query) {
      const request = ++latest;
      try {
        const results = await fetchResults(query);
        if (request === latest) publish({ query, results, error: null });
      } catch (error) {
        if (request === latest) {
          publish({
            query,
            results: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}
`,
  },
};

function consumeBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function reply(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  if (request.url === "/health") {
    reply(response, 200, { ready: true });
    return;
  }
  if (request.url === "/oauth/login" && request.method === "POST") {
    loginCount++;
    reply(response, 200, {
      access: `mock-access-${loginCount}`,
      refresh: "mock-refresh-1",
      expires: Date.now() + tokenLifetimeMs,
    });
    return;
  }
  if (request.url === "/oauth/refresh" && request.method === "POST") {
    refreshCount++;
    if (refreshDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
    }
    if (revoked) {
      reply(response, 401, { error: "revoked" });
      return;
    }
    reply(response, 200, {
      access: `mock-refreshed-${refreshCount}`,
      refresh: `mock-refresh-${refreshCount + 1}`,
      expires: Date.now() + 600_000,
    });
    return;
  }
  if (request.url === "/infer" && request.method === "POST") {
    if (typeof request.headers["x-api-key"] !== "string") {
      reply(response, 401, { error: "missing auth" });
      return;
    }
    inferenceCount++;
    const body = await consumeBody(request);
    const model = request.headers["x-model-id"];
    const context = JSON.parse(body) as { tools?: unknown[] };
    const responseKind = model === "classifier" || body.includes('"role":"toolResult"') ? "text" : "tool";
    providerLedger.push({ sequence: inferenceCount, model, role: model === "classifier" ? "classifier" : "coding", tools: context.tools?.length ?? 0, response: responseKind, inputTokens: model === "classifier" ? 12 : responseKind === "tool" ? 13 : 8, outputTokens: model === "classifier" ? 8 : responseKind === "tool" ? 9 : 4 });
    const delayMs = Number.parseInt(process.env.MOCK_INFERENCE_DELAY_MS ?? "0", 10);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (model === "classifier") {
      if (taskId === "03-stable-filter") {
        reply(response, 200, {
          type: "text",
          text: "{\"p_solve\":\"invalid\"}",
          inputTokens: 12,
          outputTokens: 8,
        });
        return;
      }
      const probability = taskId === "09-latest-search" ? 0.5 : 0.9;
      reply(response, 200, {
        type: "text",
        text: JSON.stringify({
          crux: "bounded configuration probe",
          primary_rule: "SUP-1",
          capability_boundary: "supported",
          p_solve: probability,
        }),
        inputTokens: 12,
        outputTokens: 8,
      });
      return;
    }
    if (body.includes('"role":"toolResult"')) {
      reply(response, 200, { type: "text", text: "Mock edit complete.", inputTokens: 8, outputTokens: 4 });
    } else {
      const solution = taskId ? smokeSolutions[taskId] : undefined;
      reply(response, 200, {
        type: "tool",
        name: "write",
        arguments: solution
          ? {
              path: solution.path,
              content: model === "weak" && solution.weak ? solution.weak : solution.reference,
            }
          : { path: "mock-edit.txt", content: "mock edit completed\n" },
      });
    }
    return;
  }
  if (request.url === "/admin/revoke" && request.method === "POST") {
    revoked = true;
    reply(response, 200, { revoked: true });
    return;
  }
  if (request.url === "/admin/state") {
    reply(response, 200, { loginCount, refreshCount, inferenceCount, revoked });
    return;
  }
  if (request.url === "/admin/ledger") {
    reply(response, 200, providerLedger);
    return;
  }
  reply(response, 404, { error: "not found" });
});

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(port, "0.0.0.0");
