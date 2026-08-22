import { DEFAULT_GITHUB_BASE, UPSTREAM_GITHUB } from "./config.ts";
import { compareNightlyTags, parseNightlyTag } from "./identity.ts";

export interface UpstreamNightly {
  readonly tag: string;
  readonly version: string;
  readonly date: string;
  readonly runNumber: number;
  readonly commit: string;
}

export interface LsRemoteEntry {
  readonly sha: string;
  readonly ref: string;
}

export function parseLsRemoteLine(line: string): LsRemoteEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const [sha, ref] = trimmed.split(/\s+/u);
  if (!sha || !ref || !/^[0-9a-f]{7,40}$/iu.test(sha)) return null;
  if (ref.endsWith("^{}")) return null;
  return { sha, ref };
}

export function nightlyFromRemoteRef(entry: LsRemoteEntry): UpstreamNightly | null {
  const prefix = "refs/tags/";
  if (!entry.ref.startsWith(prefix)) return null;
  const parsed = parseNightlyTag(entry.ref.slice(prefix.length));
  if (!parsed) return null;
  return {
    tag: parsed.tag,
    version: parsed.version,
    date: parsed.date,
    runNumber: parsed.runNumber,
    commit: entry.sha.toLowerCase(),
  };
}

export function selectNewestNightly(
  candidates: readonly UpstreamNightly[],
): UpstreamNightly | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((left, right) => compareNightlyTags(left, right)).at(-1) ?? null;
}

export function discoverUpstreamNightlies(lsRemoteOutput: string): UpstreamNightly[] {
  const peeled = new Map<string, string>();
  const tags = new Map<string, LsRemoteEntry>();
  for (const rawLine of lsRemoteOutput.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    const [sha, ref] = trimmed.split(/\s+/u);
    if (!sha || !ref || !/^[0-9a-f]{7,40}$/iu.test(sha)) continue;
    if (ref.endsWith("^{}")) {
      peeled.set(ref.slice(0, -3), sha.toLowerCase());
      continue;
    }
    const entry = parseLsRemoteLine(trimmed);
    if (!entry) continue;
    const nightly = nightlyFromRemoteRef(entry);
    if (nightly) tags.set(nightly.tag, entry);
  }
  const nightlies: UpstreamNightly[] = [];
  for (const entry of tags.values()) {
    const nightly = nightlyFromRemoteRef({
      sha: peeled.get(entry.ref) ?? entry.sha,
      ref: entry.ref,
    });
    if (nightly) nightlies.push(nightly);
  }
  return nightlies;
}

export function requireNewestUpstreamNightly(lsRemoteOutput: string): UpstreamNightly {
  const newest = selectNewestNightly(discoverUpstreamNightlies(lsRemoteOutput));
  if (!newest) {
    throw new Error(
      `No official nightly tags matching vX.Y.Z-nightly.YYYYMMDD.N were found on ${UPSTREAM_GITHUB.owner}/${UPSTREAM_GITHUB.repo}.`,
    );
  }
  return newest;
}

export function upstreamRemoteUrl(base: string = DEFAULT_GITHUB_BASE): string {
  return `${base.replace(/\/$/u, "")}/${UPSTREAM_GITHUB.owner}/${UPSTREAM_GITHUB.repo}.git`;
}

export function lsRemoteArgs(remoteUrl: string): readonly string[] {
  return ["ls-remote", "--tags", remoteUrl, "refs/tags/v*-nightly.*"];
}

export function validateTagIdentity(input: {
  readonly expected: UpstreamNightly;
  readonly resolvedCommit: string;
  readonly packageVersion: string;
  readonly isAncestorOfHead?: boolean;
}): void {
  if (input.resolvedCommit.toLowerCase() !== input.expected.commit.toLowerCase()) {
    throw new Error(
      `Tag ${input.expected.tag} resolved to ${input.resolvedCommit}, expected ${input.expected.commit}.`,
    );
  }
  if (input.packageVersion !== input.expected.version) {
    throw new Error(
      `Tag ${input.expected.tag} commit has package version '${input.packageVersion}', expected '${input.expected.version}'.`,
    );
  }
  if (input.isAncestorOfHead === false) {
    throw new Error(
      `Tag ${input.expected.tag} (${input.expected.commit}) is not an ancestor of the fetched tag commit. Refusing to guess ancestry.`,
    );
  }
}

export function findNamedUpstreamNightly(
  lsRemoteOutput: string,
  requested: string,
): UpstreamNightly | null {
  const tag = requested.startsWith("v") ? requested : `v${requested}`;
  const parsed = parseNightlyTag(tag);
  if (!parsed) return null;
  return discoverUpstreamNightlies(lsRemoteOutput).find((item) => item.tag === parsed.tag) ?? null;
}

export function requireNamedUpstreamNightly(
  lsRemoteOutput: string,
  requested: string,
): UpstreamNightly {
  const tag = requested.startsWith("v") ? requested : `v${requested}`;
  if (!parseNightlyTag(tag)) {
    throw new Error(
      `Requested tag '${requested}' is not an official T3 nightly tag (vX.Y.Z-nightly.YYYYMMDD.N).`,
    );
  }
  const match = findNamedUpstreamNightly(lsRemoteOutput, requested);
  if (!match) {
    throw new Error(`Requested nightly tag ${tag} was not found on upstream.`);
  }
  return match;
}
