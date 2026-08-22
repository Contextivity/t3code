import { PLATFORMS, SCHEMA_VERSION, isArtifactPlatform, type ArtifactPlatform } from "./config.ts";
import { sha256Text } from "./hash.ts";
import { assertDualIdentity, formatInstallId, type DualIdentity } from "./identity.ts";
import { parseJsonObject, stableStringify } from "./json.ts";

export const MANIFEST_KIND = "contextivity-t3-candidate" as const;

export interface ManifestArtifact {
  readonly platform: ArtifactPlatform;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ManifestCompatibility {
  readonly protocolVersion: string;
  readonly requiresExactClientVersion: true;
  readonly officialMacDesktop: "must-match-upstreamVersion";
  readonly upstreamNpmPackage: "forbidden";
}

export interface CandidateManifest extends DualIdentity {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly kind: typeof MANIFEST_KIND;
  readonly upstreamCommit: string;
  readonly buildRevision: string;
  readonly nodeEngine: string;
  readonly createdAt: string;
  readonly compatibility: ManifestCompatibility;
  readonly artifacts: readonly ManifestArtifact[];
}

export function comparePlatforms(left: ArtifactPlatform, right: ArtifactPlatform): number {
  return PLATFORMS.indexOf(left) - PLATFORMS.indexOf(right);
}

export { isArtifactPlatform };

export function normalizeArtifacts(artifacts: readonly ManifestArtifact[]): ManifestArtifact[] {
  const seen = new Set<string>();
  const normalized = artifacts.map((artifact) => {
    if (!isArtifactPlatform(artifact.platform)) {
      throw new Error(`Unknown artifact platform '${artifact.platform}'.`);
    }
    if (seen.has(artifact.platform)) {
      throw new Error(`Duplicate artifact for platform '${artifact.platform}'.`);
    }
    seen.add(artifact.platform);
    if (!/^[A-Za-z0-9._-]+$/u.test(artifact.name)) {
      throw new Error(`Unsafe artifact name '${artifact.name}'.`);
    }
    if (!Number.isInteger(artifact.size) || artifact.size < 0) {
      throw new Error(`Invalid size for ${artifact.name}.`);
    }
    if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
      throw new Error(`Invalid SHA-256 for ${artifact.name}.`);
    }
    return {
      platform: artifact.platform,
      name: artifact.name,
      size: artifact.size,
      sha256: artifact.sha256.toLowerCase(),
    };
  });
  return normalized.sort((left, right) => comparePlatforms(left.platform, right.platform));
}

export function buildCandidateManifest(input: {
  readonly upstreamVersion: string;
  readonly upstreamTag?: string;
  readonly upstreamCommit: string;
  readonly contextivityRevision: string;
  readonly buildRevision: string;
  readonly nodeEngine: string;
  readonly createdAt: string;
  readonly artifacts: readonly ManifestArtifact[];
}): CandidateManifest {
  const identity = assertDualIdentity({
    upstreamVersion: input.upstreamVersion,
    protocolVersion: input.upstreamVersion,
    contextivityRevision: input.contextivityRevision,
  });
  if (input.upstreamTag !== undefined && input.upstreamTag !== identity.upstreamTag) {
    throw new Error(
      `upstreamTag '${input.upstreamTag}' does not match nightly version '${identity.upstreamVersion}'.`,
    );
  }
  if (!/^[0-9a-f]{7,40}$/iu.test(input.upstreamCommit)) {
    throw new Error(`Invalid upstreamCommit '${input.upstreamCommit}'.`);
  }
  if (input.buildRevision.trim() === "") {
    throw new Error("buildRevision is required.");
  }
  if (input.nodeEngine.trim() === "") {
    throw new Error("nodeEngine is required.");
  }
  if (Number.isNaN(Date.parse(input.createdAt))) {
    throw new Error(`Invalid createdAt '${input.createdAt}'.`);
  }
  const artifacts = normalizeArtifacts(input.artifacts);
  if (artifacts.length === 0) {
    throw new Error("A candidate manifest must include at least one artifact.");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    upstreamVersion: identity.upstreamVersion,
    upstreamTag: identity.upstreamTag,
    upstreamCommit: input.upstreamCommit.toLowerCase(),
    contextivityRevision: identity.contextivityRevision,
    buildRevision: input.buildRevision.trim(),
    nodeEngine: input.nodeEngine.trim(),
    createdAt: new Date(input.createdAt).toISOString(),
    compatibility: {
      protocolVersion: identity.upstreamVersion,
      requiresExactClientVersion: true,
      officialMacDesktop: "must-match-upstreamVersion",
      upstreamNpmPackage: "forbidden",
    },
    artifacts,
  };
}

