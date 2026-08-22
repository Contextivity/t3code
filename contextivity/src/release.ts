import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DOWNSTREAM_GITHUB, POINTER_TAGS } from "./config.ts";
import { parseInstallId } from "./identity.ts";
import { type CandidateManifest } from "./manifest.ts";
import { type ChannelPointer } from "./promote.ts";
import { containsUpstreamPackageFallback } from "./update-metadata.ts";

export function syncedWipRef(runId: string): string {
  if (!/^[0-9]+$/u.test(runId)) {
    throw new Error("Invalid GitHub run id for the synced merge ref.");
  }
  return `refs/heads/contextivity-sync/${runId}`;
}

export function ghRepoSlug(
  owner: string = DOWNSTREAM_GITHUB.owner,
  repo: string = DOWNSTREAM_GITHUB.repo,
): string {
  return `${owner}/${repo}`;
}

export function ghReleaseDownloadArgs(input: {
  readonly tag: string;
  readonly repo: string;
  readonly dir: string;
  readonly pattern: string;
}): readonly string[] {
  return [
    "release",
    "download",
    input.tag,
    "--repo",
    input.repo,
    "--dir",
    input.dir,
    "--pattern",
    input.pattern,
  ];
}

export function ghReleaseViewArgs(tag: string, repo: string): readonly string[] {
  return ["release", "view", tag, "--repo", repo];
}

export function ghReleaseCreateArgs(input: {
  readonly tag: string;
  readonly repo: string;
  readonly title: string;
  readonly notes: string;
  readonly files: readonly string[];
}): readonly string[] {
  if (
    containsUpstreamPackageFallback(input.notes) ||
    containsUpstreamPackageFallback(input.title)
  ) {
    throw new Error("Release notes must not mention the public npm t3 package.");
  }
  for (const file of input.files) {
    if (file.startsWith("-") || file.includes("--token") || file.includes("ghp_")) {
      throw new Error("Unsafe release asset path.");
    }
  }
  return [
    "release",
    "create",
    input.tag,
    ...input.files,
    "--repo",
    input.repo,
    "--title",
    input.title,
    "--notes",
    input.notes,
    "--prerelease",
    "--latest=false",
  ];
}

export function candidateReleaseNotes(manifest: CandidateManifest): string {
  return [
    `Immutable Contextivity candidate for official T3 ${manifest.upstreamVersion}.`,
    `Patch revision ${manifest.contextivityRevision}.`,
    "Install with t3-ctx updater update. Do not use the public npm t3 package.",
    "This is not a fleet pointer. Promote only after the official Mac desktop version matches.",
  ].join("\n");
}

export function candidateReleaseTitle(manifest: CandidateManifest): string {
  return `Contextivity candidate ${manifest.upstreamVersion}-ctx.${manifest.contextivityRevision}`;
}

export function assertGhArgvHasNoSecret(
  argv: readonly string[],
  secrets: readonly (string | null | undefined)[],
): void {
  for (const secret of secrets) {
    if (!secret) continue;
    if (argv.some((arg) => arg.includes(secret))) {
      throw new Error("GitHub token must not appear on the gh command line.");
    }
  }
}

export function releaseAssetFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && !name.startsWith("stage-"))
    .sort()
    .map((name) => join(dir, name));
}

export function resolveExactReleaseTag(input: {
  readonly version?: string;
  readonly channel?: string;
}): { readonly tag: string; readonly installId?: string; readonly pointer: boolean } {
  const version = input.version?.trim() ?? "";
  if (version.length > 0) {
    const parsed = parseInstallId(version);
    if (!parsed) {
      throw new Error(`Invalid install id '${version}'.`);
    }
    return {
      tag: `contextivity-candidate/${parsed.installId}`,
      installId: parsed.installId,
      pointer: false,
    };
  }
  if (input.channel === "nightly" || input.channel === "stable") {
    return { tag: POINTER_TAGS[input.channel], pointer: true };
  }
  if (input.channel === "candidate") {
    throw new Error("Channel 'candidate' requires --version <upstreamVersion-ctx.revision>.");
  }
  throw new Error("Pass --version <installId> or --channel nightly|stable.");
}

export function decodeChannelPointer(text: string): ChannelPointer {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const channel = raw["channel"];
  if (channel !== "nightly" && channel !== "stable") {
    throw new Error("Channel pointer must be nightly or stable.");
  }
  const installId = String(raw["installId"] ?? "");
  const parsed = parseInstallId(installId);
  if (!parsed) {
    throw new Error("Channel pointer installId is invalid.");
  }
  const candidateTag = String(raw["candidateTag"] ?? `contextivity-candidate/${parsed.installId}`);
  return {
    schemaVersion: 1,
    channel,
    candidateTag,
    installId: parsed.installId,
    upstreamVersion: String(raw["upstreamVersion"] ?? parsed.upstreamVersion),
    contextivityRevision: String(raw["contextivityRevision"] ?? parsed.contextivityRevision),
    promotedAt: String(raw["promotedAt"] ?? new Date().toISOString()),
  };
}
