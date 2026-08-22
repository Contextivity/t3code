import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORMS } from "./config.ts";
import {
  assertManifestDeterministic,
  buildCandidateManifest,
  candidateReleaseTag,
  decodeManifest,
  encodeManifest,
  manifestDigest,
  selectArtifact,
  type ManifestArtifact,
} from "./manifest.ts";
import { detectHostPlatform, hostPlatformFromNode, selectHostArtifact } from "./platforms.ts";
import { formatChecksumFile, parseChecksumFile, sha256Text } from "./hash.ts";
import { writeCandidateManifestFromDir } from "./write-candidate-manifest.ts";

const artifact = {
  platform: "linux-x64" as const,
  name: "t3-server-linux-x64.tar.gz",
  size: 12,
  sha256: "a".repeat(64),
};

function fourArtifacts(
  extra: readonly ManifestArtifact[] = [],
  omit: ReadonlySet<string> = new Set(),
): ManifestArtifact[] {
  const base: ManifestArtifact[] = PLATFORMS.filter((platform) => !omit.has(platform)).map(
    (platform, index) =>
      platform === "linux-x64"
        ? artifact
        : {
            platform,
            name: `t3-server-${platform}.tar.gz`,
            size: 10 + index,
            sha256: String.fromCharCode(98 + index).repeat(64),
          },
  );
  return [...base, ...extra];
}

function sample() {
  return buildCandidateManifest({
    upstreamVersion: "0.0.34-nightly.20260822.2",
    upstreamCommit: "c".repeat(40),
    contextivityRevision: "def4567",
    buildRevision: "github-run-99",
    nodeEngine: "^22.16 || ^23.11 || >=24.10",
    createdAt: "2026-08-22T12:00:00.000Z",
    artifacts: fourArtifacts(),
  });
}

describe("candidate manifest", () => {
  it("encodes a deterministic schema including dual identity and artifacts", () => {
    const manifest = sample();
    assertManifestDeterministic(manifest);
    const encoded = encodeManifest(manifest);
    const again = encodeManifest(decodeManifest(encoded));
    assert.equal(encoded, again);
    assert.equal(manifestDigest(manifest), sha256Text(encoded));
    assert.equal(manifest.compatibility.protocolVersion, manifest.upstreamVersion);
    assert.equal(manifest.compatibility.upstreamNpmPackage, "forbidden");
    assert.equal(
      candidateReleaseTag(manifest),
      "contextivity-candidate/0.0.34-nightly.20260822.2-ctx.def4567",
    );
    assert.deepEqual(
      manifest.artifacts.map((entry) => entry.platform),
      [...PLATFORMS],
    );
  });

  it("rejects missing, duplicate, or unsupported artifact platforms", () => {
    assert.throws(
      () =>
        buildCandidateManifest({
          upstreamVersion: "0.0.34-nightly.20260822.2",
          upstreamCommit: "c".repeat(40),
          contextivityRevision: "def4567",
          buildRevision: "github-run-99",
          nodeEngine: ">=24",
          createdAt: "2026-08-22T12:00:00.000Z",
          artifacts: fourArtifacts([], new Set(["darwin-x64"])),
        }),
      /exactly the four server platforms/,
    );
    assert.throws(
      () =>
        buildCandidateManifest({
          upstreamVersion: "0.0.34-nightly.20260822.2",
          upstreamCommit: "c".repeat(40),
          contextivityRevision: "def4567",
          buildRevision: "github-run-99",
          nodeEngine: ">=24",
          createdAt: "2026-08-22T12:00:00.000Z",
          artifacts: fourArtifacts([
            {
              platform: "linux-x64",
              name: "t3-server-linux-x64-dup.tar.gz",
              size: 1,
              sha256: "e".repeat(64),
            },
          ]),
        }),
      /Duplicate artifact/,
    );
    assert.throws(
      () =>
        buildCandidateManifest({
          upstreamVersion: "0.0.34-nightly.20260822.2",
          upstreamCommit: "c".repeat(40),
          contextivityRevision: "def4567",
          buildRevision: "github-run-99",
          nodeEngine: ">=24",
          createdAt: "2026-08-22T12:00:00.000Z",
          artifacts: [
            ...fourArtifacts(),
            {
              platform: "win32-x64" as ManifestArtifact["platform"],
              name: "t3-server-win32-x64.tar.gz",
              size: 1,
              sha256: "f".repeat(64),
            },
          ],
        }),
      /Unknown artifact platform/,
    );
  });

  it("constructs a candidate only when the directory has all four platform archives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-manifest-dir-"));
    for (const platform of PLATFORMS) {
      writeFileSync(join(dir, `t3-server-${platform}.tar.gz`), platform);
    }
    const encoded = await writeCandidateManifestFromDir({
      tag: "v0.0.34-nightly.20260822.2",
      sha: "c".repeat(40),
      dir,
      buildRevision: "run-1",
      nodeEngine: ">=24",
      contextivityRevision: "def4567",
      createdAt: "2026-08-22T12:00:00.000Z",
    });
    const written = decodeManifest(encoded);
    assert.equal(written.artifacts.length, 4);
    assert.equal(existsSync(join(dir, "SHA256SUMS")), true);
    assert.equal(existsSync(join(dir, "manifest.json")), true);
    assert.match(readFileSync(join(dir, "SHA256SUMS"), "utf8"), /t3-server-linux-x64\.tar\.gz/);
    const incomplete = mkdtempSync(join(tmpdir(), "ctx-manifest-missing-"));
    writeFileSync(join(incomplete, "t3-server-linux-x64.tar.gz"), "only-one");
    await assert.rejects(
      () =>
        writeCandidateManifestFromDir({
          tag: "v0.0.34-nightly.20260822.2",
          sha: "c".repeat(40),
          dir: incomplete,
          buildRevision: "run-1",
          nodeEngine: ">=24",
          contextivityRevision: "def4567",
        }),
      /exactly the four server platforms/,
    );
  });

  it("rejects schema drift and protocol/version mismatch", () => {
    const encoded = encodeManifest(sample());
    assert.throws(() =>
      decodeManifest(encoded.replace('"schemaVersion": 1', '"schemaVersion": 2')),
    );
    assert.throws(() =>
      decodeManifest(
        encoded.replace('"upstreamNpmPackage": "forbidden"', '"upstreamNpmPackage": "allowed"'),
      ),
    );
  });

  it("selects the host platform artifact", () => {
    const manifest = sample();
    assert.equal(selectArtifact(manifest, "linux-x64").name, artifact.name);
    assert.equal(hostPlatformFromNode("linux", "arm64").platform, "linux-arm64");
    assert.equal(hostPlatformFromNode("darwin", "x64").platform, "darwin-x64");
    assert.equal(
      selectHostArtifact(manifest, { platform: "linux", arch: "x64" }).platform,
      "linux-x64",
    );
    assert.throws(() => detectHostPlatform({ platform: "win32", arch: "x64" }));
  });

  it("writes checksum files in sorted, sha256sum-compatible form", () => {
    const text = formatChecksumFile([
      { name: "b.tar.gz", sha256: "b".repeat(64) },
      { name: "a.tar.gz", sha256: "a".repeat(64) },
    ]);
    assert.equal(text.startsWith(`${"a".repeat(64)}  a.tar.gz\n`), true);
    assert.deepEqual(
      parseChecksumFile(text).map((entry) => entry.name),
      ["a.tar.gz", "b.tar.gz"],
    );
  });
});
