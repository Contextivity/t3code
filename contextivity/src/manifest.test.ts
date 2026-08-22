import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertManifestDeterministic,
  buildCandidateManifest,
  candidateReleaseTag,
  decodeManifest,
  encodeManifest,
  manifestDigest,
  selectArtifact,
} from "./manifest.ts";
import { detectHostPlatform, hostPlatformFromNode, selectHostArtifact } from "./platforms.ts";
import { formatChecksumFile, parseChecksumFile, sha256Text } from "./hash.ts";

const artifact = {
  platform: "linux-x64" as const,
  name: "t3-server-linux-x64.tar.gz",
  size: 12,
  sha256: "a".repeat(64),
};

function sample() {
  return buildCandidateManifest({
    upstreamVersion: "0.0.34-nightly.20260822.2",
    upstreamCommit: "c".repeat(40),
    contextivityRevision: "def4567",
    buildRevision: "github-run-99",
    nodeEngine: "^22.16 || ^23.11 || >=24.10",
    createdAt: "2026-08-22T12:00:00.000Z",
    artifacts: [
      artifact,
      {
        platform: "darwin-arm64",
        name: "t3-server-darwin-arm64.tar.gz",
        size: 10,
        sha256: "b".repeat(64),
      },
    ],
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
    assert.equal(manifest.artifacts[0]?.platform, "linux-x64");
    assert.equal(manifest.artifacts[1]?.platform, "darwin-arm64");
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
