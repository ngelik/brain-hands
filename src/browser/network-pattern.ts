function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesExpectedNetwork(expected: string, observed: string): boolean {
  if (expected === observed) return true;
  const parts = expected.split("**").map((part) =>
    part.split("*").map(escapeRegExp).join("[^/]*"));
  return new RegExp(`^${parts.join(".*")}$`).test(observed);
}

export function missingExpectedNetwork(expected: readonly string[], observed: readonly string[]): string[] {
  return expected.filter((pattern) => !observed.some((entry) => matchesExpectedNetwork(pattern, entry)));
}
