import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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
  artifacts: [
    {
      platform: "linux-x64",
      name: "t3-server-linux-x64.tar.gz",
      size: 1,
      sha256: "a".repeat(64),
    },
  ],
});

describe("candidate GitHub release identity", () => {
  it("uses an immutable candidate tag and never puts tokens on gh argv", () => {
    const tag = candidateReleaseTag(manifest);
    assert.equal(tag, "contextivity-candidate/0.0.34-nightly.20260822.2-ctx.abc1234");
    const notes = candidateReleaseNotes(manifest);
    const dir = mkdtempSync(join(tmpdir(), "ctx-rel-"));
    const asset = join(dir, "manifest.json");
    writeFileSync(asset, "{}");
    const create = ghReleaseCreateArgs({
      tag,
      repo: "Contextivity/t3code",
      title: "Contextivity candidate",
      notes,
      files: [asset],
    });
    assert.equal(create[0], "release");
    assert.equal(create[1], "create");
    assert.equal(create.includes("--latest=false"), true);
    assertGhArgvHasNoSecret(create, ["ghs_secret_token"]);
    assert.equal(
      ghReleaseDownloadArgs({
        tag,
        repo: "Contextivity/t3code",
        dir,
        pattern: "manifest.json",
      }).includes("ghs_secret_token"),
      false,
    );
    assert.equal(syncedWipRef("12345"), "refs/heads/contextivity-sync/12345");
  });

  it("pins exact versions and pointer channels without npm package names", () => {
    assert.deepEqual(resolveExactReleaseTag({ version: "0.0.34-nightly.20260822.2-ctx.abc1234" }), {
      tag: "contextivity-candidate/0.0.34-nightly.20260822.2-ctx.abc1234",
      installId: "0.0.34-nightly.20260822.2-ctx.abc1234",
      pointer: false,
    });
    assert.equal(resolveExactReleaseTag({ channel: "nightly" }).tag, "contextivity-nightly");
    assert.equal(resolveExactReleaseTag({ channel: "stable" }).pointer, true);
    assert.throws(() => resolveExactReleaseTag({}));
    assert.throws(() =>
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
