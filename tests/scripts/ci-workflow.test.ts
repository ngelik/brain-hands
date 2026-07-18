import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  commandStartsWith,
  extractShellCommands,
} from "./shell-command-analysis.js";

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
  name?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
};
type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
};

async function loadWorkflow() {
  const source = await readFile(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  return parseYaml(source) as Workflow;
}

function combinedWorkflowRuns(workflow: Workflow) {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string")
    .join("\n");
}

describe("CI workflow", () => {
  it("collects multiline run text from every workflow job", () => {
    const workflow: Workflow = {
      jobs: {
        quality: { steps: [{ run: "npm test" }] },
        secondary: { steps: [{ run: "npm run release:e2e -- --reporter verbose\nnpm run build" }] },
      },
    };
    expect(combinedWorkflowRuns(workflow)).toContain("npm run release:e2e");
  });

  it("distinguishes executable compound commands from comment and argument spoofing", () => {
    const commands = extractShellCommands(`
      # npm run verify:funnel
      echo "npm run typecheck"
      env CHECK=1 npm run typecheck
      sh -c 'npm run verify:funnel && npm run build'
      printf '%s' "$(npm test)" # npm run build
    `);

    expect(commands.filter((command) => commandStartsWith(command, ["npm", "run", "verify:funnel"])))
      .toHaveLength(1);
    expect(commands.filter((command) => commandStartsWith(command, ["npm", "run", "build"])))
      .toHaveLength(1);
    expect(commands.filter((command) => commandStartsWith(command, ["npm", "run", "typecheck"])))
      .toHaveLength(1);
    expect(commands.filter((command) => commandStartsWith(command, ["npm", "test"])))
      .toHaveLength(1);
  });

  it("runs on main pushes and pull requests with read-only permissions", async () => {
    const workflow = await loadWorkflow();
    expect(workflow.name).toBe("CI");
    expect(workflow.on?.push).toEqual({ branches: ["main"] });
    expect(workflow.on?.pull_request).toEqual({ branches: ["main"] });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs?.quality?.permissions).toEqual({ contents: "read" });
  });

  it("pins GitHub actions and runs the canonical verification funnel once", async () => {
    const workflow = await loadWorkflow();
    const quality = workflow.jobs?.quality;
    expect(quality?.name).toBe("quality");
    expect(quality?.["runs-on"]).toBe("ubuntu-latest");
    expect(quality?.["timeout-minutes"]).toBe(30);

    const checkout = quality?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/u);
    expect(checkout?.with).toMatchObject({ "persist-credentials": false });
    const setupNode = quality?.steps?.find((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(setupNode?.uses).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/u);
    expect(setupNode?.with).toMatchObject({ "node-version": "24", "package-manager-cache": false });

    const steps = quality?.steps ?? [];
    expect(steps.filter((step) => step.run).map(({ name, run }) => ({ name, run }))).toEqual([
      { name: "Verify the release toolchain", run: "node scripts/check-release-toolchain.mjs" },
      { name: "Install dependencies", run: "npm ci --ignore-scripts" },
      { name: "Layered verification funnel", run: "npm run verify:funnel" },
      { name: "Inspect the package artifact", run: "npm pack --dry-run --json --ignore-scripts" },
      { name: "Check patch whitespace", run: "git diff --check" },
    ]);
    const commandEntries = steps.flatMap((step, stepIndex) =>
      extractShellCommands(step.run ?? "").map((command) => ({ command, step, stepIndex })),
    );
    const commands = commandEntries.map(({ command }) => command);
    for (const command of [
      ["node", "scripts/check-release-toolchain.mjs"],
      ["npm", "ci", "--ignore-scripts"],
      ["npm", "run", "verify:funnel"],
      ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
      ["git", "diff", "--check"],
    ]) {
      expect(commands.some((entry) => commandStartsWith(entry, command))).toBe(true);
    }

    const funnelEntries = commandEntries.filter(({ command }) =>
      commandStartsWith(command, ["npm", "run", "verify:funnel"]),
    );
    expect(funnelEntries).toHaveLength(1);
    expect(funnelEntries[0]?.step.name).toBe("Layered verification funnel");
    for (const duplicateGate of [
      ["npm", "test"],
      ["npm", "run", "test"],
      ["npm", "run", "typecheck"],
      ["npm", "run", "build"],
    ]) {
      expect(commands.some((entry) => commandStartsWith(entry, duplicateGate))).toBe(false);
    }

    const packEntries = commandEntries.filter(({ command }) => commandStartsWith(command, ["npm", "pack"]));
    expect(packEntries).toHaveLength(1);
    expect(packEntries[0]?.command.argv).toEqual(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"]);
    const funnelIndex = funnelEntries[0]?.stepIndex ?? -1;
    const packIndex = packEntries[0]?.stepIndex ?? -1;
    const diffIndex = commandEntries.find(({ command }) =>
      commandStartsWith(command, ["git", "diff", "--check"]),
    )?.stepIndex ?? -1;
    expect(packIndex).toBeGreaterThan(funnelIndex);
    expect(diffIndex).toBeGreaterThan(packIndex);
    expect(combinedWorkflowRuns(workflow)).not.toContain("npm run release:e2e");
  });
});
