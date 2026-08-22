import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  discoverUpstreamNightlies,
  findNamedUpstreamNightly,
  lsRemoteArgs,
  requireNamedUpstreamNightly,
  requireNewestUpstreamNightly,
  selectNewestNightly,
  upstreamRemoteUrl,
  validateTagIdentity,
} from "./upstream.ts";

const lsRemote = `
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa	refs/tags/v0.0.33-nightly.20260820.4
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb	refs/tags/v0.0.33-nightly.20260820.4^{}
cccccccccccccccccccccccccccccccccccccccc	refs/tags/v0.0.34-nightly.20260822.2
dddddddddddddddddddddddddddddddddddddddd	refs/tags/v0.0.34
eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee	refs/tags/v0.0.34-nightly.20260822.1
`;

NodeTest.describe("upstream nightly selection", () => {
  NodeTest.it(
    "selects the newest official nightly tag, ignoring stable tags and peeled refs",
    () => {
      const nightlies = discoverUpstreamNightlies(lsRemote);
      NodeAssert.equal(nightlies.length, 3);
      const newest = selectNewestNightly(nightlies);
      NodeAssert.equal(newest?.tag, "v0.0.34-nightly.20260822.2");
      NodeAssert.equal(newest?.commit, "c".repeat(40));
      NodeAssert.equal(requireNewestUpstreamNightly(lsRemote).tag, "v0.0.34-nightly.20260822.2");
    },
  );

  NodeTest.it("does not track arbitrary newer main commits without a nightly tag", () => {
    NodeAssert.equal(
      discoverUpstreamNightlies("ffff\trefs/heads/main\n1111\trefs/tags/v0.0.34\n").length,
      0,
    );
    NodeAssert.throws(() => requireNewestUpstreamNightly(""));
  });

  NodeTest.it("validates tag/version/commit identity", () => {
    const expected = requireNewestUpstreamNightly(lsRemote);
    validateTagIdentity({
      expected,
      resolvedCommit: expected.commit,
      packageVersion: expected.version,
    });
    NodeAssert.throws(() =>
      validateTagIdentity({
        expected,
        resolvedCommit: "0".repeat(40),
        packageVersion: expected.version,
      }),
    );
    NodeAssert.throws(() =>
      validateTagIdentity({
        expected,
        resolvedCommit: expected.commit,
        packageVersion: "0.0.1",
      }),
    );
  });

  NodeTest.it("looks up an exact requested nightly tag, including older than newest", () => {
    const older = findNamedUpstreamNightly(lsRemote, "v0.0.33-nightly.20260820.4");
    NodeAssert.equal(older?.tag, "v0.0.33-nightly.20260820.4");
    NodeAssert.equal(older?.commit, "b".repeat(40));
    NodeAssert.equal(
      requireNamedUpstreamNightly(lsRemote, "0.0.34-nightly.20260822.1").commit,
      "e".repeat(40),
    );
    NodeAssert.equal(findNamedUpstreamNightly(lsRemote, "v0.0.34"), null);
    NodeAssert.throws(() => requireNamedUpstreamNightly(lsRemote, "v0.0.99-nightly.20260822.1"));
  });

  NodeTest.it("points ls-remote at the official upstream repository", () => {
    NodeAssert.equal(upstreamRemoteUrl(), "https://github.com/pingdotgg/t3code.git");
    NodeAssert.deepEqual(lsRemoteArgs(upstreamRemoteUrl()), [
      "ls-remote",
      "--tags",
      "https://github.com/pingdotgg/t3code.git",
      "refs/tags/v*-nightly.*",
    ]);
  });
});
