import { createRequire } from "node:module";

interface PackageMetadata {
  version?: unknown;
}

const require = createRequire(import.meta.url);
const packageMetadata = require("../../package.json") as PackageMetadata;

export function packageVersion(): string {
  if (typeof packageMetadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageMetadata.version)) {
    throw new Error("package.json must contain a stable semantic version");
  }
  return packageMetadata.version;
}
