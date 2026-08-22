import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { CONTEXTIVITY_DISTRIBUTION_ENV } from "./config.ts";
import {
  collectNativeModuleDirs,
  launchWrapper,
  requirePackedNodePty,
  stageServerTree,
} from "./pack.ts";
import { containsUpstreamPackageFallback } from "./update-metadata.ts";
import { platformFromName } from "./write-candidate-manifest.ts";

NodeTest.describe("server archive packing", () => {
  NodeTest.it("writes a launcher that marks the distribution and never calls npx t3@", () => {
    const wrapper = launchWrapper("dist/bin.mjs");
    NodeAssert.equal(wrapper.includes(`${CONTEXTIVITY_DISTRIBUTION_ENV}=1`), true);
    NodeAssert.equal(containsUpstreamPackageFallback(wrapper), false);
    NodeAssert.equal(wrapper.startsWith("#!/usr/bin/env sh"), true);
  });

  NodeTest.it("stages dist, marker, and wrapper with protocol version = upstream nightly", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctx-pack-"));
    const distDir = NodePath.join(root, "dist-src");
    NodeFS.mkdirSync(distDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(distDir, "bin.mjs"), "export {};\n");
    const stagingDir = NodePath.join(root, "stage");
    stageServerTree({
      stagingDir,
      distDir,
      upstreamVersion: "0.0.34-nightly.20260822.2",
      contextivityRevision: "abc1234",
    });
    const marker = JSON.parse(
      NodeFS.readFileSync(NodePath.join(stagingDir, "contextivity-distribution.json"), "utf8"),
    ) as {
      protocolVersion: string;
      installId: string;
    };
    NodeAssert.equal(marker.protocolVersion, "0.0.34-nightly.20260822.2");
    NodeAssert.equal(marker.installId, "0.0.34-nightly.20260822.2-ctx.abc1234");
    NodeAssert.equal(platformFromName("t3-server-darwin-arm64.tar.gz"), "darwin-arm64");
  });

  NodeTest.it("collects native modules and copies through pnpm-style symlinks", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ctx-native-"));
    const realPty = NodePath.join(root, ".pnpm", "node-pty");
    NodeFS.mkdirSync(realPty, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(realPty, "binding.node"), "native");
    NodeFS.mkdirSync(NodePath.join(root, "node_modules"), { recursive: true });
    NodeFS.symlinkSync(realPty, NodePath.join(root, "node_modules", "node-pty"));
    const dirs = collectNativeModuleDirs(root);
    requirePackedNodePty(dirs);
    const stagingDir = NodePath.join(root, "stage");
    const distDir = NodePath.join(root, "dist-src");
    NodeFS.mkdirSync(distDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(distDir, "bin.mjs"), "export {};\n");
    stageServerTree({
      stagingDir,
      distDir,
      nativeModuleDirs: dirs,
      upstreamVersion: "0.0.34-nightly.20260822.2",
      contextivityRevision: "abc1234",
    });
    const packed = NodePath.join(stagingDir, "node_modules", "node-pty", "binding.node");
    NodeAssert.equal(NodeFS.existsSync(packed), true);
    NodeAssert.equal(
      NodeFS.lstatSync(NodePath.join(stagingDir, "node_modules", "node-pty")).isSymbolicLink(),
      false,
    );
    NodeAssert.throws(() => requirePackedNodePty([]));
  });
});
