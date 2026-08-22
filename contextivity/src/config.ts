export const SCHEMA_VERSION = 1 as const;

export const UPSTREAM_GITHUB = {
  owner: "pingdotgg",
  repo: "t3code",
} as const;

export const DOWNSTREAM_GITHUB = {
  owner: "Contextivity",
  repo: "t3code",
} as const;

export const UPSTREAM_NIGHTLY_TAG_PATTERN = /^v(\d+\.\d+\.\d+-nightly\.(\d{8})\.(\d+))$/;

export const CONTEXTIVITY_DISTRIBUTION_ENV = "CONTEXTIVITY_T3_DISTRIBUTION";
export const CONTEXTIVITY_HOME_ENV = "CONTEXTIVITY_T3_HOME";
export const CONTEXTIVITY_GITHUB_TOKEN_ENV = "CONTEXTIVITY_GITHUB_TOKEN";
export const CONTEXTIVITY_TRUST_MIRROR_ENV = "CONTEXTIVITY_T3_TRUST_MIRROR";
export const CONTEXTIVITY_GITHUB_API_ENV = "CONTEXTIVITY_T3_GITHUB_API";
export const CONTEXTIVITY_GITHUB_BASE_ENV = "CONTEXTIVITY_T3_GITHUB_BASE";

export const DEFAULT_GITHUB_API = "https://api.github.com";
export const DEFAULT_GITHUB_BASE = "https://github.com";

export const DEFAULT_LAYOUT_ROOT = "~/.contextivity/t3";
export const MARKER_FILENAME = "contextivity-distribution.json";
export const MANIFEST_FILENAME = "manifest.json";
export const CHECKSUMS_FILENAME = "SHA256SUMS";
export const CURRENT_LINK = "current";
export const PREVIOUS_LINK = "previous";

export const CHANNELS = ["candidate", "nightly", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];

export const POINTER_TAGS = {
  nightly: "contextivity-nightly",
  stable: "contextivity-stable",
} as const;

export const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;
export type ArtifactPlatform = (typeof PLATFORMS)[number];

export function isArtifactPlatform(value: string): value is ArtifactPlatform {
  return (PLATFORMS as readonly string[]).includes(value);
}

export const MAINTENANCE_ISSUE_LABEL = "contextivity-maintenance";

export const GENERIC_ACP_FOCUSED_TESTS = [
  "apps/server/src/provider/Layers/AcpRegistryAdapter.test.ts",
  "apps/server/src/provider/Layers/AcpRegistryProvider.test.ts",
  "apps/server/src/provider/acp/AcpAdapterSupport.test.ts",
  "apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts",
  "apps/server/src/provider/acp/AcpRegistrySupport.test.ts",
  "apps/server/src/provider/acp/AcpRuntimeModel.test.ts",
  "apps/server/src/provider/acp/AcpSessionRuntime.policy.test.ts",
  "apps/server/src/provider/acp/ContextivityAcpExtension.test.ts",
  "apps/server/src/provider/acp/ContextivityAcpSubagentMapper.test.ts",
  "packages/client-runtime/src/state/subagentRuntime.test.ts",
] as const;

export const CANDIDATE_SERVER_CHECKS = [
  "vp run --filter t3 typecheck",
  "vp run --filter t3 build",
] as const;

export const FORBIDDEN_UPSTREAM_PACKAGE_PATTERNS = [
  /\bnpx\s+t3@/u,
  /\bnpm\s+(?:i|install|exec)\s+t3@/u,
  /\bpnpm\s+(?:i|install|dlx)\s+t3@/u,
  /\bvpnpm\s+(?:i|install)\s+t3@/u,
] as const;
