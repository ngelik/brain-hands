import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../../src/core/executor.js";
import type { ModelRole, RoleName } from "../../src/core/types.js";
vi.mock("../../src/core/executor.js", () => ({
  runCommand: vi.fn(),
}));
import { runCommand } from "../../src/core/executor.js";
import { CodexModelCatalogAdapter } from "../../src/adapters/codex-models.js";

const mockedRunCommand = vi.mocked(runCommand);

const catalogFixture = {
  models: [
    {
      slug: "gpt-5.6-sol",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" },
      ],
    },
    {
      slug: "gpt-5.6-terra",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" },
      ],
    },
    {
      slug: "gpt-5.6-luna",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
      ],
    },
    {
      slug: "gpt-5.3-codex-spark",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
      ],
    },
  ],
};

function catalogCommandSuccess(timeoutMs = 30_000): CommandResult {
  return {
    command: "codex",
    args: ["debug", "models"],
    exitCode: 0,
    stdout: JSON.stringify(catalogFixture),
    stderr: "",
    failed: false,
    timedOut: false,
    signal: null,
  };
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected a rejected Promise");
}

afterEach(() => {
  mockedRunCommand.mockReset();
});

describe("CodexModelCatalogAdapter", () => {
  it("accepts an exact model slug and exact reasoning effort", async () => {
    mockedRunCommand.mockResolvedValue(catalogCommandSuccess());
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    await expect(
      adapter.assertExactModelSelection({
        role: "brain",
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
      }),
    ).resolves.toBeUndefined();
    expect(mockedRunCommand).toHaveBeenCalledWith({
      command: "codex",
      args: ["debug", "models"],
      cwd: "/repo",
      timeoutMs: 30_000,
    });
  });

  it.each([
    { role: "brain", model: "gpt-5.6-sol", reasoningEffort: "ultra" },
    { role: "hands", model: "gpt-5.6-terra", reasoningEffort: "ultra" },
    { role: "verifier", model: "gpt-5.6-luna", reasoningEffort: "max" },
    { role: "hands_implementer", model: "gpt-5.3-codex-spark", reasoningEffort: "xhigh" },
  ] satisfies Array<{ role: ModelRole | RoleName; model: string; reasoningEffort: string }>)("accepts exact matrix entry for $role role", async ({ role, model, reasoningEffort }) => {
    mockedRunCommand.mockResolvedValue(catalogCommandSuccess());
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    await expect(
      adapter.assertExactModelSelection({
        role,
        model,
        reasoningEffort,
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts catalog efforts not represented in any runtime allowlist when exact", async () => {
    const catalogWithUnknownEffort = {
      ...catalogFixture,
      models: [
        {
          ...catalogFixture.models[0],
          supported_reasoning_levels: [
            ...catalogFixture.models[0].supported_reasoning_levels,
            { effort: "experimental" },
          ],
        },
        ...catalogFixture.models.slice(1),
      ],
    };

    mockedRunCommand.mockResolvedValue({
      ...catalogCommandSuccess(),
      stdout: JSON.stringify(catalogWithUnknownEffort),
    });
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });
    await expect(
      adapter.assertExactModelSelection({
        role: "brain",
        model: "gpt-5.6-sol",
        reasoningEffort: "experimental",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects catalog entries with missing full model IDs", async () => {
    mockedRunCommand.mockResolvedValue({
      ...catalogCommandSuccess(),
      stdout: JSON.stringify({
        models: [
          {
            supported_reasoning_levels: [{ effort: "low" }],
          },
          ...catalogFixture.models.slice(0, 1),
        ],
      }),
    });
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    const message = await adapter.assertExactModelSelection({
      role: "brain",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
    }).catch((error) => `${error}`);
    expect(message).toContain('Model catalog entry 0 is missing a non-empty string slug');
  });

  it("rejects duplicate model IDs in the catalog", async () => {
    mockedRunCommand.mockResolvedValue({
      ...catalogCommandSuccess(),
      stdout: JSON.stringify({
        ...catalogFixture,
        models: [
          catalogFixture.models[0],
          catalogFixture.models[0],
          ...catalogFixture.models.slice(1),
        ],
      }),
    });
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    const message = await adapter.assertExactModelSelection({
      role: "brain",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
    }).catch((error) => `${error}`);
    expect(message).toContain('Malformed Codex model catalog: duplicate model slug "gpt-5.6-sol"');
  });

  it("rejects similar model names without prefix/fallback behavior", async () => {
    mockedRunCommand.mockResolvedValue(catalogCommandSuccess());
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    const errorMessage = await rejectionMessage(
      adapter.assertExactModelSelection({
        role: "hands",
        model: "gpt-5.3-codex-spark-lite",
        reasoningEffort: "high",
      }),
    );
    expect(errorMessage).toContain(
      'Configured model/reasoning pair for role "hands" is invalid: model "gpt-5.3-codex-spark-lite" and reasoning "high" are not an exact catalog match.',
    );
    expect(errorMessage).toContain('reasoning_effort "high"');
    expect(errorMessage).toContain("Supported model slugs: gpt-5.3-codex-spark (low, medium, high, xhigh), gpt-5.6-luna (low, medium, high, xhigh, max), gpt-5.6-sol (low, medium, high, xhigh, max, ultra), gpt-5.6-terra (low, medium, high, xhigh, max, ultra)");
    expect(errorMessage).toContain('Run "codex update"');
    expect(errorMessage).toContain('Run "codex debug models"');
    expect(errorMessage).toContain("profiles.hands.model");
    expect(errorMessage).toContain("profiles.hands.reasoning_effort");
  });

  it("distinguishes a known official model from a stale local catalog", async () => {
    mockedRunCommand.mockResolvedValue({
      ...catalogCommandSuccess(),
      stdout: JSON.stringify({ models: catalogFixture.models.filter((model) => model.slug !== "gpt-5.6-terra") }),
    });
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    const message = await rejectionMessage(adapter.assertExactModelSelection({
      role: "verifier",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    }));
    expect(message).toContain('built-in OpenAI model registry recognizes "gpt-5.6-terra"');
    expect(message).toContain("current local Codex catalog does not expose it");
  });

  it("rejects unsupported reasoning effort with exact valid choices", async () => {
    mockedRunCommand.mockResolvedValue(catalogCommandSuccess());
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    const message = await rejectionMessage(
      adapter.assertExactModelSelection({
        role: "verifier",
        model: "gpt-5.3-codex-spark",
        reasoningEffort: "max",
      }),
    );
    expect(message).toContain(
      'Configured model/reasoning pair for role "verifier" is invalid: reasoning "max" is not supported for model "gpt-5.3-codex-spark".',
    );
    expect(message).toContain('Supported efforts for "gpt-5.3-codex-spark": low, medium, high, xhigh');
    expect(message).toContain("profiles.verifier.reasoning_effort");
    expect(message).toContain("Run \"codex debug models\"");
  });

  it("reports verifier profile fields for legacy reviewer role", async () => {
    mockedRunCommand.mockResolvedValue(catalogCommandSuccess());
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    const message = await adapter.assertExactModelSelection({
      role: "brain_reviewer",
      model: "gpt-5.3-codex-spark",
      reasoningEffort: "max",
    }).catch((error) => `${error}`);
    expect(message).toContain("profiles.verifier.model");
    expect(message).toContain("profiles.verifier.reasoning_effort");
  });

  it.each(["", " "])("rejects malformed catalog effort %j before any model execution", async (effort) => {
    mockedRunCommand.mockResolvedValue({
      ...catalogCommandSuccess(),
      stdout: JSON.stringify({
        models: [{ slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort }] }],
      }),
    });
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    const message = await adapter.assertExactModelSelection({
      role: "brain",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
    }).catch((error) => `${error}`);
    expect(message).toContain("Malformed Codex model catalog");
    expect(message).toContain('Configured model/reasoning pair for role "brain"');
    expect(message).toContain("profiles.brain.model");
    expect(message).toContain("profiles.brain.reasoning_effort");
    expect(message).toContain("Run \"codex debug models\"");
  });

  it("rejects catalog command failures with actionable remediation", async () => {
    mockedRunCommand.mockResolvedValue({
      command: "codex",
      args: ["debug", "models"],
      exitCode: 1,
      stdout: "",
      stderr: "authentication required",
      failed: true,
      timedOut: false,
      signal: null,
    });
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    const message = await adapter.assertExactModelSelection({
      role: "brain",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
    }).catch((error) => `${error}`);
    expect(message).toContain("Codex model catalog request failed.");
    expect(message).toContain('Configured model/reasoning pair for role "brain"');
    expect(message).toContain('model "gpt-5.6-sol"');
    expect(message).toContain('reasoning_effort "max"');
    expect(message).toContain("profiles.brain.model");
    expect(message).toContain("profiles.brain.reasoning_effort");
    expect(message).toContain("codex update");
    expect(message).toContain('Run "codex debug models"');
    expect(message).toContain("authentication required");
  });

  it("formats concurrent catalog failures for each caller's configured pair", async () => {
    mockedRunCommand.mockResolvedValue({
      command: "codex",
      args: ["debug", "models"],
      exitCode: 1,
      stdout: "",
      stderr: "catalog unavailable",
      failed: true,
      timedOut: false,
      signal: null,
    });
    const adapter = new CodexModelCatalogAdapter({
      command: "codex",
      cwd: "/repo",
      timeoutMs: 30_000,
    });

    const [brainMessage, handsMessage] = await Promise.all([
      rejectionMessage(adapter.assertExactModelSelection({
        role: "brain",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      })),
      rejectionMessage(adapter.assertExactModelSelection({
        role: "hands",
        model: "gpt-5.3-codex-spark",
        reasoningEffort: "xhigh",
      })),
    ]);

    expect(mockedRunCommand).toHaveBeenCalledTimes(1);
    expect(brainMessage).toContain('role "brain": model "gpt-5.6-sol", reasoning_effort "high"');
    expect(brainMessage).toContain("profiles.brain.model");
    expect(handsMessage).toContain('role "hands": model "gpt-5.3-codex-spark", reasoning_effort "xhigh"');
    expect(handsMessage).toContain("profiles.hands.model");
  });
});
