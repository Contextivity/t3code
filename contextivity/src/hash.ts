import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeStreamPromises from "node:stream/promises";

export function sha256Text(text: string): string {
  return NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Buffer(buffer: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(buffer).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  const stream = NodeFS.createReadStream(filePath);
  stream.pipe(hash);
  await NodeStreamPromises.finished(stream);
  return hash.digest("hex");
}

export function checksumLine(sha256: string, filename: string): string {
  return `${sha256}  ${filename}`;
}

export function formatChecksumFile(
  entries: ReadonlyArray<{ readonly name: string; readonly sha256: string }>,
): string {
  return `${[...entries]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => checksumLine(entry.sha256, entry.name))
    .join("\n")}\n`;
}

export function parseChecksumFile(
  text: string,
): ReadonlyArray<{ readonly name: string; readonly sha256: string }> {
  const entries: Array<{ name: string; sha256: string }> = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/iu.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) {
      throw new Error(`Invalid checksum line: ${rawLine}`);
    }
    entries.push({ sha256: match[1].toLowerCase(), name: match[2] });
  }
  return entries;
}
