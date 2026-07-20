import { posix } from "node:path";

const ownedAttemptEvidenceName = /^(?:command-\d+\.json|stdout-\d+\.txt|stderr-\d+\.txt|result-\d+\.json)$/;

export function verifierEvidenceBindsVerification(
  reviewedPaths: readonly string[],
  verificationPath: string,
): boolean {
  if (verificationPath.includes("\\") || posix.isAbsolute(verificationPath)
    || posix.normalize(verificationPath) !== verificationPath) return false;
  const verificationDirectory = posix.dirname(verificationPath);
  return reviewedPaths.some((path) => {
    if (path.includes("\\") || posix.isAbsolute(path) || posix.normalize(path) !== path) return false;
    if (path === verificationPath) return true;
    return posix.dirname(path) === verificationDirectory && ownedAttemptEvidenceName.test(posix.basename(path));
  });
}
