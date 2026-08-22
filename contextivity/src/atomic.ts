import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

export function atomicWriteFile(
  filePath: string,
  contents: string | Uint8Array,
  mode?: number,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tempPath, contents);
    if (mode !== undefined) chmodSync(tempPath, mode);
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // ignore cleanup
    }
    throw error;
  }
}

export function atomicSymlink(linkPath: string, target: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  const tempPath = join(dirname(linkPath), `.${randomBytes(8).toString("hex")}.tmp-link`);
  try {
    symlinkSync(target, tempPath);
    renameSync(tempPath, linkPath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // ignore cleanup
    }
    throw error;
  }
}

export function readLinkOrNull(linkPath: string): string | null {
  try {
    return readlinkSync(linkPath);
  } catch {
    return null;
  }
}

export function readTextOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function uniqueTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
