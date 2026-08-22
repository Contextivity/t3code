import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
import {
  assertNoUpstreamPackageFallback,
  containsUpstreamPackageFallback,
  internalUpdateCommand,
  replaceUpstreamUpdateCommand,
} from "./update-metadata.ts";
import {
  assertNoPrivateSigningKey,
  attestationVerifyArgs,
  provenancePolicy,
  shouldVerifyAttestation,
} from "./provenance.ts";
import { resolveGitHubAuth, resolveGitHubEndpoints } from "./github-auth.ts";
import { promoteCandidate } from "./promote.ts";
import { GENERIC_ACP_FOCUSED_TESTS, PLATFORMS } from "./config.ts";
import { buildCandidateManifest } from "./manifest.ts";
import { nativePrefixesMatchUpstream } from "./pack.ts";
import { decodeInventory, exampleInventoryLooksSafe } from "./inventory.ts";
import {
  expectedWorkflowPaths,
  validatePosixShell,
  validateWorkflowYaml,
} from "./workflow-validate.ts";

const repoRoot = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");

const manifest = buildCandidateManifest({
  upstreamVersion: "0.0.34-nightly.20260822.2",
  upstreamCommit: "c".repeat(40),
  contextivityRevision: "abc1234",
  buildRevision: "run-1",
  nodeEngine: ">=24",
  createdAt: "2026-08-22T00:00:00.000Z",
  artifacts: PLATFORMS.map((platform) => ({
    platform,
    name: `t3-server-${platform}.tar.gz`,
    size: 1,
    sha256: "a".repeat(64),
  })),
});

NodeTest.describe("update and provenance policy", () => {
  NodeTest.it("rejects upstream npm package fallbacks and rewrites them to t3-ctx", () => {
    NodeAssert.equal(containsUpstreamPackageFallback("npx t3@0.0.34-nightly.20260822.2"), true);
    NodeAssert.equal(containsUpstreamPackageFallback("npm install t3@0.0.34"), true);
    NodeAssert.equal(containsUpstreamPackageFallback("t3-ctx update --version 0.0.34"), false);
    NodeAssert.equal(
      replaceUpstreamUpdateCommand("npx t3@0.0.34-nightly.20260822.2", "0.0.34-nightly.20260822.2"),
      internalUpdateCommand("0.0.34-nightly.20260822.2"),
    );
    NodeAssert.throws(() =>
      assertNoUpstreamPackageFallback("npx t3@latest service update", "docs"),
    );
  });

  NodeTest.it("requires checksums always and GitHub OIDC attestations when authenticated", () => {
    const required = provenancePolicy({ githubAuthenticated: true, oidcAvailable: true });
    NodeAssert.equal(required.checksumRequired, true);
    NodeAssert.equal(required.privateSigningKey, "forbidden");
    NodeAssert.equal(shouldVerifyAttestation(required), true);
    NodeAssert.equal(
      shouldVerifyAttestation(
        provenancePolicy({ githubAuthenticated: true, oidcAvailable: false }),
      ),
      true,
    );
    NodeAssert.equal(
      shouldVerifyAttestation(
        provenancePolicy({ githubAuthenticated: false, oidcAvailable: false }),
      ),
      false,
    );
    NodeAssert.throws(() => assertNoPrivateSigningKey({ COSIGN_KEY: "secret" }));
    NodeAssert.deepEqual(
      attestationVerifyArgs({
        artifactPath: "a.tar.gz",
        owner: "Contextivity",
        repo: "t3code",
      }),
      ["attestation", "verify", "a.tar.gz", "--repo", "Contextivity/t3code"],
    );
  });

  NodeTest.it("uses explicit token or gh, and refuses untrusted GitHub mirrors", () => {
    NodeAssert.equal(
      resolveGitHubAuth({ env: { CONTEXTIVITY_GITHUB_TOKEN: "tok" } }).source,
      "explicit-token",
    );
    NodeAssert.equal(resolveGitHubAuth({ env: {}, ghToken: "from-gh" }).source, "gh");
    NodeAssert.throws(() =>
      resolveGitHubEndpoints({ CONTEXTIVITY_T3_GITHUB_BASE: "https://mirror.example" }),
    );
    const trusted = resolveGitHubEndpoints({
      CONTEXTIVITY_T3_GITHUB_BASE: "https://mirror.example",
      CONTEXTIVITY_T3_TRUST_MIRROR: "1",
    });
    NodeAssert.equal(trusted.trustedMirror, true);
  });

  NodeTest.it("fails promotion closed on Mac client mismatch and missing confirmation", () => {
    const mismatch = promoteCandidate({
      channel: "nightly",
      manifest,
      macClientVersion: "0.0.1",
    });
    NodeAssert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      NodeAssert.equal(mismatch.failClosed, true);
      NodeAssert.equal(mismatch.advanceFleet, false);
    }
    const missing = promoteCandidate({
      channel: "nightly",
      manifest,
      macClientVersion: " ",
    });
    NodeAssert.equal(missing.ok, false);
    const ok = promoteCandidate({
      channel: "nightly",
      manifest,
      macClientVersion: "v0.0.34-nightly.20260822.2",
    });
    NodeAssert.equal(ok.ok, true);
  });
});

NodeTest.describe("workflow YAML and shell portability", () => {
  NodeTest.it("keeps candidate and promote workflows thin and script-driven", () => {
    for (const relative of expectedWorkflowPaths()) {
      const yaml = NodeFS.readFileSync(NodePath.join(repoRoot, relative), "utf8");
      const result = validateWorkflowYaml(relative, yaml);
      NodeAssert.deepEqual(result.errors, [], result.errors.join("\n"));
    }
  });

  NodeTest.it("uses a POSIX launcher and lists ACP tests that exist", () => {
    const wrapper = NodeFS.readFileSync(NodePath.join(repoRoot, "contextivity/bin/t3-ctx"), "utf8");
    NodeAssert.deepEqual(validatePosixShell(wrapper, "t3-ctx"), []);
    for (const file of GENERIC_ACP_FOCUSED_TESTS) {
      NodeAssert.equal(NodeFS.existsSync(NodePath.join(repoRoot, file)), true, file);
    }
    const inventory = NodeFS.readFileSync(
      NodePath.join(repoRoot, "contextivity/inventory.example.json"),
      "utf8",
    );
    NodeAssert.equal(exampleInventoryLooksSafe(inventory), true);
    NodeAssert.equal(decodeInventory(inventory).hosts.filter((host) => host.clientGate).length, 1);
    const upstream = NodeFS.readFileSync(
      NodePath.join(repoRoot, "scripts/lib/cli-external-packages.ts"),
      "utf8",
    );
    NodeAssert.equal(nativePrefixesMatchUpstream(upstream), true);
  });
});
