import { PLATFORMS, type ArtifactPlatform } from "./config.ts";
import { type CandidateManifest, selectArtifact } from "./manifest.ts";

export interface HostPlatform {
  readonly os: "linux" | "darwin";
  readonly arch: "x64" | "arm64";
  readonly platform: ArtifactPlatform;
}

export function hostPlatformFromNode(nodePlatform: string, nodeArch: string): HostPlatform {
  const os = nodePlatform === "darwin" ? "darwin" : nodePlatform === "linux" ? "linux" : null;
  const arch = nodeArch === "arm64" ? "arm64" : nodeArch === "x64" ? "x64" : null;
  if (os === null || arch === null) {
    throw new Error(
      `Unsupported host '${nodePlatform}/${nodeArch}'. Downstream archives cover ${PLATFORMS.join(", ")} only.`,
    );
  }
  return { os, arch, platform: `${os}-${arch}` };
}

export function detectHostPlatform(
  processLike: { readonly platform: string; readonly arch: string } = process,
): HostPlatform {
  return hostPlatformFromNode(processLike.platform, processLike.arch);
}

export function archiveFileName(platform: ArtifactPlatform, installId: string): string {
  return `t3-server-${installId}-${platform}.tar.gz`;
}

export function runnerForPlatform(platform: ArtifactPlatform): {
  readonly os: "ubuntu-24.04" | "ubuntu-24.04-arm" | "macos-13" | "macos-14";
  readonly platform: ArtifactPlatform;
} {
  switch (platform) {
    case "linux-x64":
      return { os: "ubuntu-24.04", platform };
    case "linux-arm64":
      return { os: "ubuntu-24.04-arm", platform };
    case "darwin-x64":
      return { os: "macos-13", platform };
    case "darwin-arm64":
      return { os: "macos-14", platform };
  }
}

export function selectHostArtifact(
  manifest: CandidateManifest,
  processLike: { readonly platform: string; readonly arch: string } = process,
) {
  return selectArtifact(manifest, detectHostPlatform(processLike).platform);
}
