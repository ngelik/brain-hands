import { readdir } from "node:fs/promises";

export async function invocationArtifactName(runDir: string, base: string): Promise<string> {
  const entries = await Promise.all(["prompts", "schemas", "responses"].map(async (directory) => ({
    directory,
    names: await readdir(`${runDir}/${directory}`).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }),
  })));
  const isUsed = (candidate: string): boolean => entries.some(({ directory, names }) => names.some((name) =>
    directory === "prompts" ? name === `${candidate}.md` : name.startsWith(`${candidate}.`)));
  for (let ordinal = 1; ; ordinal += 1) {
    const candidate = ordinal === 1 ? base : `${base}-resume-${ordinal}`;
    if (!isUsed(candidate)) return candidate;
  }
}
