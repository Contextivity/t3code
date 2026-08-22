import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs, usage } from "./args.ts";
import { main } from "./cli.ts";
import { CONTEXTIVITY_HOME_ENV, PLATFORMS } from "./config.ts";
import {
  executeTwoPhase,
  gateFleetWithMacClient,
  hostArgv,
  planFleetUpdate,
  updaterActivateArgs,
} from "./fleet.ts";
import {
  decodeHostCommandArg,
  encodeHostCommandArg,
  HEALTH_COMMAND_B64_FLAG,
  hostCommandFromFlags,
  RESTART_COMMAND_B64_FLAG,
} from "./host-command.ts";
import { decodeInventory } from "./inventory.ts";
import { buildCandidateManifest, encodeManifest, type ManifestArtifact } from "./manifest.ts";
import { layoutAt, stageCandidate } from "./updater.ts";

const inventory = decodeInventory(`{
  "schemaVersion": 1,
  "channel": "nightly",
  "hosts": [
    {
      "name": "workstation",
      "via": "local",
      "clientGate": true,
      "restartCommand": "launchctl kickstart workstation",
      "healthCommand": "curl -sf --max-time 5 http://127.0.0.1:3000/health"
    },
    {
      "name": "builder",
      "via": "ssh",
      "sshAlias": "builder",
      "restartCommand": "launchctl kickstart builder",
      "healthCommand": "curl -sf --max-time 5 http://127.0.0.1:3001/health"
    },
    {
      "name": "lab",
      "via": "ssh",
      "sshAlias": "lab",
      "restartCommand": "systemctl --user restart contextivity-t3",
      "healthCommand": "curl -sf --max-time 5 http://127.0.0.1:3002/health"
    }
  ]
}`);

function fourArtifacts(): ManifestArtifact[] {
  return PLATFORMS.map((platform, index) => ({
    platform,
    name: `t3-server-${platform}.tar.gz`,
    size: index + 1,
    sha256: String.fromCharCode(97 + index).repeat(64),
  }));
}

function sshFlattenedRemoteArgv(argv: readonly string[]): string[] {
  assert.equal(argv[0], "ssh");
  const separator = argv.indexOf("--");
  const remote = argv.slice(separator === -1 ? 2 : separator + 1);
  return remote.join(" ").split(/\s+/);
}

