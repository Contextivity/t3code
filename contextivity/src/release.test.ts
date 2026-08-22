import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { PLATFORMS } from "./config.ts";
import { buildCandidateManifest, candidateReleaseTag } from "./manifest.ts";
import {
  assertGhArgvHasNoSecret,
  candidateReleaseNotes,
  ghReleaseCreateArgs,
  ghReleaseDownloadArgs,
  resolveExactReleaseTag,
  syncedWipRef,
} from "./release.ts";

const manifest = buildCandidateManifest({
  upstreamVersion: "0.0.34-nightly.20260822.2",
  upstreamCommit: "c".repeat(40),
  contextivityRevision: "abc1234",
  buildRevision: "run-1",
  nodeEngine: ">=24",
  createdAt: "2026-08-22T00:00:00.000Z",
  artifacts: PLATFORMS.map((platform) => ({
    platform,
    name: `t3-server-${platform}.tar.gz`,
    size: 1,
    sha256: "a".repeat(64),
  })),
});

NodeTest.describe("candidate GitHub release identity", () => {
  NodeTest.it("uses an immutable candidate tag and never puts tokens on gh argv", () => {
    const tag = candidateReleaseTag(manifest);
    NodeAssert.equal(tag, "contextivity-candidate/0.0.34-nightly.20260822.2-ctx.abc1234");
    const notes = candidateReleaseNotes(manifest);
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctx-rel-"));
    const asset = NodePath.join(dir, "manifest.json");
    NodeFS.writeFileSync(asset, "{}");
    const create = ghReleaseCreateArgs({
      tag,
      repo: "Contextivity/t3code",
      title: "Contextivity candidate",
      notes,
      files: [asset],
    });
    NodeAssert.equal(create[0], "release");
    NodeAssert.equal(create[1], "create");
    NodeAssert.equal(create.includes("--latest=false"), true);
    assertGhArgvHasNoSecret(create, ["ghs_secret_token"]);
    NodeAssert.equal(
      ghReleaseDownloadArgs({
        tag,
        repo: "Contextivity/t3code",
        dir,
        pattern: "manifest.json",
      }).includes("ghs_secret_token"),
      false,
    );
    NodeAssert.equal(syncedWipRef("12345"), "refs/heads/contextivity-sync/12345");
  });

  NodeTest.it("pins exact versions and pointer channels without npm package names", () => {
    NodeAssert.deepEqual(
      resolveExactReleaseTag({ version: "0.0.34-nightly.20260822.2-ctx.abc1234" }),
      {
        tag: "contextivity-candidate/0.0.34-nightly.20260822.2-ctx.abc1234",
        installId: "0.0.34-nightly.20260822.2-ctx.abc1234",
        pointer: false,
      },
    );
    NodeAssert.equal(resolveExactReleaseTag({ channel: "nightly" }).tag, "contextivity-nightly");
    NodeAssert.equal(resolveExactReleaseTag({ channel: "stable" }).pointer, true);
    NodeAssert.throws(() => resolveExactReleaseTag({}));
    NodeAssert.throws(() =>
      ghReleaseCreateArgs({
        tag: "contextivity-candidate/x",
        repo: "Contextivity/t3code",
        title: "ok",
        notes: "npx t3@0.0.34",
        files: ["manifest.json"],
      }),
    );
  });
});
