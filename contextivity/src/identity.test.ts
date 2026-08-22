import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertDualIdentity,
  assertPackageJsonKeepsUpstreamVersion,
  compareNightlyTags,
  formatInstallId,
  parseInstallId,
  parseNightlyTag,
  protocolVisibleVersion,
} from "./identity.ts";

describe("dual identity", () => {
  it("parses official nightly tags and rejects other tags", () => {
    assert.deepEqual(parseNightlyTag("v0.0.34-nightly.20260822.17"), {
      tag: "v0.0.34-nightly.20260822.17",
      version: "0.0.34-nightly.20260822.17",
      date: "20260822",
      runNumber: 17,
    });
    assert.equal(parseNightlyTag("v0.0.34"), null);
    assert.equal(parseNightlyTag("nightly-v0.0.34"), null);
    assert.equal(parseNightlyTag("v0.0.34-ctx.abc1234"), null);
  });

  it("orders nightlies by date then run number, not arbitrary main", () => {
    const older = parseNightlyTag("v0.0.33-nightly.20260821.90");
    const newer = parseNightlyTag("v0.0.34-nightly.20260822.1");
    const sameDayLater = parseNightlyTag("v0.0.34-nightly.20260822.2");
    assert.ok(older && newer && sameDayLater);
    assert.ok(compareNightlyTags(older, newer) < 0);
    assert.ok(compareNightlyTags(newer, sameDayLater) < 0);
  });

  it("keeps protocol-visible version equal to the official nightly", () => {
    const identity = assertDualIdentity({
      upstreamVersion: "0.0.34-nightly.20260822.17",
      protocolVersion: "0.0.34-nightly.20260822.17",
      contextivityRevision: "abc1234",
    });
    assert.equal(protocolVisibleVersion(identity), "0.0.34-nightly.20260822.17");
    assert.equal(identity.contextivityRevision, "abc1234");
    assert.equal(
      formatInstallId(identity.upstreamVersion, identity.contextivityRevision),
      "0.0.34-nightly.20260822.17-ctx.abc1234",
    );
    assert.equal(
      parseInstallId("0.0.34-nightly.20260822.17-ctx.abc1234")?.upstreamVersion,
      identity.upstreamVersion,
    );
  });

  it("fails closed when protocol version diverges or includes ctx suffix", () => {
    assert.throws(() =>
      assertDualIdentity({
        upstreamVersion: "0.0.34-nightly.20260822.17",
        protocolVersion: "0.0.34-nightly.20260822.17-ctx.abc1234",
        contextivityRevision: "abc1234",
      }),
    );
    assert.throws(() =>
      assertPackageJsonKeepsUpstreamVersion({
        packageVersion: "0.0.35-contextivity.1",
        upstreamVersion: "0.0.34-nightly.20260822.17",
      }),
    );
  });
});
