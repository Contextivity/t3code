#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { flagString, parseArgs } from "./args.ts";
import { isArtifactPlatform } from "./config.ts";
import {
  collectNativeModuleDirs,
  requirePackedNodePty,
  stageServerTree,
  tarCreateArgs,
} from "./pack.ts";
import { spawnCommand } from "./spawn.ts";

function requireValue(flags: ReturnType<typeof parseArgs>["flags"], name: string): string {
  const value = flagString(flags, name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

export async function packServerArchive(input: {
  readonly repoRoot: string;
  readonly platform: string;
  readonly outDir: string;
  readonly upstreamVersion: string;
  readonly contextivityRevision: string;
}): Promise<string> {
  if (!isArtifactPlatform(input.platform)) {
    throw new Error(`Unknown platform '${input.platform}'.`);
  }
  const stagingDir = NodePath.join(input.outDir, `stage-${input.platform}`);
  const archivePath = NodePath.join(input.outDir, `t3-server-${input.platform}.tar.gz`);
  NodeFS.mkdirSync(input.outDir, { recursive: true });
  const nativeModuleDirs = collectNativeModuleDirs(input.repoRoot);
  requirePackedNodePty(nativeModuleDirs);
  stageServerTree({
    stagingDir,
    distDir: NodePath.join(input.repoRoot, "apps/server/dist"),
    nativeModuleDirs,
    upstreamVersion: input.upstreamVersion,
    contextivityRevision: input.contextivityRevision,
  });
  const tar = await spawnCommand({
    command: "tar",
    args: tarCreateArgs(archivePath, stagingDir),
    timeoutMs: 120_000,
  });
  if (tar.code !== 0) {
    throw new Error(tar.stderr.trim() || "tar create failed");
  }
  return archivePath;
}

const repoRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("../..", import.meta.url)));
const invoked =
  process.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1]);
if (invoked) {
  const parsed = parseArgs(process.argv.slice(2));
  packServerArchive({
    repoRoot,
    platform: requireValue(parsed.flags, "platform"),
    outDir: requireValue(parsed.flags, "out"),
    upstreamVersion: requireValue(parsed.flags, "upstream-version"),
    contextivityRevision: requireValue(parsed.flags, "contextivity-revision"),
  }).then(
    (archivePath) => {
      process.stdout.write(`${archivePath}\n`);
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
