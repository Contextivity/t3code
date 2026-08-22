import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { CONTEXTIVITY_DISTRIBUTION_ENV, MARKER_FILENAME } from "./config.ts";
import { atomicWriteFile } from "./atomic.ts";
import { sha256File } from "./hash.ts";
import { formatInstallId } from "./identity.ts";
import type { ArtifactPlatform } from "./config.ts";
import { archiveFileName } from "./platforms.ts";
import { containsUpstreamPackageFallback } from "./update-metadata.ts";

export const SERVER_NATIVE_PACKAGE_PREFIXES = [
  "node-pty",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "@msgpackr-extract/",
  "msgpackr-extract",
  "node-gyp-build",
  "node-addon-api",
  "detect-libc",
] as const;

export interface PackedArtifact {
  readonly platform: ArtifactPlatform;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export function launchWrapper(entryRelativePath: string): string {
  return `#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
export ${CONTEXTIVITY_DISTRIBUTION_ENV}=1
export CONTEXTIVITY_T3_MARKER="$ROOT/${MARKER_FILENAME}"
exec node "$ROOT/${entryRelativePath}" "$@"
`;
}

export function writeLaunchWrapper(versionDir: string, entryRelativePath: string): void {
  const binDir = NodePath.join(versionDir, "bin");
  NodeFS.mkdirSync(binDir, { recursive: true });
  const wrapperPath = NodePath.join(binDir, "t3");
  atomicWriteFile(wrapperPath, launchWrapper(entryRelativePath), 0o755);
  NodeFS.chmodSync(wrapperPath, 0o755);
  if (containsUpstreamPackageFallback(launchWrapper(entryRelativePath))) {
    throw new Error("Launch wrapper must not mention upstream npm package t3@.");
  }
}

export function stageServerTree(input: {
  readonly stagingDir: string;
  readonly distDir: string;
  readonly nativeModuleDirs?: readonly string[];
  readonly upstreamVersion: string;
  readonly contextivityRevision: string;
}): void {
  NodeFS.rmSync(input.stagingDir, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(input.stagingDir, "dist"), { recursive: true });
  if (!NodeFS.existsSync(input.distDir)) {
    throw new Error(`Server dist directory is missing: ${input.distDir}`);
  }
  NodeFS.cpSync(input.distDir, NodePath.join(input.stagingDir, "dist"), { recursive: true });
  for (const nativeDir of input.nativeModuleDirs ?? []) {
    if (!NodeFS.existsSync(nativeDir)) continue;
    const name = nativeDir.split("/").at(-1);
    if (!name) continue;
    NodeFS.mkdirSync(NodePath.join(input.stagingDir, "node_modules"), { recursive: true });
    NodeFS.cpSync(nativeDir, NodePath.join(input.stagingDir, "node_modules", name), {
      recursive: true,
      dereference: true,
    });
  }
  writeLaunchWrapper(input.stagingDir, "dist/bin.mjs");
  atomicWriteFile(
    NodePath.join(input.stagingDir, MARKER_FILENAME),
    `${JSON.stringify(
      {
        upstreamVersion: input.upstreamVersion,
        contextivityRevision: input.contextivityRevision,
        protocolVersion: input.upstreamVersion,
        installId: formatInstallId(input.upstreamVersion, input.contextivityRevision),
      },
      null,
      2,
    )}\n`,
  );
}

export async function hashStagedArchive(
  archivePath: string,
  platform: ArtifactPlatform,
  installId: string,
): Promise<PackedArtifact> {
  const stats = NodeFS.statSync(archivePath);
  return {
    platform,
    name: archiveFileName(platform, installId),
    path: archivePath,
    size: stats.size,
    sha256: await sha256File(archivePath),
  };
}

export function tarCreateArgs(archivePath: string, stagingDir: string): readonly string[] {
  return ["-C", stagingDir, "-czf", archivePath, "."];
}

export function tarExtractArgs(archivePath: string, destination: string): readonly string[] {
  return ["-C", destination, "-xzf", archivePath];
}

export function nativePrefixesMatchUpstream(upstreamSource: string): boolean {
  return SERVER_NATIVE_PACKAGE_PREFIXES.every((prefix) => upstreamSource.includes(`"${prefix}"`));
}

export function collectNativeModuleDirs(repoRoot: string): string[] {
  const roots = [
    NodePath.join(repoRoot, "apps/server/node_modules"),
    NodePath.join(repoRoot, "node_modules"),
  ];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!NodeFS.existsSync(root)) continue;
    for (const prefix of SERVER_NATIVE_PACKAGE_PREFIXES) {
      const relative = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      if (seen.has(relative)) continue;
      const dir = NodePath.join(root, relative);
      if (!NodeFS.existsSync(dir)) continue;
      seen.add(relative);
      found.push(dir);
    }
  }
  return found;
}

export function requirePackedNodePty(nativeModuleDirs: readonly string[]): void {
  if (!nativeModuleDirs.some((dir) => dir.split("/").at(-1) === "node-pty")) {
    throw new Error(
      "node-pty is required in the server archive. Native addons are platform-specific; this is not a platform-neutral artifact.",
    );
  }
}
