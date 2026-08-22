import type { Channel } from "./config.ts";
import { formatInstallId } from "./identity.ts";
import type { CandidateManifest } from "./manifest.ts";

export interface PromotionRequest {
  readonly channel: Exclude<Channel, "candidate">;
  readonly manifest: CandidateManifest;
  readonly macClientVersion: string;
  readonly requestedInstallId?: string;
}

export interface PromotionSuccess {
  readonly ok: true;
  readonly channel: Exclude<Channel, "candidate">;
  readonly installId: string;
  readonly upstreamVersion: string;
  readonly contextivityRevision: string;
}

export interface PromotionFailure {
  readonly ok: false;
  readonly reason: string;
  readonly failClosed: true;
  readonly advanceFleet: false;
}

export type PromotionResult = PromotionSuccess | PromotionFailure;

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/u, "");
}

export function assertExactMacClientMatch(input: {
  readonly macClientVersion: string;
  readonly upstreamVersion: string;
}): void {
  const client = normalizeVersion(input.macClientVersion);
  const upstream = normalizeVersion(input.upstreamVersion);
  if (client.length === 0) {
    throw new Error(
      "Official Mac desktop version is required for promotion. Promotion fails closed on mismatch or missing confirmation.",
    );
  }
  if (client !== upstream) {
    throw new Error(
      `Official Mac desktop version '${client}' does not match manifest upstreamVersion '${upstream}'. Promotion fails closed; the desktop app was not modified.`,
    );
  }
}

export function promoteCandidate(request: PromotionRequest): PromotionResult {
  try {
    if (request.channel !== "nightly" && request.channel !== "stable") {
      return {
        ok: false,
        reason: `Cannot promote to channel '${String(request.channel)}'.`,
        failClosed: true,
        advanceFleet: false,
      };
    }
    assertExactMacClientMatch({
      macClientVersion: request.macClientVersion,
      upstreamVersion: request.manifest.upstreamVersion,
    });
    const installId = formatInstallId(
      request.manifest.upstreamVersion,
      request.manifest.contextivityRevision,
    );
    if (request.requestedInstallId && request.requestedInstallId !== installId) {
      return {
        ok: false,
        reason: `Requested identity '${request.requestedInstallId}' does not match candidate '${installId}'.`,
        failClosed: true,
        advanceFleet: false,
      };
    }
    if (request.manifest.compatibility.upstreamNpmPackage !== "forbidden") {
      return {
        ok: false,
        reason: "Candidate compatibility allows upstream npm package fallback.",
        failClosed: true,
        advanceFleet: false,
      };
    }
    return {
      ok: true,
      channel: request.channel,
      installId,
      upstreamVersion: request.manifest.upstreamVersion,
      contextivityRevision: request.manifest.contextivityRevision,
    };
  } catch (cause) {
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
      failClosed: true,
      advanceFleet: false,
    };
  }
}

export interface ChannelPointer {
  readonly schemaVersion: 1;
  readonly channel: Exclude<Channel, "candidate">;
  readonly candidateTag: string;
  readonly installId: string;
  readonly upstreamVersion: string;
  readonly contextivityRevision: string;
  readonly promotedAt: string;
}

export function buildChannelPointer(input: {
  readonly channel: Exclude<Channel, "candidate">;
  readonly candidateTag: string;
  readonly installId: string;
  readonly upstreamVersion: string;
  readonly contextivityRevision: string;
  readonly promotedAt: string;
}): ChannelPointer {
  return {
    schemaVersion: 1,
    channel: input.channel,
    candidateTag: input.candidateTag,
    installId: input.installId,
    upstreamVersion: input.upstreamVersion,
    contextivityRevision: input.contextivityRevision,
    promotedAt: new Date(input.promotedAt).toISOString(),
  };
}
