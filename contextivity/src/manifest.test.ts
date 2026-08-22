import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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

NodeTest.describe("candidate manifest", () => {
  NodeTest.it("encodes a deterministic schema including dual identity and artifacts", () => {
    const manifest = sample();
    assertManifestDeterministic(manifest);
    const encoded = encodeManifest(manifest);
    const again = encodeManifest(decodeManifest(encoded));
    NodeAssert.equal(encoded, again);
    NodeAssert.equal(manifestDigest(manifest), sha256Text(encoded));
    NodeAssert.equal(manifest.compatibility.protocolVersion, manifest.upstreamVersion);
    NodeAssert.equal(manifest.compatibility.upstreamNpmPackage, "forbidden");
    NodeAssert.equal(
      candidateReleaseTag(manifest),
      "contextivity-candidate/0.0.34-nightly.20260822.2-ctx.def4567",
    );
    NodeAssert.deepEqual(
      manifest.artifacts.map((entry) => entry.platform),
      [...PLATFORMS],
    );
  });

  NodeTest.it("rejects missing, duplicate, or unsupported artifact platforms", () => {
    NodeAssert.throws(
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
    NodeAssert.throws(
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
    NodeAssert.throws(
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

  NodeTest.it(
    "constructs a candidate only when the directory has all four platform archives",
    async () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctx-manifest-dir-"));
      for (const platform of PLATFORMS) {
        NodeFS.writeFileSync(NodePath.join(dir, `t3-server-${platform}.tar.gz`), platform);
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
      NodeAssert.equal(written.artifacts.length, 4);
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(dir, "SHA256SUMS")), true);
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(dir, "manifest.json")), true);
      NodeAssert.match(
        NodeFS.readFileSync(NodePath.join(dir, "SHA256SUMS"), "utf8"),
        /t3-server-linux-x64\.tar\.gz/,
      );
      const incomplete = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "ctx-manifest-missing-"),
      );
      NodeFS.writeFileSync(NodePath.join(incomplete, "t3-server-linux-x64.tar.gz"), "only-one");
      await NodeAssert.rejects(
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
    },
  );

  NodeTest.it("rejects schema drift and protocol/version mismatch", () => {
    const encoded = encodeManifest(sample());
    NodeAssert.throws(() =>
      decodeManifest(encoded.replace('"schemaVersion": 1', '"schemaVersion": 2')),
    );
    NodeAssert.throws(() =>
      decodeManifest(
        encoded.replace('"upstreamNpmPackage": "forbidden"', '"upstreamNpmPackage": "allowed"'),
      ),
    );
  });

  NodeTest.it("selects the host platform artifact", () => {
    const manifest = sample();
    NodeAssert.equal(selectArtifact(manifest, "linux-x64").name, artifact.name);
    NodeAssert.equal(hostPlatformFromNode("linux", "arm64").platform, "linux-arm64");
    NodeAssert.equal(hostPlatformFromNode("darwin", "x64").platform, "darwin-x64");
    NodeAssert.equal(
      selectHostArtifact(manifest, { platform: "linux", arch: "x64" }).platform,
      "linux-x64",
    );
    NodeAssert.throws(() => detectHostPlatform({ platform: "win32", arch: "x64" }));
  });

  NodeTest.it("writes checksum files in sorted, sha256sum-compatible form", () => {
    const text = formatChecksumFile([
      { name: "b.tar.gz", sha256: "b".repeat(64) },
      { name: "a.tar.gz", sha256: "a".repeat(64) },
    ]);
    NodeAssert.equal(text.startsWith(`${"a".repeat(64)}  a.tar.gz\n`), true);
    NodeAssert.deepEqual(
      parseChecksumFile(text).map((entry) => entry.name),
      ["a.tar.gz", "b.tar.gz"],
    );
  });
});
