export type ReleaseVersions = {
  packageVersion: string;
  lockfileVersion: string;
  lockfilePackageVersion: string;
  pluginVersion: string;
  requiredRange: string;
};

export function parseCanonicalVersion(value: unknown): { version: string; tag: string };
export function readReleaseVersions(root?: string): ReleaseVersions;
export function synchronizeReleaseVersion(root: string, value: unknown): ReleaseVersions;
