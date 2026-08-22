import { parseNightlyTag } from "./identity.ts";
import type { UpstreamNightly } from "./upstream.ts";

export interface GitRunner {
  readonly fetchExactTag: (remote: string, tag: string) => Promise<void>;
  readonly revParse: (rev: string) => Promise<string>;
  readonly mergeCommit: (rev: string) => Promise<{ ok: true } | { ok: false; conflicts: string[] }>;
  readonly abortMerge: () => Promise<void>;
  readonly isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
  readonly readFileAt: (rev: string, filePath: string) => Promise<string>;
  readonly currentBranch: () => Promise<string>;
  readonly hasUncommittedChanges: () => Promise<boolean>;
}

export interface SyncSuccess {
  readonly ok: true;
  readonly tag: string;
  readonly upstreamCommit: string;
  readonly branch: string;
  readonly alreadyContained: boolean;
}

export interface SyncFailure {
  readonly ok: false;
  readonly tag: string;
  readonly reason: string;
  readonly conflicts: readonly string[];
  readonly failClosed: true;
  readonly publish: false;
  readonly advanceFleet: false;
}

export type SyncResult = SyncSuccess | SyncFailure;

export function failClosed(
  tag: string,
  reason: string,
  conflicts: readonly string[] = [],
): SyncFailure {
  return {
    ok: false,
    tag,
    reason,
    conflicts,
    failClosed: true,
    publish: false,
    advanceFleet: false,
  };
}

export async function syncExactUpstreamTag(input: {
  readonly git: GitRunner;
  readonly remote: string;
  readonly nightly: UpstreamNightly;
}): Promise<SyncResult> {
  const { git, remote, nightly } = input;
  if (!parseNightlyTag(nightly.tag)) {
    return failClosed(nightly.tag, "Not an official T3 nightly tag.");
  }
  if (await git.hasUncommittedChanges()) {
    return failClosed(nightly.tag, "Worktree is dirty; refusing to merge an upstream nightly.");
  }

  try {
    await git.fetchExactTag(remote, nightly.tag);
  } catch (cause) {
    return failClosed(
      nightly.tag,
      `Failed to fetch exact tag ${nightly.tag}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const resolvedCommit = (await git.revParse(`${nightly.tag}^{commit}`)).toLowerCase();
  if (resolvedCommit !== nightly.commit.toLowerCase()) {
    return failClosed(
      nightly.tag,
      `Fetched tag ${nightly.tag} is ${resolvedCommit}, expected ${nightly.commit}.`,
    );
  }

  let packageJson: string;
  try {
    packageJson = await git.readFileAt(nightly.tag, "apps/server/package.json");
  } catch (cause) {
    return failClosed(
      nightly.tag,
      `Could not read apps/server/package.json at ${nightly.tag}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let packageVersion: string;
  try {
    const parsed = JSON.parse(packageJson) as { version?: unknown };
    packageVersion = typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return failClosed(nightly.tag, "apps/server/package.json at the tag is not valid JSON.");
  }
  if (packageVersion !== nightly.version) {
    return failClosed(
      nightly.tag,
      `Tag ${nightly.tag} package version is '${packageVersion}', expected '${nightly.version}'.`,
    );
  }

  const head = await git.revParse("HEAD");
  const alreadyContained = await git.isAncestor(resolvedCommit, head);
  const branch = await git.currentBranch();
  if (alreadyContained) {
    return {
      ok: true,
      tag: nightly.tag,
      upstreamCommit: resolvedCommit,
      branch,
      alreadyContained: true,
    };
  }

  const merge = await git.mergeCommit(nightly.tag);
  if (!merge.ok) {
    try {
      await git.abortMerge();
    } catch {
      // still fail closed; the worktree may need manual recovery
    }
    return failClosed(
      nightly.tag,
      `Merge of ${nightly.tag} conflicted. Prior fleet version stays active.`,
      merge.conflicts,
    );
  }

  return {
    ok: true,
    tag: nightly.tag,
    upstreamCommit: resolvedCommit,
    branch,
    alreadyContained: false,
  };
}

export function syncFailureIssueTitle(tag: string): string {
  return `Contextivity T3 nightly sync failed: ${tag}`;
}

export function syncFailureIssueBody(failure: SyncFailure): string {
  const conflictLines =
    failure.conflicts.length === 0
      ? "- (no conflict paths reported)"
      : failure.conflicts.map((path) => `- \`${path}\``).join("\n");
  return [
    "The Contextivity downstream failed to replay an official `pingdotgg/t3code` nightly tag.",
    "",
    `- Tag: \`${failure.tag}\``,
    `- Reason: ${failure.reason}`,
    "- Fail-closed: the previous fleet pointer was not advanced and no candidate was published.",
    "",
    "Conflicts:",
    conflictLines,
    "",
    "Recover by resolving the patch stack against that exact tag, then re-run the candidate workflow with the same tag.",
  ].join("\n");
}
