import type { RunManifestV2 } from "./types.js";

export interface PersistedPullRequestMapping {
  number: number;
  url: string;
}

export class PersistedPullRequestMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistedPullRequestMappingError";
  }
}

/** Validate the single canonical PR identity duplicated in the run manifest. */
export function requirePersistedPullRequestMapping(
  manifest: Pick<RunManifestV2, "pull_request_numbers" | "github_ids">,
): PersistedPullRequestMapping {
  const top = manifest.pull_request_numbers;
  const nested = manifest.github_ids.pull_request_numbers;
  if (top.length !== 1 || nested.length !== 1) {
    throw new PersistedPullRequestMappingError(
      "Persisted pull request mapping requires exactly one number in each manifest array",
    );
  }
  const number = top[0]!;
  if (nested[0] !== number) {
    throw new PersistedPullRequestMappingError(
      "Persisted pull request mapping arrays must contain one identical pull request number",
    );
  }
  const url = manifest.github_ids.pull_request_urls[String(number)];
  if (typeof url !== "string" || url.trim() === "") {
    throw new PersistedPullRequestMappingError(
      `Persisted pull request URL is missing for pull request number ${number}`,
    );
  }
  try {
    const match = new URL(url).pathname.match(/\/pull\/(\d+)\/?$/);
    if (!match || Number(match[1]) !== number) throw new Error("number mismatch");
  } catch {
    throw new PersistedPullRequestMappingError(
      `Persisted pull request URL does not identify pull request number ${number}`,
    );
  }
  return { number, url };
}