export function encodeManifest(manifest: CandidateManifest): string {
  return stableStringify(manifest);
}

export function manifestDigest(manifest: CandidateManifest): string {
  return sha256Text(encodeManifest(manifest));
}

export function decodeManifest(text: string): CandidateManifest {
  const raw = parseJsonObject(text, "candidate manifest");
  if (raw["schemaVersion"] !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported manifest schemaVersion '${String(raw["schemaVersion"])}'. Expected ${SCHEMA_VERSION}.`,
    );
  }
  if (raw["kind"] !== MANIFEST_KIND) {
    throw new Error(`Unsupported manifest kind '${String(raw["kind"])}'.`);
  }
  const artifactsRaw = raw["artifacts"];
  if (!Array.isArray(artifactsRaw)) {
    throw new Error("Manifest artifacts must be an array.");
  }
  const artifacts: ManifestArtifact[] = artifactsRaw.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Manifest artifact ${index} is not an object.`);
    }
    const artifact = entry as Record<string, unknown>;
    return {
      platform: String(artifact["platform"] ?? ""),
      name: String(artifact["name"] ?? ""),
      size: Number(artifact["size"]),
      sha256: String(artifact["sha256"] ?? ""),
    } as ManifestArtifact;
  });
  const decoded = buildCandidateManifest({
    upstreamVersion: String(raw["upstreamVersion"] ?? ""),
    upstreamTag: typeof raw["upstreamTag"] === "string" ? raw["upstreamTag"] : undefined,
    upstreamCommit: String(raw["upstreamCommit"] ?? ""),
    contextivityRevision: String(raw["contextivityRevision"] ?? ""),
    buildRevision: String(raw["buildRevision"] ?? ""),
    nodeEngine: String(raw["nodeEngine"] ?? ""),
    createdAt: String(raw["createdAt"] ?? ""),
    artifacts,
  });
  const compatibility = raw["compatibility"];
  if (compatibility === null || typeof compatibility !== "object" || Array.isArray(compatibility)) {
    throw new Error("Manifest compatibility is required.");
  }
  const compat = compatibility as Record<string, unknown>;
  if (compat["protocolVersion"] !== decoded.upstreamVersion) {
    throw new Error("compatibility.protocolVersion must equal upstreamVersion.");
  }
  if (compat["upstreamNpmPackage"] !== "forbidden") {
    throw new Error("compatibility.upstreamNpmPackage must be 'forbidden'.");
  }
  if (compat["requiresExactClientVersion"] !== true) {
    throw new Error("compatibility.requiresExactClientVersion must be true.");
  }
  return decoded;
}

export function assertManifestDeterministic(manifest: CandidateManifest): void {
  const encoded = encodeManifest(manifest);
  const roundTrip = decodeManifest(encoded);
  if (encodeManifest(roundTrip) !== encoded) {
    throw new Error("Manifest encoding is not deterministic.");
  }
}

export function candidateReleaseTag(manifest: CandidateManifest): string {
  return `contextivity-candidate/${formatInstallId(
    manifest.upstreamVersion,
    manifest.contextivityRevision,
  )}`;
}

export function selectArtifact(
  manifest: CandidateManifest,
  platform: ArtifactPlatform,
): ManifestArtifact {
  const artifact = manifest.artifacts.find((entry) => entry.platform === platform);
  if (!artifact) {
    throw new Error(`Manifest ${manifest.upstreamTag} has no artifact for platform '${platform}'.`);
  }
  return artifact;
}
