import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";

export function atomicWriteFile(
  filePath: string,
  contents: string | Uint8Array,
  mode?: number,
): void {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const tempPath = NodePath.join(
    NodePath.dirname(filePath),
    `.${NodeCrypto.randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    NodeFS.writeFileSync(tempPath, contents);
    if (mode !== undefined) NodeFS.chmodSync(tempPath, mode);
    NodeFS.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      NodeFS.rmSync(tempPath, { force: true });
    } catch {
      // ignore cleanup
    }
    throw error;
  }
}

export function atomicSymlink(linkPath: string, target: string): void {
  NodeFS.mkdirSync(NodePath.dirname(linkPath), { recursive: true });
  const tempPath = NodePath.join(
    NodePath.dirname(linkPath),
    `.${NodeCrypto.randomBytes(8).toString("hex")}.tmp-link`,
  );
  try {
    NodeFS.symlinkSync(target, tempPath);
    NodeFS.renameSync(tempPath, linkPath);
  } catch (error) {
    try {
      NodeFS.rmSync(tempPath, { force: true });
    } catch {
      // ignore cleanup
    }
    throw error;
  }
}

export function readLinkOrNull(linkPath: string): string | null {
  try {
    return NodeFS.readlinkSync(linkPath);
  } catch {
    return null;
  }
}

export function readTextOrNull(filePath: string): string | null {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function uniqueTempDir(prefix: string): string {
  const dir = NodePath.join(
    NodeOS.tmpdir(),
    `${prefix}-${NodeCrypto.randomBytes(8).toString("hex")}`,
  );
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
}