const manifest = buildCandidateManifest({
  upstreamVersion: "0.0.34-nightly.20260822.2",
  upstreamCommit: "c".repeat(40),
  contextivityRevision: "abc1234",
  buildRevision: "run-1",
  nodeEngine: ">=24",
  createdAt: "2026-08-22T00:00:00.000Z",
  artifacts: fourArtifacts(),
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

  it("passes each host restart and health command through remote activate", () => {
    const plan = planFleetUpdate({ inventory, manifest });
    const workstationRestart = encodeHostCommandArg("launchctl kickstart workstation");
    const workstationHealth = encodeHostCommandArg(
      "curl -sf --max-time 5 http://127.0.0.1:3000/health",
    );
    assert.deepEqual(plan.activate[0]?.argv, [
      "t3-ctx",
      "updater",
      "activate",
      "--version",
      plan.installId,
      `--${RESTART_COMMAND_B64_FLAG}`,
      workstationRestart,
      `--${HEALTH_COMMAND_B64_FLAG}`,
      workstationHealth,
    ]);
    assert.equal(plan.activate[1]?.argv.includes("launchctl kickstart builder"), false);
    assert.equal(plan.activate[2]?.argv.includes(`--${HEALTH_COMMAND_B64_FLAG}`), true);
    const lab = plan.activate[2];
    assert.ok(lab);
    const encodedRestart = lab.argv[lab.argv.indexOf(`--${RESTART_COMMAND_B64_FLAG}`) + 1];
    assert.equal(
      decodeHostCommandArg(encodedRestart ?? ""),
      "systemctl --user restart contextivity-t3",
    );
  });

  it("preserves quoted multi-word commands after SSH concatenates argv", () => {
    const restartCommand = `printf '%s' "kickstart 'builder'; done"`;
    const healthCommand = "curl -sf --max-time 5 http://127.0.0.1:3001/health";
    const host = {
      name: "builder",
      via: "ssh" as const,
      sshAlias: "builder",
      restartCommand,
      healthCommand,
    };
    const rawBroken = [
      "ssh",
      "builder",
      "--",
      "t3-ctx",
      "updater",
      "activate",
      "--version",
      "id",
      "--restart-command",
      restartCommand,
      "--health-command",
      healthCommand,
    ];
    const broken = parseArgs(sshFlattenedRemoteArgv(rawBroken).slice(1));
    assert.equal(broken.flags["restart-command"], "printf");
    assert.notEqual(hostCommandFromFlags(broken.flags, "restart"), restartCommand);

    const encodedArgv = hostArgv(host, updaterActivateArgs(host, "id")).argv;
    assert.equal(
      encodedArgv.some((token) => token.includes(" ") || /[;|&$'"<>]/.test(token)),
      false,
    );
    const parsed = parseArgs(sshFlattenedRemoteArgv(encodedArgv).slice(1));
    assert.equal(hostCommandFromFlags(parsed.flags, "restart"), restartCommand);
    assert.equal(hostCommandFromFlags(parsed.flags, "health"), healthCommand);
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

  it("rolls back switched hosts when restart or health on activate fails", async () => {
    const plan = planFleetUpdate({ inventory, manifest });
    const result = await executeTwoPhase({
      plan,
      executor: {
        run: async (command) => {
          if (
            command.host === "builder" &&
            command.argv.includes("activate") &&
            command.argv.includes(`--${HEALTH_COMMAND_B64_FLAG}`)
          ) {
            return { host: command.host, ok: false, detail: "health command exited 1" };
          }
          return { host: command.host, ok: true, detail: "ok" };
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.phase, "activate");
      assert.equal(result.failedHost, "builder");
      assert.deepEqual(result.rolledBack, ["workstation"]);
    }
  });

  it("treats thrown activate/restart/health errors as host failure and rolls back", async () => {
    const plan = planFleetUpdate({ inventory, manifest });
    const result = await executeTwoPhase({
      plan,
      executor: {
        run: async (command) => {
          if (command.host === "lab" && command.argv.includes(`--${RESTART_COMMAND_B64_FLAG}`)) {
            throw new Error("restart timed out");
          }
          return { host: command.host, ok: true, detail: "ok" };
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.phase, "activate");
      assert.equal(result.failedHost, "lab");
      assert.equal(result.detail, "restart timed out");
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

  it("requires exactly one clientGate host in inventory", () => {
    assert.throws(
      () =>
        decodeInventory(`{
          "schemaVersion": 1,
          "channel": "nightly",
          "hosts": [
            { "name": "workstation", "via": "local" },
            { "name": "lab", "via": "ssh", "sshAlias": "lab" }
          ]
        }`),
      /clientGate/,
    );
    assert.throws(
      () =>
        decodeInventory(`{
          "schemaVersion": 1,
          "channel": "nightly",
          "hosts": [
            { "name": "workstation", "via": "local", "clientGate": true },
            { "name": "lab", "via": "ssh", "sshAlias": "lab", "clientGate": true }
          ]
        }`),
      /clientGate/,
    );
  });
});

describe("direct t3-ctx fleet gate", () => {
  it("documents mac-client-version as required for fleet activation", () => {
    assert.match(usage(), /t3-ctx fleet update .* --mac-client-version <version>/);
    assert.equal(usage().includes("[--mac-client-version"), false);
  });

  it("fails closed without a verified official Mac desktop version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-fleet-cli-"));
    const inventoryPath = join(dir, "inventory.json");
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      inventoryPath,
      JSON.stringify({
        schemaVersion: 1,
        channel: "nightly",
        hosts: [
          { name: "workstation", via: "local", clientGate: true },
          { name: "lab", via: "ssh", sshAlias: "lab" },
        ],
      }),
    );
    writeFileSync(manifestPath, encodeManifest(manifest));
    const previous = process.env.CONTEXTIVITY_T3_MAC_CLIENT_VERSION;
    delete process.env.CONTEXTIVITY_T3_MAC_CLIENT_VERSION;
    try {
      const missing = await main([
        "fleet",
        "update",
        "--inventory",
        inventoryPath,
        "--manifest",
        manifestPath,
      ]);
      assert.equal(missing, 2);
      const mismatch = await main([
        "fleet",
        "update",
        "--inventory",
        inventoryPath,
        "--manifest",
        manifestPath,
        "--mac-client-version",
        "0.0.1",
      ]);
      assert.equal(mismatch, 2);
    } finally {
      if (previous === undefined) {
        delete process.env.CONTEXTIVITY_T3_MAC_CLIENT_VERSION;
      } else {
        process.env.CONTEXTIVITY_T3_MAC_CLIENT_VERSION = previous;
      }
    }
  });
});

describe("activate CLI command transport", () => {
  it("invokes decoded restart and health callbacks after SSH flattening", async () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-fleet-activate-"));
    const markers = mkdtempSync(join(tmpdir(), "ctx-fleet-markers-"));
    const restartMarker = join(markers, "restarted");
    const healthMarker = join(markers, "healthy");
    const archivePath = join(root, "payload.tar.gz");
    const body = "archive-bytes";
    writeFileSync(archivePath, body);
    const sha = createHash("sha256").update(body).digest("hex");
    const stagedManifest = buildCandidateManifest({
      upstreamVersion: "0.0.34-nightly.20260822.2",
      upstreamCommit: "c".repeat(40),
      contextivityRevision: "abc1234",
      buildRevision: "run-1",
      nodeEngine: ">=24",
      createdAt: "2026-08-22T00:00:00.000Z",
      artifacts: PLATFORMS.map((platform, index) => ({
        platform,
        name: `t3-server-${platform}.tar.gz`,
        size: platform === "linux-x64" ? body.length : index + 1,
        sha256: platform === "linux-x64" ? sha : String.fromCharCode(98 + index).repeat(64),
      })),
    });
    const layout = layoutAt(root);
    await stageCandidate({
      layout,
      manifest: stagedManifest,
      archivePath,
      commands: {
        extractArchive: async (_archive, destination) => {
          mkdirSync(join(destination, "dist"), { recursive: true });
          writeFileSync(join(destination, "dist/bin.mjs"), "export {};\n");
        },
        preflight: async () => ({ code: 0, stdout: "t3 help", stderr: "" }),
      },
      github: { owner: "Contextivity", repo: "t3code" },
      githubAuthenticated: false,
      oidcAvailable: false,
      processLike: { platform: "linux", arch: "x64" },
    });

    const restartCommand = `printf '%s' "kickstart 'builder'; done" > '${restartMarker}'`;
    const healthCommand = `printf '%s' "$HOME" > '${healthMarker}'`;
    const host = {
      name: "builder",
      via: "ssh" as const,
      sshAlias: "builder",
      restartCommand,
      healthCommand,
    };
    const remote = sshFlattenedRemoteArgv(
      hostArgv(host, updaterActivateArgs(host, "0.0.34-nightly.20260822.2-ctx.abc1234")).argv,
    );
    const previousHome = process.env[CONTEXTIVITY_HOME_ENV];
    process.env[CONTEXTIVITY_HOME_ENV] = root;
    try {
      const code = await main(remote.slice(1));
      assert.equal(code, 0);
    } finally {
      if (previousHome === undefined) {
        delete process.env[CONTEXTIVITY_HOME_ENV];
      } else {
        process.env[CONTEXTIVITY_HOME_ENV] = previousHome;
      }
    }
    assert.equal(readFileSync(restartMarker, "utf8"), "kickstart 'builder'; done");
    assert.equal(readFileSync(healthMarker, "utf8"), process.env.HOME);
  });
});
