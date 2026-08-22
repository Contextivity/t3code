import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "@t3tools/contracts";

import {
  buildAcpRegistrySpawnInput,
  resolveAcpRegistryMcpPolicy,
  tokenizeAcpRegistryLaunchArgs,
} from "./AcpRegistrySupport.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

describe("tokenizeAcpRegistryLaunchArgs", () => {
  it("tokenizes a Contextivity-style argument string", () => {
    expect(tokenizeAcpRegistryLaunchArgs("--mode acp")).toEqual(["--mode", "acp"]);
  });

  it("returns an empty list when launch args are blank", () => {
    expect(tokenizeAcpRegistryLaunchArgs("")).toEqual([]);
    expect(tokenizeAcpRegistryLaunchArgs(undefined)).toEqual([]);
  });
});

describe("buildAcpRegistrySpawnInput", () => {
  it("uses the configured binary and tokenized launch args", () => {
    const settings = decodeSettings({
      binaryPath: "/usr/local/bin/contextivity-agent",
      launchArgs: "--mode acp",
    });
    expect(buildAcpRegistrySpawnInput(settings, "/tmp/project")).toEqual({
      command: "/usr/local/bin/contextivity-agent",
      args: ["--mode", "acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("resolveAcpRegistryMcpPolicy", () => {
  it("maps the attach switch to auto or never", () => {
    expect(resolveAcpRegistryMcpPolicy({ attachMcpWhenSupported: true })).toBe("auto");
    expect(resolveAcpRegistryMcpPolicy({ attachMcpWhenSupported: false })).toBe("never");
  });
});
