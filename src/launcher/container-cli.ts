import process from "node:process";
import { randomUUID } from "node:crypto";
import AjvModule from "ajv";
import { dependencyState, identifyProject, prepareProject } from "./project.js";

interface ProjectIdentity {
  projectId: string;
  invocationId: string;
}

const ajv = new AjvModule.default({ allErrors: true, strict: true });
const identitySchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId", "invocationId"],
  properties: {
    projectId: { type: "string", pattern: "^[0-9a-f]{64}$" },
    invocationId: {
      type: "string",
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    },
  },
} as const;
const projectPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["projectId", "packageManager", "declaredPackageManager", "lockfile", "lockHash"],
  properties: {
    projectId: { type: "string", pattern: "^[0-9a-f]{64}$" },
    packageManager: { type: "string", enum: ["npm", "pnpm"] },
    declaredPackageManager: { type: ["string", "null"] },
    lockfile: { type: "string", enum: ["package-lock.json", "pnpm-lock.yaml"] },
    lockHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;
const validateIdentity = ajv.compile(identitySchema);
const validateProjectPlan = ajv.compile(projectPlanSchema);

function assertValid<T>(
  validate: ((value: unknown) => boolean) & { errors?: Parameters<typeof ajv.errorsText>[0] },
  value: T,
  label: string,
): void {
  if (!validate(value)) {
    throw new Error(`${label} failed schema validation: ${ajv.errorsText(validate.errors)}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "identify") {
    const canonicalPath = process.argv[3];
    if (!canonicalPath) throw new Error("identify requires a canonical host project path");
    const identity = identifyProject(canonicalPath);
    assertValid(validateIdentity, identity, "Project identity");
    process.stdout.write(`project-id:${identity.projectId}\ninvocation-id:${identity.invocationId}\n`);
    return;
  }
  if (command === "invocation") {
    process.stdout.write(`invocation-id:${randomUUID()}\n`);
    return;
  }
  if (command === "prepare") {
    const workspace = process.env.LAB_WORKSPACE ?? "/workspace";
    const dependencyDirectory = `${workspace}/node_modules`;
    const plan = await prepareProject(workspace, dependencyDirectory);
    assertValid(validateProjectPlan, plan, "Project plan");
    process.stdout.write(`${JSON.stringify({ ready: true, ...plan })}\n`);
    return;
  }
  if (command === "dependency-state") {
    process.stdout.write(await dependencyState(process.env.LAB_DEPENDENCY_DIRECTORY ?? "/workspace/node_modules"));
    return;
  }
  throw new Error(`Unknown launcher helper command: ${command ?? "<missing>"}`);
}

await main();
