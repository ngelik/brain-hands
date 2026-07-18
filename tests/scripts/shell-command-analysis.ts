export type ShellCommand = {
  raw: string;
  argv: string[];
};

function splitShellLists(source: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const finish = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "#" && (current.length === 0 || /\s/u.test(current.at(-1)!))) {
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      finish();
      continue;
    }
    if (character === "\n" || character === ";" || character === "|") {
      finish();
      if (character === "|" && source[index + 1] === character) index += 1;
      continue;
    }
    if (character === "&") {
      finish();
      if (source[index + 1] === "&") index += 1;
      continue;
    }
    current += character;
  }
  finish();
  return segments;
}

function tokenize(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const finish = () => {
    if (current) words.push(current);
    current = "";
  };

  for (const character of segment) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) finish();
    else current += character;
  }
  finish();
  return words;
}

function executableArgv(segment: string): string[] {
  const words = tokenize(segment);
  while (["if", "elif", "while", "until", "then", "else", "do", "!", "{"].includes(words[0] ?? "")) {
    words.shift();
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? "")) words.shift();
  if (words[0] === "command") words.shift();
  if (words[0] === "env") {
    words.shift();
    while ((words[0] ?? "").startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? "")) {
      words.shift();
    }
  }
  if (["", "fi", "done", "esac", "}"].includes(words[0] ?? "")) return [];
  if (/^[A-Za-z_][A-Za-z0-9_]*\(\)$/u.test(words[0] ?? "")) return [];
  return words;
}

function commandSubstitutions(source: string): string[] {
  const substitutions: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < source.length - 1; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? undefined : "'";
      continue;
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (quote === "'" || character !== "$" || source[index + 1] !== "(") continue;

    const start = index + 2;
    let depth = 1;
    let innerQuote: "'" | '"' | undefined;
    let innerEscaped = false;
    let cursor = start;
    for (; cursor < source.length; cursor += 1) {
      const inner = source[cursor]!;
      if (innerEscaped) {
        innerEscaped = false;
        continue;
      }
      if (inner === "\\" && innerQuote !== "'") {
        innerEscaped = true;
        continue;
      }
      if (inner === "'" && innerQuote !== '"') {
        innerQuote = innerQuote === "'" ? undefined : "'";
        continue;
      }
      if (inner === '"' && innerQuote !== "'") {
        innerQuote = innerQuote === '"' ? undefined : '"';
        continue;
      }
      if (innerQuote) continue;
      if (inner === "(") depth += 1;
      if (inner === ")") depth -= 1;
      if (depth === 0) break;
    }
    if (depth === 0) {
      substitutions.push(source.slice(start, cursor));
      index = cursor;
    }
  }
  return substitutions;
}

export function extractShellCommands(source: string): ShellCommand[] {
  const direct = splitShellLists(source).flatMap((raw) => {
    const argv = executableArgv(raw);
    return argv.length > 0 ? [{ raw, argv }] : [];
  });
  const nestedShells = direct.flatMap((command) => {
    const shell = command.argv[0]?.split("/").at(-1);
    return ["sh", "bash", "zsh"].includes(shell ?? "") && command.argv[1] === "-c" && command.argv[2]
      ? extractShellCommands(command.argv[2])
      : [];
  });
  const substitutions = commandSubstitutions(source).flatMap(extractShellCommands);
  return [...direct, ...nestedShells, ...substitutions];
}

export function commandStartsWith(command: ShellCommand, prefix: readonly string[]): boolean {
  return prefix.every((part, index) => command.argv[index] === part);
}
