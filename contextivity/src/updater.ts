import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CHECKSUMS_FILENAME,
  CONTEXTIVITY_HOME_ENV,
  CURRENT_LINK,
  DEFAULT_LAYOUT_ROOT,
  MANIFEST_FILENAME,
  MARKER_FILENAME,
  PREVIOUS_LINK,
} from "./config.ts";
import { atomicSymlink, atomicWriteFile, readLinkOrNull, readTextOrNull } from "./atomic.ts";
import { sha256File } from "./hash.ts";
import { formatInstallId, parseInstallId } from "./identity.ts";
import { decodeManifest, type CandidateManifest, selectArtifact } from "./manifest.ts";
import { detectHostPlatform } from "./platforms.ts";
import {
  attestationVerifyArgs,
  provenancePolicy,
  requireChecksumMatch,
  shouldVerifyAttestation,
} from "./provenance.ts";
import { containsUpstreamPackageFallback } from "./update-metadata.ts";

export interface UpdaterLayout {
  readonly root: string;
  readonly versionsDir: string;
  readonly currentLink: string;
  readonly previousLink: string;
}

export interface StagedVersion {
  readonly installId: string;
  readonly versionDir: string;
  readonly manifest: CandidateManifest;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface UpdaterCommands {
  readonly extractArchive: (archivePath: string, destination: string) => Promise<void>;
  readonly preflight: (versionDir: string) => Promise<CommandResult>;
  readonly restart?: () => Promise<CommandResult>;
  readonly health?: () => Promise<CommandResult>;
  readonly verifyAttestation?: (args: readonly string[]) => Promise<CommandResult>;
}

export function expandHome(pathValue: string, home: string = NodeOS.homedir()): string {
  if (pathValue === "~") return home;
  if (pathValue.startsWith("~/")) return NodePath.join(home, pathValue.slice(2));
  return pathValue;
}

export function resolveLayoutRoot(
  env: Record<string, string | undefined> = process.env,
  home: string = NodeOS.homedir(),
): string {
  const override = env[CONTEXTIVITY_HOME_ENV]?.trim();
  return NodePath.resolve(
    expandHome(override && override.length > 0 ? override : DEFAULT_LAYOUT_ROOT, home),
  );
}

export function layoutAt(root: string): UpdaterLayout {
  return {
    root,
    versionsDir: NodePath.join(root, "versions"),
    currentLink: NodePath.join(root, CURRENT_LINK),
    previousLink: NodePath.join(root, PREVIOUS_LINK),
  };
}

export function versionDirFor(layout: UpdaterLayout, installId: string): string {
  const parsed = parseInstallId(installId);
  if (!parsed) {
    throw new Error(`Invalid install id '${installId}'.`);
  }
  return NodePath.join(layout.versionsDir, parsed.installId);
}

export function currentInstallId(layout: UpdaterLayout): string | null {
  const target = readLinkOrNull(layout.currentLink);
  if (!target) return null;
  return parseInstallId(target.split("/").at(-1) ?? target)?.installId ?? null;
}

export function previousInstallId(layout: UpdaterLayout): string | null {
  const target = readLinkOrNull(layout.previousLink);
  if (!target) return null;
  return parseInstallId(target.split("/").at(-1) ?? target)?.installId ?? null;
}

export function writeDistributionMarker(versionDir: string, manifest: CandidateManifest): void {
  atomicWriteFile(
    NodePath.join(versionDir, MARKER_FILENAME),
    `${JSON.stringify(
      {
        upstreamVersion: manifest.upstreamVersion,
        contextivityRevision: manifest.contextivityRevision,
        protocolVersion: manifest.upstreamVersion,
        installId: formatInstallId(manifest.upstreamVersion, manifest.contextivityRevision),
      },
      null,
      2,
    )}\n`,
  );
}

export async function verifyStagedArtifact(input: {
  readonly archivePath: string;
  readonly expectedSha256: string;
  readonly expectedSize: number;
  readonly name: string;
}): Promise<void> {
  const stats = NodeFS.statSync(input.archivePath);
  if (stats.size !== input.expectedSize) {
    throw new Error(
      `Size mismatch for ${input.name}: expected ${input.expectedSize}, got ${stats.size}.`,
    );
  }
  const actual = await sha256File(input.archivePath);
  requireChecksumMatch({
    expectedSha256: input.expectedSha256,
    actualSha256: actual,
    name: input.name,
  });
}

export async function stageCandidate(input: {
  readonly layout: UpdaterLayout;
  readonly manifest: CandidateManifest;
  readonly archivePath: string;
  readonly commands: UpdaterCommands;
  readonly github: { readonly owner: string; readonly repo: string };
  readonly githubAuthenticated: boolean;
  readonly oidcAvailable: boolean;
  readonly processLike?: { readonly platform: string; readonly arch: string };
}): Promise<StagedVersion> {
  const platform = detectHostPlatform(input.processLike).platform;
  const artifact = selectArtifact(input.manifest, platform);
  // Manifest artifact hashes are authoritative. SHA256SUMS is published alongside
  // for humans and GitHub; staging never trusts that sidecar over the manifest.
  await verifyStagedArtifact({
    archivePath: input.archivePath,
    expectedSha256: artifact.sha256,
    expectedSize: artifact.size,
    name: artifact.name,
  });

  const policy = provenancePolicy({
    githubAuthenticated: input.githubAuthenticated,
    oidcAvailable: input.oidcAvailable,
  });
  if (shouldVerifyAttestation(policy)) {
    if (!input.commands.verifyAttestation) {
      throw new Error(
        "GitHub OIDC provenance is required but no attestation verifier is configured.",
      );
    }
    const result = await input.commands.verifyAttestation(
      attestationVerifyArgs({
        artifactPath: input.archivePath,
        owner: input.github.owner,
        repo: input.github.repo,
      }),
    );
    if (result.code !== 0) {
      throw new Error(`Provenance verification failed for ${artifact.name}.`);
    }
  }

  const installId = formatInstallId(
    input.manifest.upstreamVersion,
    input.manifest.contextivityRevision,
  );
  const versionDir = versionDirFor(input.layout, installId);
  NodeFS.mkdirSync(input.layout.versionsDir, { recursive: true });
  NodeFS.rmSync(versionDir, { recursive: true, force: true });
  NodeFS.mkdirSync(versionDir, { recursive: true });
  await input.commands.extractArchive(input.archivePath, versionDir);
  writeDistributionMarker(versionDir, input.manifest);
  atomicWriteFile(
    NodePath.join(versionDir, MANIFEST_FILENAME),
    `${JSON.stringify(input.manifest, null, 2)}\n`,
  );
  atomicWriteFile(
    NodePath.join(versionDir, CHECKSUMS_FILENAME),
    `${artifact.sha256}  ${artifact.name}\n`,
  );

  const preflight = await input.commands.preflight(versionDir);
  if (preflight.code !== 0) {
    NodeFS.rmSync(versionDir, { recursive: true, force: true });
    throw new Error(
      `Staged preflight failed for ${installId}: ${preflight.stderr || preflight.stdout}`.trim(),
    );
  }
  if (
    containsUpstreamPackageFallback(preflight.stdout) ||
    containsUpstreamPackageFallback(preflight.stderr)
  ) {
    NodeFS.rmSync(versionDir, { recursive: true, force: true });
    throw new Error("Staged server advertised an upstream npm package update path.");
  }

  return { installId, versionDir, manifest: input.manifest };
}

export function activateStaged(input: {
  readonly layout: UpdaterLayout;
  readonly installId: string;
}): { readonly current: string; readonly previous: string | null } {
  const versionDir = versionDirFor(input.layout, input.installId);
  if (!NodeFS.existsSync(versionDir)) {
    throw new Error(`Cannot activate ${input.installId}: staged directory is missing.`);
  }
  const previous = currentInstallId(input.layout);
  if (previous && previous !== input.installId) {
    atomicSymlink(input.layout.previousLink, NodePath.join("versions", previous));
  }
  atomicSymlink(input.layout.currentLink, NodePath.join("versions", input.installId));
  NodeFS.chmodSync(input.layout.root, 0o755);
  return { current: input.installId, previous };
}

export function rollbackCurrent(layout: UpdaterLayout): {
  readonly current: string;
  readonly rolledBackFrom: string;
} {
  const current = currentInstallId(layout);
  const previous = previousInstallId(layout);
  if (!current) {
    throw new Error("Nothing to roll back: current is unset.");
  }
  if (!previous) {
    throw new Error("Nothing to roll back: previous is unset.");
  }
  atomicSymlink(layout.currentLink, NodePath.join("versions", previous));
  atomicSymlink(layout.previousLink, NodePath.join("versions", current));
  return { current: previous, rolledBackFrom: current };
}

export async function activateAndVerify(input: {
  readonly layout: UpdaterLayout;
  readonly installId: string;
  readonly commands: UpdaterCommands;
}): Promise<{ readonly current: string; readonly previous: string | null }> {
  const switched = activateStaged(input);
  try {
    if (input.commands.restart) {
      const restart = await input.commands.restart();
      if (restart.code !== 0) {
        throw new Error(
          `Restart after activate failed: ${restart.stderr || restart.stdout}`.trim(),
        );
      }
    }
    if (input.commands.health) {
      const health = await input.commands.health();
      if (health.code !== 0) {
        throw new Error(
          `Health check after activate failed: ${health.stderr || health.stdout}`.trim(),
        );
      }
    }
    return switched;
  } catch (error) {
    if (switched.previous) {
      rollbackCurrent(input.layout);
    }
    throw error;
  }
}

export function updaterStatus(layout: UpdaterLayout): {
  readonly root: string;
  readonly current: string | null;
  readonly previous: string | null;
} {
  return {
    root: layout.root,
    current: currentInstallId(layout),
    previous: previousInstallId(layout),
  };
}

export function readInstalledManifest(layout: UpdaterLayout): CandidateManifest | null {
  const current = currentInstallId(layout);
  if (!current) return null;
  const text = readTextOrNull(NodePath.join(versionDirFor(layout, current), MANIFEST_FILENAME));
  return text ? decodeManifest(text) : null;
}
