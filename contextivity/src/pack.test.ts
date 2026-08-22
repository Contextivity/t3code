import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONTEXTIVITY_DISTRIBUTION_ENV } from "./config.ts";
import {
  collectNativeModuleDirs,
  launchWrapper,
  requirePackedNodePty,
  stageServerTree,
} from "./pack.ts";
import { containsUpstreamPackageFallback } from "./update-metadata.ts";
import { platformFromName } from "./write-candidate-manifest.ts";

describe("server archive packing", () => {
  it("writes a launcher that marks the distribution and never calls npx t3@", () => {
    const wrapper = launchWrapper("dist/bin.mjs");
    assert.equal(wrapper.includes(`${CONTEXTIVITY_DISTRIBUTION_ENV}=1`), true);
    assert.equal(containsUpstreamPackageFallback(wrapper), false);
    assert.equal(wrapper.startsWith("#!/usr/bin/env sh"), true);
  });

  it("stages dist, marker, and wrapper with protocol version = upstream nightly", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-pack-"));
    const distDir = join(root, "dist-src");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "bin.mjs"), "export {};\n");
    const stagingDir = join(root, "stage");
    stageServerTree({
      stagingDir,
      distDir,
      upstreamVersion: "0.0.34-nightly.20260822.2",
      contextivityRevision: "abc1234",
    });
    const marker = JSON.parse(
      readFileSync(join(stagingDir, "contextivity-distribution.json"), "utf8"),
    ) as {
      protocolVersion: string;
      installId: string;
    };
    assert.equal(marker.protocolVersion, "0.0.34-nightly.20260822.2");
    assert.equal(marker.installId, "0.0.34-nightly.20260822.2-ctx.abc1234");
    assert.equal(platformFromName("t3-server-darwin-arm64.tar.gz"), "darwin-arm64");
  });

  it("collects native modules and copies through pnpm-style symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-native-"));
    const realPty = join(root, ".pnpm", "node-pty");
    mkdirSync(realPty, { recursive: true });
    writeFileSync(join(realPty, "binding.node"), "native");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(realPty, join(root, "node_modules", "node-pty"));
    const dirs = collectNativeModuleDirs(root);
    requirePackedNodePty(dirs);
    const stagingDir = join(root, "stage");
    const distDir = join(root, "dist-src");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "bin.mjs"), "export {};\n");
    stageServerTree({
      stagingDir,
      distDir,
      nativeModuleDirs: dirs,
      upstreamVersion: "0.0.34-nightly.20260822.2",
      contextivityRevision: "abc1234",
    });
    const packed = join(stagingDir, "node_modules", "node-pty", "binding.node");
    assert.equal(existsSync(packed), true);
    assert.equal(lstatSync(join(stagingDir, "node_modules", "node-pty")).isSymbolicLink(), false);
    assert.throws(() => requirePackedNodePty([]));
  });
});
