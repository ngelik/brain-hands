import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseStableVersion } from "../.agents/skills/brain-hands/scripts/version-compatibility.mjs";

const root = process.cwd();
const skillRoot = join(root, ".agents", "skills", "brain-hands");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownSection(document: string, heading: string): string {
  document = document.replace(/<!--[\s\S]*?-->/g, "");
  const headingPattern = new RegExp(
    `^(#{1,6})[ \\t]+${escapeRegExp(heading)}[ \\t]*$`,
    "gmi",
  );
  const matches = [...document.matchAll(headingPattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${heading} section, found ${matches.length}`);
  }
  const match = matches[0]!;
  const level = match[1]!.length;
  const bodyStart = match.index! + match[0].length;
  const remaining = document.slice(bodyStart);
  const nextHeading = new RegExp(`^#{1,${level}}[ \\t]+`, "m").exec(remaining);
  return remaining.slice(0, nextHeading?.index ?? remaining.length);
}

function hasMarkdownBlockBoundary(text: string, from: number, to: number): boolean {
  const gap = text.slice(from, to);
  if (/\n[ \t]*\n|(?:^|\n)[ \t]*```/.test(gap)) {
    return true;
  }
  const releaseLineStart = text.lastIndexOf("\n", to) + 1;
  const releasePrefix = text.slice(releaseLineStart, to);
  return /^[ \t]*(?:[-+*]|\d+[.)]|>)[ \t]+/.test(releasePrefix);
}

function proseUnits(markdown: string): string[] {
  return markdown
    .split(/\n[ \t]*\n|(?=^[ \t]*(?:[-+*]|\d+[.)]|>)[ \t]+)/m)
    .flatMap((block) => block.match(/[^.!?]+[.!?](?:\s+|$)|[^.!?]+$/g) ?? [])
    .map((unit) => unit.trim())
    .filter(Boolean);
}

function matchIndex(text: string, pattern: RegExp, label: string): number {
  const match = pattern.exec(text);
  if (match?.index === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return match.index;
}

const remoteSynchronizationAssuranceHeading = "Remote synchronization assurance";

function requireSectionPattern(section: string, pattern: RegExp, label: string): void {
  if (!pattern.test(section)) throw new Error(`Missing ${label}`);
}

function fieldDefinition(section: string, field: string): string {
  const tick = "`";
  const match = new RegExp(
    `^[ \\t]*[-*][ \\t]+${tick}${escapeRegExp(field)}${tick}:[ \\t]*([\\s\\S]*?)(?=^[ \\t]*[-*][ \\t]+${tick}|^[ \\t]*\\d+[.)][ \\t]+|^#{1,6}[ \\t]+|\\n[ \\t]*\\n)`,
    "mi",
  ).exec(section);
  if (match?.[1] === undefined) throw new Error(`Missing ${field} source definition`);
  return match[1];
}

function assertRemoteSynchronizationAssurance(document: string): void {
  const section = markdownSection(document, remoteSynchronizationAssuranceHeading);
  requireSectionPattern(
    section,
    /assurance\/remote-synchronization-\*\.json/i,
    "remote synchronization artifact path",
  );

  const local = fieldDefinition(section, "local_candidate_sha");
  requireSectionPattern(local, /candidate worktree HEAD/i, "candidate worktree HEAD source");
  requireSectionPattern(local, /git rev-parse HEAD/i, "local Git resolver");

  const pullRequest = fieldDefinition(section, "mapped_pr_sha");
  requireSectionPattern(pullRequest, /getPullRequest/i, "pull request lookup");
  requireSectionPattern(pullRequest, /persisted (?:PR|pull request) number/i, "persisted PR identity");

  const remote = fieldDefinition(section, "remote_head_sha");
  requireSectionPattern(remote, /git ls-remote --refs/i, "remote Git resolver");
  requireSectionPattern(remote, /configured remote/i, "configured remote identity");
  requireSectionPattern(remote, /configured branch/i, "configured branch identity");

  requireSectionPattern(
    section,
    /(?:all|each of the) three (?:full|complete) (?:SHAs?|SHA values?)[\s\S]{0,100}(?:must|need to|are required to)[\s\S]{0,40}(?:equal|match)[\s\S]{0,80}final integrated commit/i,
    "three-SHA equality with the final integrated commit",
  );

  const lines = section.split("\n");
  const recovery = lines.flatMap((line, index) => {
    const match = /^[ \t]*(\d+)[.)][ \t]+(.+)$/.exec(line);
    return match ? [{ index, number: Number(match[1]), text: match[2]! }] : [];
  });
  if (recovery.length !== 4
    || recovery.some((step, index) => step.number !== index + 1)
    || recovery.some((step, index) => index > 0 && step.index !== recovery[index - 1]!.index + 1)) {
    throw new Error("Recovery must be one contiguous ordered four-step procedure");
  }
  requireSectionPattern(recovery[0]!.text, /inspect|open|review/i, "artifact inspection step");
  requireSectionPattern(recovery[0]!.text, /assurance\/remote-synchronization-\*\.json/i, "artifact inspection target");
  requireSectionPattern(recovery[1]!.text, /compare/i, "SHA comparison step");
  for (const field of ["local_candidate_sha", "mapped_pr_sha", "remote_head_sha"]) {
    requireSectionPattern(recovery[1]!.text, new RegExp(escapeRegExp(field), "i"), `${field} comparison`);
  }
  requireSectionPattern(recovery[2]!.text, /correct|fix|repair/i, "push or mapping correction step");
  requireSectionPattern(recovery[2]!.text, /push/i, "push correction target");
  requireSectionPattern(recovery[2]!.text, /persisted (?:PR|pull request) mapping/i, "PR mapping correction target");
  requireSectionPattern(
    recovery[2]!.text,
    /(?:(?:do not|never|must not)[\s\S]{0,30}edit[\s\S]{0,30}artifact|(?:leave|keep)[\s\S]{0,30}artifact[\s\S]{0,30}(?:unchanged|immutable))/i,
    "artifact immutability instruction",
  );
  requireSectionPattern(recovery[3]!.text, /resume/i, "resume step");
  requireSectionPattern(recovery[3]!.text, /(?:new|fresh) observation/i, "new observation instruction");

  requireSectionPattern(
    section,
    /(?:remote synchronization blockers?[\s\S]{0,80}(?:(?:cannot|must not|never)[\s\S]{0,40}waiv|non-waiv)|risk acceptance[\s\S]{0,80}(?:cannot|does not|must not|never)[\s\S]{0,40}waiv[\s\S]{0,80}remote synchronization blockers?)/i,
    "non-waivable remote synchronization blocker rule",
  );
}

function assertImmutableFunnelGuidance(section: string): void {
  const developmentStart = matchIndex(
    section,
    /development(?:-|\s)+iteration/i,
    "development-iteration introduction",
  );
  const releaseStart = matchIndex(
    section,
    /(?:release(?:-|\s)+candidate(?:-|\s)+(?:proof|verification)|prove\s+a\s+release(?:-|\s)+candidate)/i,
    "release-candidate proof introduction",
  );
  if (developmentStart >= releaseStart) {
    throw new Error("Development iteration must precede release-candidate proof");
  }

  const developmentBlock = section.slice(developmentStart, releaseStart);
  const developmentCommands = [
    "npm run dev -- ...",
    "npm run build && node dist/cli.js ...",
  ];
  for (const command of developmentCommands) {
    if (!developmentBlock.includes(command)) {
      throw new Error(`Development block is missing ${command}`);
    }
  }
  if (/npm run verify:funnel|npm pack --dry-run --json --ignore-scripts/i.test(developmentBlock)) {
    throw new Error("Release proof commands must not be combined with development iteration");
  }
  const lastDevelopmentCommand = Math.max(
    ...developmentCommands.map((command) => section.indexOf(command, developmentStart) + command.length),
  );
  if (!hasMarkdownBlockBoundary(section, lastDevelopmentCommand, releaseStart)) {
    throw new Error("Release-candidate proof must begin in a separate block");
  }

  const releaseWindow = section.slice(releaseStart, releaseStart + 1_000);
  for (const command of [
    "npm run verify:funnel",
    "npm pack --dry-run --json --ignore-scripts",
  ]) {
    const commandIndex = releaseWindow.indexOf(command);
    if (commandIndex < 0 || commandIndex > 500) {
      throw new Error(`Release proof block is missing nearby ${command}`);
    }
  }

  const immutableIndex = matchIndex(
    releaseWindow,
    /BRAIN_HANDS_DIST_IMMUTABLE=1/,
    "immutable dist flag",
  );
  const digestIndex = matchIndex(
    releaseWindow,
    /(?:digest(?:-|\s)*(?:check|compar|verif)|(?:check|compar|verif)\w*(?:-|\s)+digest)/i,
    "digest verification",
  );
  if (Math.abs(immutableIndex - digestIndex) > 300) {
    throw new Error("Immutable flag and digest verification are too far apart");
  }

  const workerRelation = /\b(?:test\s+)?workers?\b.{0,80}\b(?:(?:(?:must|may|do)\s+not|never)\s+(?:invoke|run|call|execute|start)|(?:are|remain)\s+(?:forbidden|prohibited)\s+(?:(?:to\s+(?:invoke|run|call|execute|start))|(?:from\s+(?:invoking|running|calling|executing|starting))))\b/i;
  const commandPatterns = [/\bclean\b/i, /\bbuild\b/i, /`?npm test`?/i];
  const workerRule = proseUnits(releaseWindow).find((unit) => {
    if (unit.length > 400) {
      return false;
    }
    const relation = workerRelation.exec(unit);
    if (relation?.index === undefined) {
      return false;
    }
    const relationEnd = relation.index + relation[0].length;
    const commandIndexes = commandPatterns.map((command) => {
      const match = command.exec(unit.slice(relationEnd));
      return match?.index === undefined ? -1 : relationEnd + match.index;
    });
    return commandIndexes.every((index) => index >= relationEnd)
      && Math.min(...commandIndexes) - relationEnd <= 40;
  });
  if (workerRule === undefined) {
    throw new Error(
      "One bounded worker rule must prohibit invoking clean, build, and npm test",
    );
  }
  for (const command of commandPatterns) {
    if (!command.test(workerRule)) {
      throw new Error(`Bound worker rule is missing ${command.source}`);
    }
  }
}

describe("Brain Hands skill distribution", () => {
  it("contains valid skill metadata and an interactive intake contract", async () => {
    const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
    const metadata = await readFile(join(skillRoot, "agents", "openai.yaml"), "utf8");
    const parsed = parseYaml(metadata) as Record<string, unknown>;

    expect(skill.trim().length).toBeGreaterThan(0);
    expect(skill).toMatch(/interactive intake/i);
    expect(skill).toMatch(/mode/i);
    expect(skill).toMatch(/research/i);
    expect(skill).toMatch(/reflection/i);
    expect(skill).toContain(".brain-hands/config.yaml");
    expect(skill).toContain("brain-hands init --repo <repo>");
    expect(skill).toMatch(/wait for explicit confirmation/i);
    expect(skill).toContain("## Configuration preview gate");
    expect(skill).toContain("brain-hands preview --repo <repo> --json");
    expect(skill).toContain("scripts/brain-hands.mjs");
    expect(skill).toMatch(/do not invoke the raw `brain-hands`\s+executable/i);
    expect(skill).toMatch(/display `rendered_preview` verbatim/i);
    expect(skill).toMatch(/before any intake question/i);
    expect(skill).toMatch(/never replace[\s\S]{0,80}shortened summary/i);
    expect(skill.indexOf("## Repository initialization gate")).toBeLessThan(skill.indexOf("## Interactive intake"));
    expect(skill.indexOf("## Repository initialization gate")).toBeLessThan(skill.indexOf("## Configuration preview gate"));
    expect(skill.indexOf("## Configuration preview gate")).toBeLessThan(skill.indexOf("## Interactive intake"));
    for (const field of [
      "Repository",
      "Initialized",
      "Controller",
      "Mode",
      "Research",
      "Reflection",
      "Brain",
      "Hands",
      "Verifier",
      "Hands backup",
      "Hands fix attempts",
      "Replan attempts",
      "Review limit",
      "Quality gate",
      "GitHub remote",
      "GitHub effects",
    ]) expect(skill).toContain(field);
    const questions = [
      "Should I run locally without GitHub, or use GitHub issues and one pull request?",
      "Should Brain use Codex’s built-in web research for this task?",
      "Should I produce a process reflection after the terminal outcome?",
    ];
    expect(questions.map((question) => skill.indexOf(question))).toEqual(
      [...questions.map((question) => skill.indexOf(question))].sort((left, right) => left - right),
    );
    for (const question of questions) expect(skill.split(question)).toHaveLength(2);
    expect(skill).toContain("progress.jsonl");
    expect(skill).toMatch(/logs .*--follow/i);
    expect(skill).toMatch(/progress.*not.*approval/is);
    expect(skill).toMatch(/never.*start.*another worker/i);
    expect(parsed.name).toBe("brain-hands");
    expect(parsed.skill).toBe("../SKILL.md");
    const interfaceMetadata = parsed.interface as Record<string, unknown>;
    expect(String(interfaceMetadata.display_name).length).toBeGreaterThan(0);
    expect(String(interfaceMetadata.short_description).length).toBeGreaterThan(0);
    expect(String(interfaceMetadata.default_prompt)).toMatch(/complete.*configuration preview.*before.*questions/i);
  });

  it("declares the plugin and its packaged skill directory", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: string };
    const plugin = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
    expect(plugin.name).toBe("brain-hands");
    expect(plugin.version).toBe(packageJson.version);
    expect(String(plugin.description).length).toBeGreaterThan(0);
    expect(plugin.skills).toEqual("./.agents/skills/");
  });

  it("declares a repository marketplace for the separately distributed skill", async () => {
    const marketplace = JSON.parse(
      await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(marketplace).toEqual({
      name: "brain-hands",
      interface: { displayName: "Brain Hands" },
      plugins: [{
        name: "brain-hands",
        source: { source: "local", path: "." },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Coding",
      }],
    });
  });

  it("declares the package version as the skill CLI compatibility floor", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: string };
    const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
    const frontmatter = skill.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1];
    const parsed = parseYaml(frontmatter ?? "") as { requires?: { codex_flow?: string } };

    expect(parsed.requires?.codex_flow).toBe(`^${packageJson.version}`);
  });

  it("keeps package-lock and package metadata versions aligned", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: string };
    const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as {
      version?: string;
      packages?: {
        "": { version?: string };
      };
    };

    expect(lockfile.version).toBe(packageJson.version);
    expect(lockfile.packages?.[""]?.version).toBe(packageJson.version);
  });

  it("uses canonical stable versions for release-critical surfaces", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: string };
    const plugin = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8")) as { version?: string };
    const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as {
      version?: string;
      packages?: {
        "": { version?: string };
      };
    };
    const skill = await readFile(join(root, ".agents", "skills", "brain-hands", "SKILL.md"), "utf8");
    const frontmatter = skill.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1];
    const parsed = parseYaml(frontmatter ?? "") as { requires?: { codex_flow?: string } };

    parseStableVersion(packageJson.version);
    parseStableVersion(plugin.version);
    parseStableVersion(lockfile.version);
    parseStableVersion(lockfile.packages?.[""]?.version);
    expect(String(parsed.requires?.codex_flow)).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  it("publishes the renamed package and executable", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      name?: string;
      bin?: Record<string, string>;
    };

    expect(packageJson.name).toBe("@ngelik/brain-hands");
    expect(packageJson.bin).toEqual({ "brain-hands": "dist/cli.js" });
  });

  it("documents safe progress without weakening approval", async () => {
    const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
    expect(skill).toContain("logs --follow");
    expect(skill).toContain("approve-plan");
    expect(skill).toMatch(/progress.*not.*approval/is);
  });

  it("defines the deterministic plan approval conversation", async () => {
    const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");

    expect(skill).toMatch(/discovery[- ]brief approval and (?:execution-)?plan approval are (?:distinct|separate)/i);
    expect(skill).toMatch(/use\s+`plan_approval_request` only to detect and verify the pending boundary/i);
    expect(skill).toMatch(/do not display, stringify, reorder, or summarize the JSON request/i);
    expect(skill).toMatch(/Brain may recommend discovery choices.*never recommends approval of its own plan/is);
    expect(skill).toMatch(/initial plan approval authorizes the exact scope, commands, risks, external\s+effects, and authority/i);
    expect(skill).toMatch(/material replan approval\s+authorizes the exact proposed plan.*delta-first/is);
    expect(skill).toMatch(/internal\s+(?:Hands retries|fixes).*do\s+not require (?:a new |new )?plan approval/is);
    expect(skill).toMatch(/identical same-run resume.*(?:does not ask|without asking) again/is);
    expect(skill).toMatch(/merge remains (?:a )?separate\s+manual action/i);
    expect(skill).toMatch(/cross-run (?:approval\s+)?carry-forward is unsupported/i);
    const boundaryStartIndex = skill.indexOf("handling the plan boundary");
    const jsonStatusIndex = skill.indexOf("`brain-hands status --run <run-dir> --json`", boundaryStartIndex);
    const humanStatusIndex = skill.indexOf("`brain-hands status --run <run-dir>`", jsonStatusIndex);
    const renderedStartIndex = skill.indexOf("`Approval required:`", humanStatusIndex);
    const renderedEndIndex = skill.indexOf("`Next command (approve-plan):`", renderedStartIndex);
    const approveIndex = skill.indexOf("`brain-hands approve-plan --run <run-dir>", renderedEndIndex);
    expect(boundaryStartIndex).toBeGreaterThanOrEqual(0);
    expect(jsonStatusIndex).toBeGreaterThan(boundaryStartIndex);
    expect(humanStatusIndex).toBeGreaterThan(jsonStatusIndex);
    expect(renderedStartIndex).toBeGreaterThan(humanStatusIndex);
    expect(renderedEndIndex).toBeGreaterThan(renderedStartIndex);
    expect(approveIndex).toBeGreaterThan(renderedEndIndex);
    expect(skill).toMatch(/no request is pending.*resume --run <run-dir> --follow.*without asking again/is);
    expect(skill).toMatch(/never summarize a delta from model prose or\s+reconstruct one from\s+the patch/i);
    expect(skill).toMatch(/`pending_action`.*separate from.*`plan_approval_request`/is);
  });

  it("documents deterministic approval counts and same-run recovery", async () => {
    const [readme, cliContract] = await Promise.all([
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(skillRoot, "references", "cli-contract.md"), "utf8"),
    ]);
    const approvalRows = [
      "| Normal run | 2: discovery brief and initial plan |",
      "| Hands retry inside approved contract | 0 |",
      "| Verifier fix inside approved contract | 0 |",
      "| Process restart after approval | 0 |",
      "| Repeated exact `approve-plan` | 0 |",
      "| Material replan | 1 |",
      "| Invalid or no-op replan | 0; block before prompting |",
      "| GitHub merge | Separate manual action |",
    ];

    for (const row of approvalRows) expect(readme).toContain(row);
    for (const surface of [readme, cliContract]) {
      expect(surface).toMatch(/same-run `resume`.*(?:does not ask|without asking).*again/is);
      expect(surface).toMatch(/cross-run (?:approval\s+)?carry-forward is unsupported/i);
      expect(surface).toMatch(/delta-first/i);
    }
  });

  it("documents positional and --run workflow selectors as alternatives", async () => {
    const cliContract = await readFile(join(skillRoot, "references", "cli-contract.md"), "utf8");

    for (const command of ["approve-plan", "resume", "status", "logs"]) {
      expect(cliContract).toContain(`brain-hands ${command} <run-id>`);
      expect(cliContract).toContain(`brain-hands ${command} --run <run-dir>`);
      expect(cliContract).not.toContain(`brain-hands ${command} [<run-id>] --run <run-dir>`);
    }
  });

  it("documents the same read-only preview contract on operator surfaces", async () => {
    const surfaces = await Promise.all([
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(skillRoot, "references", "cli-contract.md"), "utf8"),
    ]);

    for (const surface of surfaces) {
      expect(surface).toContain("brain-hands preview");
      expect(surface).toContain("missing_choices");
      expect(surface).toContain("rendered_preview");
      expect(surface).toMatch(/does not (?:create|write)[\s\S]{0,120}(?:run|artifact)/i);
      expect(surface).toMatch(/does not[\s\S]{0,120}(?:preflight|model|GitHub)/i);
      expect(surface).toContain("run-configuration.json");
    }
  });

  it("documents the same durable discovery contract on every operator surface", async () => {
    const surfaces = await Promise.all([
      readFile(join(skillRoot, "SKILL.md"), "utf8"),
      readFile(join(skillRoot, "references", "cli-contract.md"), "utf8"),
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(root, "agentic-codex-workflow.md"), "utf8"),
    ]);
    const commands = [
      "answer-discovery",
      "select-discovery-approach",
      "proceed-discovery",
      "approve-discovery",
      "revise-discovery",
    ];

    for (const surface of surfaces) {
      for (const command of commands) expect(surface).toContain(command);
      expect(surface).toMatch(/one question at a time/i);
      expect(surface).toMatch(/discovery[\s\S]{0,100}(?:local-only|remain[\s\S]{0,40}local)/i);
      expect(surface).toMatch(/first user boundary/i);
      expect(surface).toMatch(/resume[\s\S]{0,100}read-only/i);
      expect(surface).toMatch(/engine-authored[\s\S]{0,240}(?:verbatim|without[\s\S]{0,40}rewrit)/i);
      expect(surface).toMatch(/five[\s\S]{0,80}soft limit/i);
      expect(surface).toMatch(/six[\s\S]{0,80}hard limit/i);
      expect(surface).toMatch(/secret[\s\S]{0,100}reject/i);
      expect(surface).toMatch(/exact brief revision[\s\S]{0,120}SHA-256/i);
      expect(surface).toMatch(/legacy[\s\S]{0,100}resume/i);
      expect(surface.indexOf("approve-discovery")).toBeLessThan(surface.indexOf("approve-plan"));
    }

    const skill = surfaces[0]!;
    expect(skill).toMatch(/engine-authored[\s\S]{0,100}verbatim/i);
    expect(skill).toMatch(/exact brief revision[\s\S]{0,100}SHA-256/i);
    expect(skill).toMatch(/separate[\s\S]{0,100}plan approval/i);
    expect(skill).toMatch(/model request resolution[\s\S]{0,500}gpt-5\.6-sol[\s\S]{0,500}gpt-5\.6-terra[\s\S]{0,500}gpt-5\.6-luna/i);
    expect(skill).toMatch(/codex debug models[\s\S]{0,120}runtime authority/i);

    const cliContract = surfaces[1]!;
    expect(cliContract).toMatch(/(?:verify|verification)[\s\S]{0,80}SHA-256|SHA-256[\s\S]{0,80}(?:verify|verification)/i);
  });

  it("rejects incomplete, scattered, duplicate, or reordered remote assurance guidance", () => {
    const body = `
Evidence is stored under \`assurance/remote-synchronization-*.json\`.

- \`local_candidate_sha\`: candidate worktree HEAD from \`git rev-parse HEAD\`.
- \`mapped_pr_sha\`: \`getPullRequest\` result for the persisted PR number.
- \`remote_head_sha\`: \`git ls-remote --refs\` for the configured remote and configured branch.

All three full SHAs are required to match the final integrated commit.

1. Review \`assurance/remote-synchronization-*.json\`.
2. Compare \`local_candidate_sha\`, \`mapped_pr_sha\`, and \`remote_head_sha\`.
3. Repair the push or persisted PR mapping; never edit the artifact.
4. Resume to create a new observation.

Remote synchronization blockers must not be waived through risk acceptance.
`;
    const valid = `## ${remoteSynchronizationAssuranceHeading}\n${body}`;
    expect(() => assertRemoteSynchronizationAssurance(valid)).not.toThrow();
    const semanticEquivalent = `### ${remoteSynchronizationAssuranceHeading}
Proof files use \`assurance/remote-synchronization-*.json\`.

- \`local_candidate_sha\`: candidate worktree HEAD obtained by \`git rev-parse HEAD\`.
- \`mapped_pr_sha\`: persisted pull request number resolved through \`getPullRequest\`.
- \`remote_head_sha\`: configured branch on the configured remote resolved through \`git ls-remote --refs\`.

Each of the three complete SHA values must match the final integrated commit.

1) Open \`assurance/remote-synchronization-*.json\`.
2) Compare \`local_candidate_sha\`, \`mapped_pr_sha\`, and \`remote_head_sha\`.
3) Fix the push or persisted pull request mapping; leave the artifact unchanged.
4) Resume to capture a fresh observation.

Risk acceptance never waives a remote synchronization blocker.
`;
    expect(() => assertRemoteSynchronizationAssurance(semanticEquivalent)).not.toThrow();

    const cases = [
      ["missing heading", body],
      ["scattered fragments", `## ${remoteSynchronizationAssuranceHeading}\nEvidence is stored elsewhere.\n\n## Other guidance\n${body}`],
      ["duplicate stale section", `${valid}\n## ${remoteSynchronizationAssuranceHeading}\nStale guidance.`],
      ["missing equality", valid.replace(/All three full SHAs[^\n]+\n/, "")],
      ["reordered recovery", valid
        .replace("2. Compare `local_candidate_sha`, `mapped_pr_sha`, and `remote_head_sha`.", "2. Repair the push or persisted PR mapping; never edit the artifact.")
        .replace("3. Repair the push or persisted PR mapping; never edit the artifact.", "3. Compare `local_candidate_sha`, `mapped_pr_sha`, and `remote_head_sha`.")],
      ["discontiguous recovery", valid.replace(
        "3. Repair the push or persisted PR mapping; never edit the artifact.",
        "Check operator access before continuing.\n3. Repair the push or persisted PR mapping; never edit the artifact.",
      )],
    ] as const;
    for (const [label, document] of cases) {
      expect(() => assertRemoteSynchronizationAssurance(document), label).toThrow();
    }
  });

  it("documents one bounded non-waivable remote synchronization assurance section", async () => {
    const surfaces = await Promise.all([
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(root, "agentic-codex-workflow.md"), "utf8"),
    ]);

    for (const surface of surfaces) {
      expect(() => assertRemoteSynchronizationAssurance(surface)).not.toThrow();
    }
  });

  it("documents the same same-run recovery order on every operator surface", async () => {
    const surfaces = await Promise.all([
      readFile(join(skillRoot, "SKILL.md"), "utf8"),
      readFile(join(root, "README.md"), "utf8"),
      readFile(join(root, "agentic-codex-workflow.md"), "utf8"),
    ]);
    const ordered = [
      "inspect status/logs",
      "resume the existing run",
      "authorize one diagnostic retry",
      "attest an expected controller hash",
      "explicitly abandon only when same-run recovery is unsafe",
      "replace only an abandoned run",
      "never use ordinary run for recovery",
      "never reuse approval or GitHub effects across replacement",
    ];

    for (const surface of surfaces) {
      const positions = ordered.map((phrase) => surface.indexOf(phrase));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
      expect(surface).toContain("verified_ready");
      expect(surface).toContain("human_accepted");
      expect(surface).toContain("blocked");
      expect(surface).toContain("abandoned");
      expect(surface).toMatch(/diagnostic authorization[\s\S]{0,160}not\s+approve\s+implementation/i);
      expect(surface).toMatch(/controller attestation[\s\S]{0,160}not\s+approve\s+implementation/i);
    }

    expect(surfaces[0]).toContain("--recovery-note-file");
    expect(surfaces[0]).toContain("--expected-package-sha256");
  });

  it("keeps the npm package allowlist limited to stable runtime surfaces", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { files?: string[] };
    const files = packageJson.files ?? [];
    expect(files).toEqual(["dist/", "prompts/", "agentic-codex-workflow.md", "README.md"]);
    for (const forbidden of ["src/", "tests/", ".brain-hands/", "docs/", ".agents/", ".codex-plugin/"]) {
      expect(files).not.toContain(forbidden);
    }
  });

  it("documents development iteration separately from immutable release proof", async () => {
    const surfaces = [
      {
        document: await readFile(join(root, "AGENTS.md"), "utf8"),
        heading: "Local Development vs Stable CLI",
      },
      {
        document: await readFile(join(root, "README.md"), "utf8"),
        heading: "Development",
      },
    ];

    for (const { document, heading } of surfaces) {
      assertImmutableFunnelGuidance(markdownSection(document, heading));
    }
  });

  it("rejects combined, reordered, stale, or scattered immutable-funnel guidance", () => {
    const valid = `# Example

## Operator workflow

Development iteration uses:

\`npm run dev -- ...\`
\`npm run build && node dist/cli.js ...\`

Release candidate verification uses \`npm run verify:funnel\` and
\`npm pack --dry-run --json --ignore-scripts\`.

Post-build tests inherit \`BRAIN_HANDS_DIST_IMMUTABLE=1\`; digest verification
confirms the candidate remains unchanged. Test workers never call \`npm test\`,
build, or clean.

## Later section
`;
    const verify = (document: string) => assertImmutableFunnelGuidance(
      markdownSection(document, "Operator workflow"),
    );

    expect(() => verify(valid)).not.toThrow();
    expect(() => verify(valid.replace(
      "Development iteration uses:\n\n`npm run dev -- ...`\n`npm run build && node dist/cli.js ...`\n\nRelease candidate verification uses",
      "Development iteration and release candidate verification use `npm run dev -- ...`, `npm run build && node dist/cli.js ...`, and",
    ))).toThrow();
    expect(() => verify(valid.replace(
      "Development iteration uses:",
      "Release candidate verification comes first.\n\nDevelopment iteration uses:",
    ))).toThrow();
    expect(() => verify(valid.replace(
      "Release candidate verification uses `npm run verify:funnel` and\n`npm pack --dry-run --json --ignore-scripts`.\n\nPost-build tests inherit `BRAIN_HANDS_DIST_IMMUTABLE=1`; digest verification\nconfirms the candidate remains unchanged. Test workers never call `npm test`,\nbuild, or clean.",
      "Release notes are maintained separately.\n\n## Historical text\n\nRelease candidate verification uses `npm run verify:funnel` and `npm pack --dry-run --json --ignore-scripts`. Post-build tests inherit `BRAIN_HANDS_DIST_IMMUTABLE=1`; digest verification confirms the candidate remains unchanged. Test workers never call `npm test`, build, or clean.",
    ))).toThrow();
    expect(() => verify(valid.replace(
      "Post-build tests inherit `BRAIN_HANDS_DIST_IMMUTABLE=1`; digest verification",
      `Post-build tests inherit \`BRAIN_HANDS_DIST_IMMUTABLE=1\`.\n\n${"Unrelated detail. ".repeat(80)}\n\nDigest verification`,
    ))).toThrow();
    expect(() => verify(valid.replace(
      "Release candidate verification uses `npm run verify:funnel` and\n`npm pack --dry-run --json --ignore-scripts`.",
      "<!-- Release candidate verification uses `npm run verify:funnel` and `npm pack --dry-run --json --ignore-scripts`. -->",
    ))).toThrow();
    expect(() => verify(valid.replace(
      "Development iteration uses:\n\n`npm run dev -- ...`\n`npm run build && node dist/cli.js ...`\n\nRelease candidate verification uses `npm run verify:funnel` and\n`npm pack --dry-run --json --ignore-scripts`.",
      "Development iteration uses `npm run dev -- ...` and `npm run build && node dist/cli.js ...`.\nRelease candidate verification uses `npm run verify:funnel` and `npm pack --dry-run --json --ignore-scripts`.",
    ))).toThrow();
    expect(() => verify(valid.replace(
      "Test workers never call `npm test`,\nbuild, or clean.",
      "Test workers run verification. Do not edit examples discussing clean setup, build output, or `npm test`.",
    ))).toThrow();
    expect(() => verify(valid.replace(
      "Test workers never call `npm test`,\nbuild, or clean.",
      "Test workers may not run build, `npm test`, or clean.",
    ))).not.toThrow();
    expect(() => verify(valid.replace(
      "Test workers never call `npm test`,\nbuild, or clean.",
      "Test workers are forbidden to invoke clean, `npm test`, or build.",
    ))).not.toThrow();
    expect(() => verify(valid.replace(
      "# Example",
      "# Example\n\n<!--\n## Operator workflow\nCommented stale guidance.\n-->",
    ))).not.toThrow();
  });
});
