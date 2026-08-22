import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeCrypto from "node:crypto";
import { PLATFORMS } from "./config.ts";
import { buildCandidateManifest, type ManifestArtifact } from "./manifest.ts";
import { HOST_HEALTH_TIMEOUT_MS, runBoundedHostCommand } from "./spawn.ts";
import {
  activateAndVerify,
  activateStaged,
  layoutAt,
  rollbackCurrent,
  stageCandidate,
  updaterStatus,
  type UpdaterCommands,
} from "./updater.ts";

function tempRoot(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctx-updater-"));
}

function sha256(contents: string): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

function artifactsFor(sha: string, size: number): ManifestArtifact[] {
  return PLATFORMS.map((platform, index) => ({
    platform,
    name: `t3-server-${platform}.tar.gz`,
    size: platform === "linux-x64" ? size : index + 1,
    sha256: platform === "linux-x64" ? sha : String.fromCharCode(98 + index).repeat(64),
  }));
}

function manifestFor(sha: string, size: number) {
  return buildCandidateManifest({
    upstreamVersion: "0.0.34-nightly.20260822.2",
    upstreamCommit: "c".repeat(40),
    contextivityRevision: "abc1234",
    buildRevision: "run-1",
    nodeEngine: ">=24",
    createdAt: "2026-08-22T00:00:00.000Z",
    artifacts: artifactsFor(sha, size),
  });
}

