#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDistMutable, IMMUTABLE_DIST_ENV } from "./dist-artifact.mjs";

export async function cleanDist({ cwd = process.cwd(), env = process.env } = {}) {
  const distPath = resolve(cwd, "dist");
  try {
    assertDistMutable(env);
  } catch {
    throw new Error(`Refusing to remove ${distPath}: ${IMMUTABLE_DIST_ENV}=1`);
  }
  await rm(distPath, { recursive: true, force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await cleanDist();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
