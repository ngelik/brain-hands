import { readFile } from "node:fs/promises";

export async function readOperatorText(inputFile?: string): Promise<string> {
  const text = inputFile === undefined
    ? await new Promise<string>((resolve, reject) => {
        let value = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: string) => { value += chunk; });
        process.stdin.on("end", () => resolve(value));
        process.stdin.on("error", reject);
      })
    : await readFile(inputFile, "utf8");
  const normalized = text.trim();
  if (!normalized) throw new Error("Operator input must be non-empty");
  return normalized;
}
