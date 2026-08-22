import { UPSTREAM_NIGHTLY_TAG_PATTERN } from "./config.ts";

export interface DualIdentity {
  readonly upstreamVersion: string;
  readonly upstreamTag: string;
  readonly contextivityRevision: string;
}

export interface InstallIdentity extends DualIdentity {
  readonly installId: string;
}

const REVISION_PATTERN = /^[0-9a-f]{7,40}$/i;
const INSTALL_ID_PATTERN = /^(\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)-ctx\.([0-9a-f]{7,40})$/i;

export function stripTagPrefix(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function nightlyTagFromVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export function parseNightlyTag(tag: string): {
  readonly tag: string;
  readonly version: string;
  readonly date: string;
  readonly runNumber: number;
} | null {
  const match = UPSTREAM_NIGHTLY_TAG_PATTERN.exec(tag);
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  return {
    tag,
    version: match[1],
    date: match[2],
    runNumber: Number(match[3]),
  };
}

export function compareNightlyTags(
  left: { date: string; runNumber: number; version: string },
  right: { date: string; runNumber: number; version: string },
): number {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  if (left.runNumber !== right.runNumber) return left.runNumber - right.runNumber;
  if (left.version === right.version) return 0;
  return left.version < right.version ? -1 : 1;
}

export function formatInstallId(upstreamVersion: string, contextivityRevision: string): string {
  return `${upstreamVersion}-ctx.${contextivityRevision}`;
}

export function parseInstallId(installId: string): InstallIdentity | null {
  const match = INSTALL_ID_PATTERN.exec(installId);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const upstreamVersion = match[1];
  const contextivityRevision = match[2];
  return {
    upstreamVersion,
    upstreamTag: nightlyTagFromVersion(upstreamVersion),
    contextivityRevision,
    installId,
  };
}

export function assertRevision(revision: string): string {
  const trimmed = revision.trim();
  if (!REVISION_PATTERN.test(trimmed)) {
    throw new Error(`Invalid contextivityRevision '${revision}'. Use a git SHA (7-40 hex chars).`);
  }
  return trimmed.toLowerCase();
}

export function protocolVisibleVersion(identity: DualIdentity): string {
  return identity.upstreamVersion;
}

export function assertDualIdentity(input: {
  readonly upstreamVersion: string;
  readonly protocolVersion: string;
  readonly contextivityRevision: string;
}): DualIdentity {
  const parsed = parseNightlyTag(nightlyTagFromVersion(input.upstreamVersion));
  if (!parsed) {
    throw new Error(
      `upstreamVersion '${input.upstreamVersion}' is not an official T3 nightly version.`,
    );
  }
  if (input.protocolVersion !== input.upstreamVersion) {
    throw new Error(
      `Protocol-visible version '${input.protocolVersion}' must equal official upstream nightly '${input.upstreamVersion}'.`,
    );
  }
  const contextivityRevision = assertRevision(input.contextivityRevision);
  if (input.protocolVersion.includes("-ctx.")) {
    throw new Error("Protocol-visible version must not include a Contextivity revision suffix.");
  }
  return {
    upstreamVersion: parsed.version,
    upstreamTag: parsed.tag,
    contextivityRevision,
  };
}

export function assertPackageJsonKeepsUpstreamVersion(input: {
  readonly packageVersion: string;
  readonly upstreamVersion: string;
}): void {
  if (input.packageVersion !== input.upstreamVersion) {
    throw new Error(
      `apps/server package.json version '${input.packageVersion}' must stay the official upstream nightly '${input.upstreamVersion}'.`,
    );
  }
}
