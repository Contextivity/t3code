import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { buildCandidateManifest } from "./manifest.ts";
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
  return mkdtempSync(join(tmpdir(), "ctx-updater-"));
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function manifestFor(sha: string, size: number) {
  return buildCandidateManifest({
    upstreamVersion: "0.0.34-nightly.20260822.2",
    upstreamCommit: "c".repeat(40),
    contextivityRevision: "abc1234",
    buildRevision: "run-1",
    nodeEngine: ">=24",
    createdAt: "2026-08-22T00:00:00.000Z",
    artifacts: [
      {
        platform: "linux-x64",
        name: "t3-server-linux-x64.tar.gz",
        size,
        sha256: sha,
      },
    ],
  });
}

describe("updater stage/activate/rollback", () => {
  it("stages after checksum verification, activates atomically, and rolls back", async () => {
    const root = tempRoot();
    const layout = layoutAt(root);
    const archivePath = join(root, "payload.tar.gz");
    const body = "archive-bytes";
    writeFileSync(archivePath, body);
    const manifest = manifestFor(sha256(body), body.length);
    const commands: UpdaterCommands = {
      extractArchive: async (_archive, destination) => {
        mkdirSync(join(destination, "dist"), { recursive: true });
        writeFileSync(join(destination, "dist/bin.mjs"), "export {};\n");
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
    assert.equal(staged.installId, "0.0.34-nightly.20260822.2-ctx.abc1234");

    const first = activateStaged({ layout, installId: staged.installId });
    assert.equal(first.current, staged.installId);
    assert.equal(updaterStatus(layout).current, staged.installId);

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
    writeFileSync(archivePath, body);
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
    assert.equal(rolled.current, staged.installId);
    assert.equal(rolled.rolledBackFrom, secondId);
  });

  it("requires provenance verification when GitHub is authenticated", async () => {
    const root = tempRoot();
    const layout = layoutAt(root);
    const archivePath = join(root, "payload.tar.gz");
    const body = "archive-bytes";
    writeFileSync(archivePath, body);
    const manifest = manifestFor(sha256(body), body.length);
    await assert.rejects(
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
          mkdirSync(join(destination, "dist"), { recursive: true });
          writeFileSync(join(destination, "dist/bin.mjs"), "export {};\n");
        },
        preflight: async () => ({ code: 0, stdout: "t3 help", stderr: "" }),
        verifyAttestation: async () => ({ code: 0, stdout: "ok", stderr: "" }),
      },
      github: { owner: "Contextivity", repo: "t3code" },
      githubAuthenticated: true,
      oidcAvailable: false,
      processLike: { platform: "linux", arch: "x64" },
    });
    assert.equal(staged.installId, "0.0.34-nightly.20260822.2-ctx.abc1234");
  });

  it("refuses checksum mismatches and failed preflight without activating", async () => {
    const root = tempRoot();
    const layout = layoutAt(root);
    const archivePath = join(root, "payload.tar.gz");
    writeFileSync(archivePath, "good");
    const manifest = manifestFor(sha256("other"), 4);
    await assert.rejects(
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
    assert.equal(updaterStatus(layout).current, null);
  });

  it("rolls back hosts that switched when health verification fails", async () => {
    const root = tempRoot();
    const layout = layoutAt(root);
    const archivePath = join(root, "payload.tar.gz");
    const body = "archive-bytes";
    writeFileSync(archivePath, body);
    const manifest = manifestFor(sha256(body), body.length);
    const commands: UpdaterCommands = {
      extractArchive: async (_archive, destination) => {
        mkdirSync(join(destination, "dist"), { recursive: true });
        writeFileSync(join(destination, "dist/bin.mjs"), "export {};\n");
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
    writeFileSync(archivePath, nextBody);
    const nextManifest = buildCandidateManifest({
      upstreamVersion: "0.0.35-nightly.20260823.1",
      upstreamCommit: "e".repeat(40),
      contextivityRevision: "eee2222",
      buildRevision: "run-3",
      nodeEngine: ">=24",
      createdAt: "2026-08-23T00:00:00.000Z",
      artifacts: [
        {
          platform: "linux-x64",
          name: "t3-server-linux-x64.tar.gz",
          size: nextBody.length,
          sha256: sha256(nextBody),
        },
      ],
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
    await assert.rejects(
      () =>
        activateAndVerify({
          layout,
          installId: "0.0.35-nightly.20260823.1-ctx.eee2222",
          commands,
        }),
      /Health check/,
    );
    assert.equal(updaterStatus(layout).current, staged.installId);
  });
});
