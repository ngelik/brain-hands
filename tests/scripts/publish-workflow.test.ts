import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  commandStartsWith,
  extractShellCommands,
} from "./shell-command-analysis.js";

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  needs?: string;
  if?: string;
  environment?: string;
  "runs-on"?: string;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
};

type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
};

const workflowPath = join(process.cwd(), ".github", "workflows", "publish-npm.yml");

const boundedReleaseRun = `npm run typecheck
npm run build
npm run validate-release
npx vitest run tests/core/schema.test.ts tests/core/execution-spec.test.ts tests/core/testing-funnel.test.ts tests/prompts/renderer.test.ts tests/workflow/replan.test.ts tests/workflow/fix-packet-resolution.test.ts tests/workflow/recovery-runtime.test.ts tests/workflow/review-normalizer.test.ts tests/workflow/role-context.test.ts tests/verification/runner.test.ts tests/cli-smoke.test.ts tests/browser/network-pattern.test.ts
`;

const immutableContextRun = `set -euo pipefail
release_sha="$(git rev-parse "refs/tags/$RELEASE_TAG^{}")"
test "$(git rev-parse HEAD)" = "$release_sha"
test "$(git cat-file -t "refs/tags/$RELEASE_TAG")" = "tag"
if [[ "$GITHUB_EVENT_NAME" == "push" ]]; then
  test "$GITHUB_REF_TYPE" = "tag"
  test "$release_sha" = "$GITHUB_SHA"
  test "$(git rev-parse refs/remotes/origin/main)" = "$release_sha"
else
  git merge-base --is-ancestor "$release_sha" refs/remotes/origin/main
fi
npm run validate-release -- --json --tag "$RELEASE_TAG" --repository "$GITHUB_REPOSITORY"
`;

async function loadWorkflow() {
  const source = await readFile(workflowPath, "utf8");
  return { source, workflow: parseYaml(source) as Workflow };
}

function executableCommands(job: WorkflowJob | undefined) {
  return (job?.steps ?? []).flatMap((step, stepIndex) =>
    extractShellCommands(step.run ?? "").map((command) => ({ command, step, stepIndex })),
  );
}

function combinedRuns(job: WorkflowJob | undefined) {
  return executableCommands(job).map(({ command }) => command.raw).join("\n");
}

function combinedWorkflowRuns(workflow: Workflow) {
  return Object.values(workflow.jobs ?? {}).map((job) => combinedRuns(job)).join("\n");
}

function actionStep(job: WorkflowJob | undefined, action: string) {
  return job?.steps?.find((step) => step.uses?.startsWith(`${action}@`));
}

