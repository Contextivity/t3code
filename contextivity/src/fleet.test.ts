import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
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
  NodeAssert.equal(argv[0], "ssh");
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

NodeTest.describe("fleet two-phase update", () => {
  NodeTest.it("resolves one identity and stages every host before activate", () => {
    const plan = planFleetUpdate({ inventory, manifest });
    NodeAssert.equal(plan.installId, "0.0.34-nightly.20260822.2-ctx.abc1234");
    NodeAssert.equal(plan.stage.length, 3);
    NodeAssert.equal(plan.activate.length, 3);
    NodeAssert.deepEqual(plan.stage[0]?.argv, [
      "t3-ctx",
      "updater",
      "update",
      "--version",
      plan.installId,
      "--stage-only",
    ]);
    NodeAssert.deepEqual(plan.stage[1]?.argv.slice(0, 3), ["ssh", "builder", "--"]);
  });

  NodeTest.it("passes each host restart and health command through remote activate", () => {
    const plan = planFleetUpdate({ inventory, manifest });
    const workstationRestart = encodeHostCommandArg("launchctl kickstart workstation");
    const workstationHealth = encodeHostCommandArg(
      "curl -sf --max-time 5 http://127.0.0.1:3000/health",
    );
    NodeAssert.deepEqual(plan.activate[0]?.argv, [
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
    NodeAssert.equal(plan.activate[1]?.argv.includes("launchctl kickstart builder"), false);
    NodeAssert.equal(plan.activate[2]?.argv.includes(`--${HEALTH_COMMAND_B64_FLAG}`), true);
    const lab = plan.activate[2];
    NodeAssert.ok(lab);
    const encodedRestart = lab.argv[lab.argv.indexOf(`--${RESTART_COMMAND_B64_FLAG}`) + 1];
    NodeAssert.equal(
      decodeHostCommandArg(encodedRestart ?? ""),
      "systemctl --user restart contextivity-t3",
    );
  });

  NodeTest.it("preserves quoted multi-word commands after SSH concatenates argv", () => {
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
    NodeAssert.equal(broken.flags["restart-command"], "printf");
    NodeAssert.notEqual(hostCommandFromFlags(broken.flags, "restart"), restartCommand);

    const encodedArgv = hostArgv(host, updaterActivateArgs(host, "id")).argv;
    NodeAssert.equal(
      encodedArgv.some((token) => token.includes(" ") || /[;|&$'"<>]/.test(token)),
      false,
    );
    const parsed = parseArgs(sshFlattenedRemoteArgv(encodedArgv).slice(1));
    NodeAssert.equal(hostCommandFromFlags(parsed.flags, "restart"), restartCommand);
    NodeAssert.equal(hostCommandFromFlags(parsed.flags, "health"), healthCommand);
  });

  NodeTest.it("activates none when any host fails staging", async () => {
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
    NodeAssert.equal(result.ok, false);
    if (!result.ok) {
      NodeAssert.equal(result.phase, "stage");
      NodeAssert.equal(result.activateNone, true);
      NodeAssert.equal(result.failedHost, "builder");
    }
    NodeAssert.deepEqual(activated, []);
  });

  NodeTest.it("rolls back every host that switched when activation fails", async () => {
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
    NodeAssert.equal(result.ok, false);
    if (!result.ok) {
      NodeAssert.equal(result.phase, "activate");
      NodeAssert.deepEqual(result.rolledBack, ["builder", "workstation"]);
    }
  });

  NodeTest.it("rolls back switched hosts when restart or health on activate fails", async () => {
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
    NodeAssert.equal(result.ok, false);
    if (!result.ok) {
      NodeAssert.equal(result.phase, "activate");
      NodeAssert.equal(result.failedHost, "builder");
      NodeAssert.deepEqual(result.rolledBack, ["workstation"]);
    }
  });

  NodeTest.it(
    "treats thrown activate/restart/health errors as host failure and rolls back",
    async () => {
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
      NodeAssert.equal(result.ok, false);
      if (!result.ok) {
        NodeAssert.equal(result.phase, "activate");
        NodeAssert.equal(result.failedHost, "lab");
        NodeAssert.equal(result.detail, "restart timed out");
        NodeAssert.deepEqual(result.rolledBack, ["builder", "workstation"]);
      }
    },
  );

  NodeTest.it("fails closed when the official Mac client version does not match", () => {
    const mismatch = gateFleetWithMacClient({
      manifest,
      macClientVersion: "0.0.33-nightly.20260821.1",
    });
    NodeAssert.equal(mismatch.ok, false);
    const match = gateFleetWithMacClient({
      manifest,
      macClientVersion: "0.0.34-nightly.20260822.2",
    });
    NodeAssert.equal(match.ok, true);
  });

  NodeTest.it("requires exactly one clientGate host in inventory", () => {
    NodeAssert.throws(
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
    NodeAssert.throws(
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

NodeTest.describe("direct t3-ctx fleet gate", () => {
  NodeTest.it("documents mac-client-version as required for fleet activation", () => {
    NodeAssert.match(usage(), /t3-ctx fleet update .* --mac-client-version <version>/);
    NodeAssert.equal(usage().includes("[--mac-client-version"), false);
  });

  NodeTest.it("fails closed without a verified official Mac desktop version", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctx-fleet-cli-"));
    const inventoryPath = NodePath.join(dir, "inventory.json");
    const manifestPath = NodePath.join(dir, "manifest.json");
    NodeFS.writeFileSync(
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
    NodeFS.writeFileSync(manifestPath, encodeManifest(manifest));
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
      NodeAssert.equal(missing, 2);
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
      NodeAssert.equal(mismatch, 2);
    } finally {
      if (previous === undefined) {
        delete process.env.CONTEXTIVITY_T3_MAC_CLIENT_VERSION;
      } else {
        process.env.CONTEXTIVITY_T3_MAC_CLIENT_VERSION = previous;
      }
    }
  });
});

NodeTest.describe("activate CLI command transport", () => {
  NodeTest.it("invokes decoded restart and health callbacks after SSH flattening", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctx-fleet-activate-"));
    const markers = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctx-fleet-markers-"));
    const restartMarker = NodePath.join(markers, "restarted");
    const healthMarker = NodePath.join(markers, "healthy");
    const archivePath = NodePath.join(root, "payload.tar.gz");
    const body = "archive-bytes";
    NodeFS.writeFileSync(archivePath, body);
    const sha = NodeCrypto.createHash("sha256").update(body).digest("hex");
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
          NodeFS.mkdirSync(NodePath.join(destination, "dist"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(destination, "dist/bin.mjs"), "export {};\n");
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
      NodeAssert.equal(code, 0);
    } finally {
      if (previousHome === undefined) {
        delete process.env[CONTEXTIVITY_HOME_ENV];
      } else {
        process.env[CONTEXTIVITY_HOME_ENV] = previousHome;
      }
    }
    NodeAssert.equal(NodeFS.readFileSync(restartMarker, "utf8"), "kickstart 'builder'; done");
    NodeAssert.equal(NodeFS.readFileSync(healthMarker, "utf8"), process.env.HOME);
  });
});
