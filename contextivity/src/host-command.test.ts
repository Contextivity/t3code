import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { parseArgs } from "./args.ts";
import {
  decodeHostCommandArg,
  encodeHostCommandArg,
  HEALTH_COMMAND_B64_FLAG,
  hostCommandFromFlags,
  RESTART_COMMAND_B64_FLAG,
} from "./host-command.ts";
import { HOST_HEALTH_TIMEOUT_MS, HOST_RESTART_TIMEOUT_MS, runBoundedHostCommand } from "./spawn.ts";

const quotedRestart = `printf '%s' "kickstart 'builder'; done"`;
const healthWithFlags = "curl -sf --max-time 5 http://127.0.0.1:3001/health";

NodeTest.describe("host command encoding", () => {
  NodeTest.it("round-trips spaces, quotes, and shell metacharacters as a single token", () => {
    for (const command of [
      quotedRestart,
      healthWithFlags,
      "systemctl --user restart contextivity-t3",
      `echo 'a; b | c && $HOME' > /tmp/x`,
    ]) {
      const encoded = encodeHostCommandArg(command);
      NodeAssert.match(encoded, /^[A-Za-z0-9_-]+$/);
      NodeAssert.equal(encoded.includes(" "), false);
      NodeAssert.equal(decodeHostCommandArg(encoded), command);
    }
  });

  NodeTest.it("rejects truncated or non-canonical encodings", () => {
    NodeAssert.throws(() => decodeHostCommandArg("not-valid"), /invalid/);
    NodeAssert.throws(() => decodeHostCommandArg("abc+def"), /invalid/);
    NodeAssert.throws(() => decodeHostCommandArg(""), /invalid/);
  });
});

NodeTest.describe("host command flags", () => {
  NodeTest.it("decodes encoded flags and still accepts plain direct-CLI flags", () => {
    NodeAssert.equal(
      hostCommandFromFlags(
        { [RESTART_COMMAND_B64_FLAG]: encodeHostCommandArg(quotedRestart) },
        "restart",
      ),
      quotedRestart,
    );
    NodeAssert.equal(
      hostCommandFromFlags({ "health-command": healthWithFlags }, "health"),
      healthWithFlags,
    );
  });
});

NodeTest.describe("encoded command callback invocation", () => {
  NodeTest.it("runs the original quoted command string through sh -c", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctx-host-cmd-"));
    const marker = NodePath.join(dir, "restarted");
    const restartCommand = `printf '%s' "kickstart 'builder'; done" > '${marker}'`;
    const parsed = parseArgs([
      "updater",
      "activate",
      "--version",
      "id",
      `--${RESTART_COMMAND_B64_FLAG}`,
      encodeHostCommandArg(restartCommand),
      `--${HEALTH_COMMAND_B64_FLAG}`,
      encodeHostCommandArg("printf '%s' ok"),
    ]);
    const restart = hostCommandFromFlags(parsed.flags, "restart");
    const health = hostCommandFromFlags(parsed.flags, "health");
    NodeAssert.equal(restart, restartCommand);
    const restarted = await runBoundedHostCommand(restart ?? "", HOST_RESTART_TIMEOUT_MS);
    const healthy = await runBoundedHostCommand(health ?? "", HOST_HEALTH_TIMEOUT_MS);
    NodeAssert.equal(restarted.code, 0);
    NodeAssert.equal(healthy.code, 0);
    NodeAssert.equal(NodeFS.readFileSync(marker, "utf8"), "kickstart 'builder'; done");
    NodeAssert.equal(healthy.stdout, "ok");
  });
});