NodeTest.describe("updater stage/activate/rollback", () => {
  NodeTest.it(
    "stages after checksum verification, activates atomically, and rolls back",
    async () => {
      const root = tempRoot();
      const layout = layoutAt(root);
      const archivePath = NodePath.join(root, "payload.tar.gz");
      const body = "archive-bytes";
      NodeFS.writeFileSync(archivePath, body);
      const manifest = manifestFor(sha256(body), body.length);
      const commands: UpdaterCommands = {
        extractArchive: async (_archive, destination) => {
          NodeFS.mkdirSync(NodePath.join(destination, "dist"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(destination, "dist/bin.mjs"), "export {};\n");
        },
        preflight: async () => ({ code: 0, stdout: "t3 help", stderr: "" }),
      };

      const staged = await stageCandidate({
        layout,
        manifest,
        archivePath,
        commands,
        github: { owner: "Contextivity", repo: "t3code" },
        githubAuthenticated: false,
        oidcAvailable: false,
        processLike: { platform: "linux", arch: "x64" },
      });
      NodeAssert.equal(staged.installId, "0.0.34-nightly.20260822.2-ctx.abc1234");

      const first = activateStaged({ layout, installId: staged.installId });
      NodeAssert.equal(first.current, staged.installId);
      NodeAssert.equal(updaterStatus(layout).current, staged.installId);

      const secondId = "0.0.35-nightly.20260823.1-ctx.ddd1111";
      const secondManifest = buildCandidateManifest({
        upstreamVersion: "0.0.35-nightly.20260823.1",
        upstreamCommit: "d".repeat(40),
        contextivityRevision: "ddd1111",
        buildRevision: "run-2",
        nodeEngine: ">=24",
        createdAt: "2026-08-23T00:00:00.000Z",
        artifacts: manifest.artifacts,
      });
      NodeFS.writeFileSync(archivePath, body);
      await stageCandidate({
        layout,
        manifest: secondManifest,
        archivePath,
        commands,
        github: { owner: "Contextivity", repo: "t3code" },
        githubAuthenticated: false,
        oidcAvailable: false,
        processLike: { platform: "linux", arch: "x64" },
      });
      activateStaged({ layout, installId: secondId });
      const rolled = rollbackCurrent(layout);
      NodeAssert.equal(rolled.current, staged.installId);
      NodeAssert.equal(rolled.rolledBackFrom, secondId);
    },
  );

  NodeTest.it("requires provenance verification when GitHub is authenticated", async () => {
    const root = tempRoot();
    const layout = layoutAt(root);
    const archivePath = NodePath.join(root, "payload.tar.gz");
    const body = "archive-bytes";
    NodeFS.writeFileSync(archivePath, body);
    const manifest = manifestFor(sha256(body), body.length);
    await NodeAssert.rejects(
      () =>
        stageCandidate({
          layout,
          manifest,
          archivePath,
          commands: {
            extractArchive: async () => undefined,
            preflight: async () => ({ code: 0, stdout: "", stderr: "" }),
          },
          github: { owner: "Contextivity", repo: "t3code" },
          githubAuthenticated: true,
          oidcAvailable: false,
          processLike: { platform: "linux", arch: "x64" },
        }),
      /attestation verifier/,
    );
    const staged = await stageCandidate({
      layout,
      manifest,
      archivePath,
      commands: {
        extractArchive: async (_archive, destination) => {
          NodeFS.mkdirSync(NodePath.join(destination, "dist"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(destination, "dist/bin.mjs"), "export {};\n");
        },
        preflight: async () => ({ code: 0, stdout: "t3 help", stderr: "" }),
        verifyAttestation: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      },
      github: { owner: "Contextivity", repo: "t3code" },
      githubAuthenticated: true,
      oidcAvailable: false,
      processLike: { platform: "linux", arch: "x64" },
    });
    NodeAssert.equal(staged.installId, "0.0.34-nightly.20260822.2-ctx.abc1234");
  });

  NodeTest.it("refuses checksum mismatches and failed preflight without activating", async () => {
    const root = tempRoot();
    const layout = layoutAt(root);
    const archivePath = NodePath.join(root, "payload.tar.gz");
    NodeFS.writeFileSync(archivePath, "good");
    const manifest = manifestFor(sha256("other"), 4);
    await NodeAssert.rejects(
      () =>
        stageCandidate({
          layout,
          manifest,
          archivePath,
          commands: {
            extractArchive: async () => undefined,
            preflight: async () => ({ code: 0, stdout: "", stderr: "" }),
          },
          github: { owner: "Contextivity", repo: "t3code" },
          githubAuthenticated: false,
          oidcAvailable: false,
          processLike: { platform: "linux", arch: "x64" },
        }),
      /SHA-256 mismatch/,
    );
    NodeAssert.equal(updaterStatus(layout).current, null);
  });

  NodeTest.it("rolls back hosts that switched when health verification fails", async () => {
    const root = tempRoot();
    const layout = layoutAt(root);
    const archivePath = NodePath.join(root, "payload.tar.gz");
    const body = "archive-bytes";
    NodeFS.writeFileSync(archivePath, body);
    const manifest = manifestFor(sha256(body), body.length);
    const commands: UpdaterCommands = {
      extractArchive: async (_archive, destination) => {
        NodeFS.mkdirSync(NodePath.join(destination, "dist"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(destination, "dist/bin.mjs"), "export {};\n");
      },
      preflight: async () => ({ code: 0, stdout: "", stderr: "" }),
      health: async () => ({ code: 1, stdout: "", stderr: "unhealthy" }),
    };
    const staged = await stageCandidate({
      layout,
      manifest,
      archivePath,
      commands,
      github: { owner: "Contextivity", repo: "t3code" },
      githubAuthenticated: false,
      oidcAvailable: false,
      processLike: { platform: "linux", arch: "x64" },
    });
    activateStaged({ layout, installId: staged.installId });

    const nextBody = "next";
    NodeFS.writeFileSync(archivePath, nextBody);
    const nextManifest = buildCandidateManifest({
      upstreamVersion: "0.0.35-nightly.20260823.1",
      upstreamCommit: "e".repeat(40),
      contextivityRevision: "eee2222",
      buildRevision: "run-3",
      nodeEngine: ">=24",
      createdAt: "2026-08-23T00:00:00.000Z",
      artifacts: artifactsFor(sha256(nextBody), nextBody.length),
    });
    await stageCandidate({
      layout,
      manifest: nextManifest,
      archivePath,
      commands,
      github: { owner: "Contextivity", repo: "t3code" },
      githubAuthenticated: false,
      oidcAvailable: false,
      processLike: { platform: "linux", arch: "x64" },
    });
    await NodeAssert.rejects(
      () =>
        activateAndVerify({
          layout,
          installId: "0.0.35-nightly.20260823.1-ctx.eee2222",
          commands,
        }),
      /Health check/,
    );
    NodeAssert.equal(updaterStatus(layout).current, staged.installId);
  });

  NodeTest.it("rolls back when a bounded host health command fails", async () => {
    const root = tempRoot();
    const layout = layoutAt(root);
    const archivePath = NodePath.join(root, "payload.tar.gz");
    const body = "archive-bytes";
    NodeFS.writeFileSync(archivePath, body);
    const manifest = manifestFor(sha256(body), body.length);
    const commands: UpdaterCommands = {
      extractArchive: async (_archive, destination) => {
        NodeFS.mkdirSync(NodePath.join(destination, "dist"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(destination, "dist/bin.mjs"), "export {};\n");
      },
      preflight: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    const staged = await stageCandidate({
      layout,
      manifest,
      archivePath,
      commands,
      github: { owner: "Contextivity", repo: "t3code" },
      githubAuthenticated: false,
      oidcAvailable: false,
      processLike: { platform: "linux", arch: "x64" },
    });
    activateStaged({ layout, installId: staged.installId });

    const nextBody = "next-health";
    NodeFS.writeFileSync(archivePath, nextBody);
    const nextManifest = buildCandidateManifest({
      upstreamVersion: "0.0.35-nightly.20260823.1",
      upstreamCommit: "e".repeat(40),
      contextivityRevision: "eee2222",
      buildRevision: "run-3",
      nodeEngine: ">=24",
      createdAt: "2026-08-23T00:00:00.000Z",
      artifacts: artifactsFor(sha256(nextBody), nextBody.length),
    });
    await stageCandidate({
      layout,
      manifest: nextManifest,
      archivePath,
      commands,
      github: { owner: "Contextivity", repo: "t3code" },
      githubAuthenticated: false,
      oidcAvailable: false,
      processLike: { platform: "linux", arch: "x64" },
    });
    await NodeAssert.rejects(
      () =>
        activateAndVerify({
          layout,
          installId: "0.0.35-nightly.20260823.1-ctx.eee2222",
          commands: {
            ...commands,
            health: () => runBoundedHostCommand("exit 1", HOST_HEALTH_TIMEOUT_MS),
          },
        }),
      /Health check/,
    );
    NodeAssert.equal(updaterStatus(layout).current, staged.installId);
  });
});
