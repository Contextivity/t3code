#!/usr/bin/env node
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { flagString, parseArgs } from "./args.ts";
import { isArtifactPlatform, type ArtifactPlatform } from "./config.ts";
import { formatChecksumFile, sha256File } from "./hash.ts";
import { parseNightlyTag } from "./identity.ts";
import { buildCandidateManifest, encodeManifest, type ManifestArtifact } from "./manifest.ts";

function requireValue(flags: ReturnType<typeof parseArgs>["flags"], name: string): string {
  const value = flagString(flags, name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

export function platformFromName(name: string): ArtifactPlatform {
  for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const) {
    if (name.includes(platform) && isArtifactPlatform(platform)) return platform;
  }
  throw new Error(`Cannot infer platform from artifact name '${name}'.`);
}

export async function writeCandidateManifestFromDir(input: {
  readonly tag: string;
  readonly sha: string;
  readonly dir: string;
  readonly buildRevision: string;
  readonly nodeEngine: string;
  readonly contextivityRevision: string;
  readonly createdAt?: string;
}): Promise<string> {
  const parsed = parseNightlyTag(input.tag.startsWith("v") ? input.tag : `v${input.tag}`);
  if (!parsed) {
    throw new Error(`Not an official nightly tag: ${input.tag}`);
  }
  const artifacts: ManifestArtifact[] = [];
  for (const name of readdirSync(input.dir).sort()) {
    if (!name.endsWith(".tar.gz")) continue;
    const filePath = join(input.dir, name);
    artifacts.push({
      platform: platformFromName(name),
      name,
      size: statSync(filePath).size,
      sha256: await sha256File(filePath),
    });
  }
  const manifest = buildCandidateManifest({
    upstreamVersion: parsed.version,
    upstreamTag: parsed.tag,
    upstreamCommit: input.sha,
    contextivityRevision: input.contextivityRevision,
    buildRevision: input.buildRevision,
    nodeEngine: input.nodeEngine,
    createdAt: input.createdAt ?? new Date().toISOString(),
    artifacts,
  });
  const encoded = encodeManifest(manifest);
  writeFileSync(join(input.dir, "manifest.json"), encoded);
  writeFileSync(join(input.dir, "SHA256SUMS"), formatChecksumFile(manifest.artifacts));
  return encoded;
}

const invoked =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invoked) {
  const parsed = parseArgs(process.argv.slice(2));
  writeCandidateManifestFromDir({
    tag: requireValue(parsed.flags, "tag"),
    sha: requireValue(parsed.flags, "sha"),
    dir: requireValue(parsed.flags, "dir"),
    buildRevision: requireValue(parsed.flags, "build-revision"),
    nodeEngine: requireValue(parsed.flags, "node-engine"),
    contextivityRevision: requireValue(parsed.flags, "contextivity-revision"),
  }).then(
    (encoded) => {
      process.stdout.write(encoded);
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
