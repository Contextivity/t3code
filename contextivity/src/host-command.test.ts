import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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

describe("host command encoding", () => {
  it("round-trips spaces, quotes, and shell metacharacters as a single token", () => {
    for (const command of [
      quotedRestart,
      healthWithFlags,
      "systemctl --user restart contextivity-t3",
      `echo 'a; b | c && $HOME' > /tmp/x`,
    ]) {
      const encoded = encodeHostCommandArg(command);
      assert.match(encoded, /^[A-Za-z0-9_-]+$/);
      assert.equal(encoded.includes(" "), false);
      assert.equal(decodeHostCommandArg(encoded), command);
    }
  });

  it("rejects truncated or non-canonical encodings", () => {
    assert.throws(() => decodeHostCommandArg("not-valid"), /invalid/);
    assert.throws(() => decodeHostCommandArg("abc+def"), /invalid/);
    assert.throws(() => decodeHostCommandArg(""), /invalid/);
  });
});

describe("host command flags", () => {
  it("decodes encoded flags and still accepts plain direct-CLI flags", () => {
    assert.equal(
      hostCommandFromFlags(
        { [RESTART_COMMAND_B64_FLAG]: encodeHostCommandArg(quotedRestart) },
        "restart",
      ),
      quotedRestart,
    );
    assert.equal(
      hostCommandFromFlags({ "health-command": healthWithFlags }, "health"),
      healthWithFlags,
    );
  });
});

describe("encoded command callback invocation", () => {
  it("runs the original quoted command string through sh -c", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-host-cmd-"));
    const marker = join(dir, "restarted");
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
    assert.equal(restart, restartCommand);
    const restarted = await runBoundedHostCommand(restart ?? "", HOST_RESTART_TIMEOUT_MS);
    const healthy = await runBoundedHostCommand(health ?? "", HOST_HEALTH_TIMEOUT_MS);
    assert.equal(restarted.code, 0);
    assert.equal(healthy.code, 0);
    assert.equal(readFileSync(marker, "utf8"), "kickstart 'builder'; done");
    assert.equal(healthy.stdout, "ok");
  });
});
