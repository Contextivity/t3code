import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  assertDualIdentity,
  assertPackageJsonKeepsUpstreamVersion,
  compareNightlyTags,
  formatInstallId,
  parseInstallId,
  parseNightlyTag,
  protocolVisibleVersion,
} from "./identity.ts";

NodeTest.describe("dual identity", () => {
  NodeTest.it("parses official nightly tags and rejects other tags", () => {
    NodeAssert.deepEqual(parseNightlyTag("v0.0.34-nightly.20260822.17"), {
      tag: "v0.0.34-nightly.20260822.17",
      version: "0.0.34-nightly.20260822.17",
      date: "20260822",
      runNumber: 17,
    });
    NodeAssert.equal(parseNightlyTag("v0.0.34"), null);
    NodeAssert.equal(parseNightlyTag("nightly-v0.0.34"), null);
    NodeAssert.equal(parseNightlyTag("v0.0.34-ctx.abc1234"), null);
  });

  NodeTest.it("orders nightlies by date then run number, not arbitrary main", () => {
    const older = parseNightlyTag("v0.0.33-nightly.20260821.90");
    const newer = parseNightlyTag("v0.0.34-nightly.20260822.1");
    const sameDayLater = parseNightlyTag("v0.0.34-nightly.20260822.2");
    NodeAssert.ok(older && newer && sameDayLater);
    NodeAssert.ok(compareNightlyTags(older, newer) < 0);
    NodeAssert.ok(compareNightlyTags(newer, sameDayLater) < 0);
  });

  NodeTest.it("keeps protocol-visible version equal to the official nightly", () => {
    const identity = assertDualIdentity({
      upstreamVersion: "0.0.34-nightly.20260822.17",
      protocolVersion: "0.0.34-nightly.20260822.17",
      contextivityRevision: "abc1234",
    });
    NodeAssert.equal(protocolVisibleVersion(identity), "0.0.34-nightly.20260822.17");
    NodeAssert.equal(identity.contextivityRevision, "abc1234");
    NodeAssert.equal(
      formatInstallId(identity.upstreamVersion, identity.contextivityRevision),
      "0.0.34-nightly.20260822.17-ctx.abc1234",
    );
    NodeAssert.equal(
      parseInstallId("0.0.34-nightly.20260822.17-ctx.abc1234")?.upstreamVersion,
      identity.upstreamVersion,
    );
  });

  NodeTest.it("fails closed when protocol version diverges or includes ctx suffix", () => {
    NodeAssert.throws(() =>
      assertDualIdentity({
        upstreamVersion: "0.0.34-nightly.20260822.17",
        protocolVersion: "0.0.34-nightly.20260822.17-ctx.abc1234",
        contextivityRevision: "abc1234",
      }),
    );
    NodeAssert.throws(() =>
      assertPackageJsonKeepsUpstreamVersion({
        packageVersion: "0.0.35-contextivity.1",
        upstreamVersion: "0.0.34-nightly.20260822.17",
      }),
    );
  });
});
