import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "@t3tools/contracts";

import {
  buildInitialAcpRegistryProviderSnapshot,
  checkAcpRegistryProviderStatus,
} from "./AcpRegistryProvider.ts";

const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

const writeExecutable = Effect.fn("writeExecutable")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.writeFileString(filePath, contents);
  yield* fileSystem.chmod(filePath, 0o755);
});

const makeMockAgentWrapper = Effect.fn("makeMockAgentWrapper")(function* (input: {
  readonly prefix: string;
  readonly versionMode: "ok" | "fail";
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: input.prefix });
  const wrapperPath = path.join(dir, "fake-acp-agent.sh");
  const mockAgentCommand = [process.execPath, mockAgentPath]
    .map((arg) => JSON.stringify(arg))
    .join(" ");
  const versionBlock =
    input.versionMode === "ok"
      ? `if [ "$1" = "--version" ]; then
  printf 'acp-agent 1.2.3\\n'
  exit 0
fi`
      : `if [ "$1" = "--version" ]; then
  printf 'version unsupported\\n' >&2
  exit 2
fi`;
  yield* writeExecutable(
    wrapperPath,
    ["#!/bin/sh", versionBlock, `exec ${mockAgentCommand} "$@"`, ""].join("\n"),
  );
  return wrapperPath;
});

describe("buildInitialAcpRegistryProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAcpRegistryProviderSnapshot(
        decodeAcpRegistrySettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
    }),
  );

  it.effect("returns a not-installed snapshot when the binary path is empty", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAcpRegistryProviderSnapshot(
        decodeAcpRegistrySettings({ enabled: true, binaryPath: "" }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("binary path");
    }),
  );

  it.effect("returns a pending snapshot when a binary path is set", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialAcpRegistryProviderSnapshot(
        decodeAcpRegistrySettings({ enabled: true, binaryPath: "contextivity-agent" }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking ACP agent");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkAcpRegistryProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderStatus(
        decodeAcpRegistrySettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/acp-registry-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH/);
    }),
  );

  it.effect("keeps an empty binary path as not installed instead of probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderStatus(
        decodeAcpRegistrySettings({ enabled: true, binaryPath: "   " }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("binary path");
    }),
  );

  it.effect("treats initialize/session as health even when --version fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wrapperPath = yield* makeMockAgentWrapper({
          prefix: "t3code-acp-registry-version-fail-",
          versionMode: "fail",
        });
        const snapshot = yield* checkAcpRegistryProviderStatus(
          decodeAcpRegistrySettings({ enabled: true, binaryPath: wrapperPath }),
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("ready");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build", "grok-mock-alt"]);
        expect(snapshot.message).toBeUndefined();
      }),
    ),
  );

  it.effect("reports ready when ACP initialize/session succeeds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const wrapperPath = yield* makeMockAgentWrapper({
          prefix: "t3code-acp-registry-ready-",
          versionMode: "ok",
        });
        const snapshot = yield* checkAcpRegistryProviderStatus(
          decodeAcpRegistrySettings({ enabled: true, binaryPath: wrapperPath }),
        );
        expect(snapshot.enabled).toBe(true);
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("ready");
        expect(snapshot.version).toBe("1.2.3");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build", "grok-mock-alt"]);
      }),
    ),
  );

  it.effect("reports an error when ACP initialize/session is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-acp-registry-fail-probe-",
        });
        const wrapperPath = path.join(dir, "fake-acp-agent.sh");
        yield* writeExecutable(
          wrapperPath,
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then',
            "  printf 'acp-agent 0.0.1\\n'",
            "  exit 0",
            "fi",
            'printf "not an acp agent\\n" >&2',
            "exit 1",
            "",
          ].join("\n"),
        );

        const snapshot = yield* checkAcpRegistryProviderStatus(
          decodeAcpRegistrySettings({ enabled: true, binaryPath: wrapperPath }),
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.version).toBe("0.0.1");
        expect(snapshot.message).toContain("initialize/session failed");
      }),
    ),
  );
});
