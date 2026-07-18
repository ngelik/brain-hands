export interface SecretMaterialMatch {
  kind: string;
  match: string;
}

const detectors: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  {
    kind: "credential_assignment",
    pattern: /\b(?:password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|token|secret)\s*[:=]\s*["']?(?!\$\{|process\.env\b|<|redacted\b|example\b|changeme\b)[^\s"']{8,}/i,
  },
  { kind: "authorization_header", pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]{8,}/i },
  { kind: "openai_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/ },
  { kind: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { kind: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    kind: "secret_path",
    pattern: /(?:^|[/\\\s"'[(])(?:\.env(?:\.[A-Za-z0-9_-]+)?|credentials\.json|secrets?\.[A-Za-z0-9_-]+)(?=$|[/\\\s"',\])])/i,
  },
];

export function detectSecretMaterial(value: string): SecretMaterialMatch | null {
  for (const detector of detectors) {
    const match = value.match(detector.pattern)?.[0];
    if (match) return { kind: detector.kind, match };
  }
  return null;
}

export function assertNoSecretMaterial(label: string, value: string): void {
  const detected = detectSecretMaterial(value);
  if (detected) {
    throw new Error(`${label} contains secret material (${detected.kind})`);
  }
}
