import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeTwoPhase, gateFleetWithMacClient, planFleetUpdate } from "./fleet.ts";
import { decodeInventory } from "./inventory.ts";
import { buildCandidateManifest } from "./manifest.ts";

const inventory = decodeInventory(`{
  "schemaVersion": 1,
  "channel": "nightly",
  "hosts": [
    { "name": "workstation", "via": "local", "clientGate": true },
    { "name": "builder", "via": "ssh", "sshAlias": "builder" },
    { "name": "lab", "via": "ssh", "sshAlias": "lab" }
  ]
}`);

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

describe("fleet two-phase update", () => {
  it("resolves one identity and stages every host before activate", () => {
    const plan = planFleetUpdate({ inventory, manifest });
    assert.equal(plan.installId, "0.0.34-nightly.20260822.2-ctx.abc1234");
    assert.equal(plan.stage.length, 3);
    assert.equal(plan.activate.length, 3);
    assert.deepEqual(plan.stage[0]?.argv, [
      "t3-ctx",
      "updater",
      "update",
      "--version",
      plan.installId,
      "--stage-only",
    ]);
    assert.deepEqual(plan.stage[1]?.argv.slice(0, 3), ["ssh", "builder", "--"]);
  });

  it("activates none when any host fails staging", async () => {
    const plan = planFleetUpdate({ inventory, manifest });
    const activated: string[] = [];
    const result = await executeTwoPhase({
      plan,
      executor: {
        run: async (command) => {
          if (command.argv.includes("activate")) activated.push(command.host);
          if (command.host === "builder" && command.argv.includes("--stage-only")) {
            return { host: command.host, ok: false, detail: "stage failed" };
          }
          return { host: command.host, ok: true, detail: "ok" };
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.phase, "stage");
      assert.equal(result.activateNone, true);
      assert.equal(result.failedHost, "builder");
    }
    assert.deepEqual(activated, []);
  });

  it("rolls back every host that switched when activation fails", async () => {
    const plan = planFleetUpdate({ inventory, manifest });
    const events: string[] = [];
    const result = await executeTwoPhase({
      plan,
      executor: {
        run: async (command) => {
          events.push(`${command.host}:${command.argv.slice(-2).join(" ")}`);
          if (command.host === "lab" && command.argv.includes("activate")) {
            return { host: "lab", ok: false, detail: "health failed" };
          }
          return { host: command.host, ok: true, detail: "ok" };
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.phase, "activate");
      assert.deepEqual(result.rolledBack, ["builder", "workstation"]);
    }
  });

  it("fails closed when the official Mac client version does not match", () => {
    const mismatch = gateFleetWithMacClient({
      manifest,
      macClientVersion: "0.0.33-nightly.20260821.1",
    });
    assert.equal(mismatch.ok, false);
    const match = gateFleetWithMacClient({
      manifest,
      macClientVersion: "0.0.34-nightly.20260822.2",
    });
    assert.equal(match.ok, true);
  });
});