describe("npm publish workflow", () => {
  it("collects multiline run text from every workflow job", () => {
    const workflow: Workflow = {
      jobs: {
        validate: { steps: [{ run: "npm test" }] },
        publish: { steps: [{ run: "npm run release:e2e -- --reporter verbose\nnpm publish" }] },
      },
    };
    expect(combinedWorkflowRuns(workflow)).toContain("npm run release:e2e");
  });

  it("uses stable-tag and manual validation triggers with serialized releases", async () => {
    const { workflow } = await loadWorkflow();
    expect(workflow.name).toBe("Publish npm package");
    expect(workflow.on?.push).toEqual({ tags: ["v*"] });
    expect(workflow.on?.workflow_dispatch).toEqual({ inputs: {
      release_tag: {
        description: "Existing annotated release tag to retry",
        required: true,
        type: "string",
      },
    } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "npm-publish-${{ github.repository }}",
      "cancel-in-progress": false,
    });
  });

  it("pins the runner and release actions while disabling dependency caching", async () => {
    const { workflow } = await loadWorkflow();
    for (const job of Object.values(workflow.jobs ?? {})) {
      expect(job["runs-on"]).toBe("ubuntu-latest");
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
      expect(actionStep(job, "actions/checkout")?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/u);
      const setupNode = actionStep(job, "actions/setup-node");
      expect(setupNode?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/u);
      expect(setupNode?.with).toMatchObject({
        "node-version": "24",
        "registry-url": "https://registry.npmjs.org",
        "package-manager-cache": false,
      });
    }
  });

  it("runs one bounded release gate, inspects its package, and validates immutable tag context", async () => {
    const { workflow } = await loadWorkflow();
    const validate = workflow.jobs?.validate;
    expect(validate?.["timeout-minutes"]).toBeGreaterThanOrEqual(180);
    expect(validate?.permissions).toEqual({ contents: "read" });
    expect(validate?.steps?.filter((step) => step.run).map(({ name, run }) => ({ name, run }))).toEqual([
      { name: "Verify the trusted-publishing toolchain", run: "node scripts/check-release-toolchain.mjs" },
      { name: "Install dependencies", run: "npm ci --ignore-scripts" },
      { name: "Bounded release verification", run: boundedReleaseRun },
      { name: "Validate immutable release context", run: immutableContextRun },
      { name: "Inspect the package artifact", run: "npm pack --dry-run --json --ignore-scripts" },
    ]);
    const runs = combinedRuns(validate);
    for (const required of [
      "node scripts/check-release-toolchain.mjs",
      "npm ci --ignore-scripts",
      "npm run typecheck",
      "npm run build",
      "npm run validate-release",
      "npm pack --dry-run --json --ignore-scripts",
      "npm run validate-release -- --json",
      "git cat-file -t",
      "git rev-parse refs/remotes/origin/main",
    ]) {
      expect(runs).toContain(required);
    }
    expect(combinedWorkflowRuns(workflow)).not.toContain("npm run release:e2e");
    expect(runs).not.toContain("git fetch");
    expect(runs).toContain("$GITHUB_EVENT_NAME");
    expect(runs).toContain("$RELEASE_TAG");
    expect(runs).toContain("$GITHUB_REPOSITORY");

    const commands = executableCommands(validate);
    const funnels = commands.filter(({ command }) =>
      commandStartsWith(command, ["npx", "vitest", "run"]),
    );
    expect(funnels).toHaveLength(1);
    expect(funnels[0]?.step.name).toBe("Bounded release verification");
    for (const duplicateGate of [
      ["npm", "test"],
      ["npm", "run", "test"],
      ["npm", "run", "test:cross-cutting"],
      ["npm", "run", "test:all:no-build"],
    ]) {
      expect(commands.some(({ command }) => commandStartsWith(command, duplicateGate))).toBe(false);
    }

    const steps = validate?.steps ?? [];
    const funnelIndex = funnels[0]?.stepIndex ?? -1;
    const immutableContextIndex = steps.findIndex(
      (step) => step.name === "Validate immutable release context",
    );
    const packs = commands.filter(({ command }) => commandStartsWith(command, ["npm", "pack"]));
    expect(packs).toHaveLength(1);
    expect(packs[0]?.command.argv).toEqual(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"]);
    const packIndex = packs[0]?.stepIndex ?? -1;
    expect(funnelIndex).toBeGreaterThanOrEqual(0);
    expect(immutableContextIndex).toBeGreaterThan(funnelIndex);
    expect(packIndex).toBeGreaterThan(immutableContextIndex);

    const executable = commands.map(({ command }) => command.raw);
    for (const check of [
      'test "$(git rev-parse HEAD)" = "$release_sha"',
      'test "$GITHUB_REF_TYPE" = "tag"',
      'test "$(git cat-file -t "refs/tags/$RELEASE_TAG")" = "tag"',
      'test "$release_sha" = "$GITHUB_SHA"',
      'test "$(git rev-parse refs/remotes/origin/main)" = "$release_sha"',
      'git merge-base --is-ancestor "$release_sha" refs/remotes/origin/main',
    ]) {
      expect(executable).toContain(check);
    }
    expect(commands.filter(({ command }) =>
      commandStartsWith(command, ["npm", "run", "validate-release"])).map(({ command }) => command.argv))
      .toEqual([
        ["npm", "run", "validate-release"],
        [
          "npm", "run", "validate-release", "--", "--json", "--tag",
          "$RELEASE_TAG", "--repository", "$GITHUB_REPOSITORY",
        ],
      ]);
  });

  it("grants OIDC only to the tag-only environment-gated publish job", async () => {
    const { workflow } = await loadWorkflow();
    const publish = workflow.jobs?.publish;
    expect(publish?.needs).toBe("validate");
    expect(publish?.if).toBe("github.event_name == 'push' || inputs.release_tag != ''");
    expect(publish?.environment).toBe("npm-publish");
    expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(publish?.steps?.filter((step) => step.run).map(({ name, run }) => ({ name, run }))).toEqual([
      { name: "Verify the trusted-publishing toolchain", run: "node scripts/check-release-toolchain.mjs" },
      { name: "Install dependencies", run: "npm ci --ignore-scripts" },
      { name: "Build release files", run: "npm run build" },
      {
        name: "Revalidate the publish context",
        run: 'npm run validate-release -- --json --tag "$RELEASE_TAG" --repository "$GITHUB_REPOSITORY"',
      },
      {
        name: "Publish and verify the exact artifact",
        run: 'node scripts/publish-release.mjs --tag "$RELEASE_TAG" --commit "$(git rev-parse HEAD)" --repository "$GITHUB_REPOSITORY"',
      },
    ]);
    const commands = executableCommands(publish);
    expect(commands.some(({ command }) =>
      commandStartsWith(command, ["npm", "run", "verify:funnel"]))).toBe(false);
    const build = commands.filter(({ command }) => commandStartsWith(command, ["npm", "run", "build"]));
    const validate = commands.filter(({ command }) => commandStartsWith(command, ["npm", "run", "validate-release"]));
    const publishRelease = commands.filter(({ command }) =>
      commandStartsWith(command, ["node", "scripts/publish-release.mjs"]),
    );
    expect(build).toHaveLength(1);
    expect(validate).toHaveLength(1);
    expect(publishRelease).toHaveLength(1);
    expect(validate[0]!.command.argv).toEqual([
      "npm", "run", "validate-release", "--", "--json", "--tag",
      "$RELEASE_TAG", "--repository", "$GITHUB_REPOSITORY",
    ]);
    expect(publishRelease[0]!.command.argv).toEqual([
      "node", "scripts/publish-release.mjs", "--tag", "$RELEASE_TAG",
      "--commit", "$(git rev-parse HEAD)", "--repository", "$GITHUB_REPOSITORY",
    ]);
    expect(build[0]!.stepIndex).toBeLessThan(validate[0]!.stepIndex);
    expect(validate[0]!.stepIndex).toBeLessThan(publishRelease[0]!.stepIndex);
    expect(Object.entries(workflow.jobs ?? {}).filter(([, job]) => job.permissions?.["id-token"] === "write"))
      .toHaveLength(1);

    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.prepack).toBe("npm run build && npm run validate-release");
  });

  it("contains no long-lived npm credential, OTP, or catalog credential path", async () => {
    const { source } = await loadWorkflow();
    expect(source).not.toMatch(/secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN|--otp|npm\s+(login|whoami)|VERCEL_OIDC_TOKEN|skills\.sh/i);
    expect(source).not.toContain("npm publish");
  });
});
