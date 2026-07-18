import { createHash } from "node:crypto";
import { z } from "zod";
import type { PlanReadinessDiagnostic } from "../core/execution-spec.js";

const operationSchema = z.object({
  op: z.enum(["add", "replace", "remove"]),
  path: z.string().min(1).max(512),
  value_json: z.string().max(256_000).nullable(),
}).strict();

export const planRepairResponseSchema = z.object({
  schema_version: z.literal("1.0"),
  candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  operations: z.array(operationSchema).min(1).max(64),
}).strict();

export type PlanRepairResponse = z.infer<typeof planRepairResponseSchema>;

export const planRepairResponseOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { type: "string", const: "1.0" },
    candidate_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["add", "replace", "remove"] },
          path: { type: "string", minLength: 1, maxLength: 512 },
          value_json: { anyOf: [{ type: "string", maxLength: 256000 }, { type: "null" }] },
        },
        required: ["op", "path", "value_json"],
      },
    },
  },
  required: ["schema_version", "candidate_sha256", "operations"],
} as const;

const PROTECTED_ROOTS = [
  "/discovery_brief_revision",
  "/discovery_brief_sha256",
  "/assumptions",
  "/accepted_risks",
  "/out_of_scope",
];

export function candidateSha256(candidate: unknown): string {
  return createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
}

function tokens(path: string): string[] {
  if (!path.startsWith("/") || path === "/") throw new Error(`Unsafe plan repair path: ${path}`);
  const result = path.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (result.some((token) => token === "" || token === "__proto__" || token === "prototype" || token === "constructor")) {
    throw new Error(`Unsafe plan repair path: ${path}`);
  }
  if (PROTECTED_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) {
    throw new Error(`Plan repair cannot modify approved discovery field: ${path}`);
  }
  return result;
}

function containerAt(root: unknown, pathTokens: string[]): { parent: Record<string, unknown> | unknown[]; key: string } {
  let current = root;
  for (const token of pathTokens.slice(0, -1)) {
    if (current === null || typeof current !== "object") throw new Error(`Plan repair path does not exist: /${pathTokens.join("/")}`);
    current = (current as Record<string, unknown>)[token];
  }
  if (current === null || typeof current !== "object") throw new Error(`Plan repair parent does not exist: /${pathTokens.join("/")}`);
  return { parent: current as Record<string, unknown> | unknown[], key: pathTokens.at(-1)! };
}

export function applyPlanRepair(candidate: unknown, rawRepair: unknown): unknown {
  const repair = planRepairResponseSchema.parse(rawRepair);
  const expectedSha = candidateSha256(candidate);
  if (repair.candidate_sha256 !== expectedSha) throw new Error("Plan repair candidate SHA-256 is stale");
  const paths = new Set<string>();
  const next = structuredClone(candidate);
  for (const operation of repair.operations) {
    if (paths.has(operation.path)) throw new Error(`Duplicate plan repair path: ${operation.path}`);
    paths.add(operation.path);
    const pathTokens = tokens(operation.path);
    const { parent, key } = containerAt(next, pathTokens);
    const value = operation.value_json === null ? undefined : JSON.parse(operation.value_json) as unknown;
    const isArray = Array.isArray(parent);
    const index = isArray && key !== "-" ? Number(key) : -1;
    if (isArray && key !== "-" && (!Number.isInteger(index) || index < 0)) throw new Error(`Invalid array index in plan repair path: ${operation.path}`);
    if (operation.op === "add") {
      if (isArray) {
        const target = parent as unknown[];
        const insertAt = key === "-" ? target.length : index;
        if (insertAt > target.length) throw new Error(`Plan repair array index is out of bounds: ${operation.path}`);
        target.splice(insertAt, 0, value);
      } else {
        (parent as Record<string, unknown>)[key] = value;
      }
    } else if (operation.op === "replace") {
      if (isArray) {
        const target = parent as unknown[];
        if (index >= target.length) throw new Error(`Plan repair path does not exist: ${operation.path}`);
        target[index] = value;
      } else {
        if (!Object.hasOwn(parent, key)) throw new Error(`Plan repair path does not exist: ${operation.path}`);
        (parent as Record<string, unknown>)[key] = value;
      }
    } else if (isArray) {
      const target = parent as unknown[];
      if (index >= target.length) throw new Error(`Plan repair path does not exist: ${operation.path}`);
      target.splice(index, 1);
    } else {
      if (!Object.hasOwn(parent, key)) throw new Error(`Plan repair path does not exist: ${operation.path}`);
      delete (parent as Record<string, unknown>)[key];
    }
  }
  return next;
}

export function diagnosticFingerprint(diagnostics: readonly PlanReadinessDiagnostic[]): string {
  const canonical = diagnostics.map(({ code, path, message }) => `${code}:${path}:${message}`).sort().join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function isStrictDiagnosticImprovement(
  before: readonly PlanReadinessDiagnostic[],
  after: readonly PlanReadinessDiagnostic[],
): boolean {
  const prior = new Set(before.map(({ code, path, message }) => `${code}:${path}:${message}`));
  const next = new Set(after.map(({ code, path, message }) => `${code}:${path}:${message}`));
  return next.size < prior.size && [...next].every((value) => prior.has(value));
}
