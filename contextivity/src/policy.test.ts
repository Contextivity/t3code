import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
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
import { buildCandidateManifest } from "./manifest.ts";
import { nativePrefixesMatchUpstream } from "./pack.ts";
import { exampleInventoryLooksSafe } from "./inventory.ts";
import {
  expectedWorkflowPaths,
  validatePosixShell,
  validateWorkflowYaml,
} from "./workflow-validate.ts";
import { GENERIC_ACP_FOCUSED_TESTS } from "./config.ts";
import { existsSync } from "node:fs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const manifest = buildCandidateManifest({
  upstreamVersion: "0.0.34-nightly.20260822.2",
  upstreamCommit: "c".repeat(40),
  contextivityRevision: "abc1234",
  buildRevision: "run-1",
  nodeEngine: ">=24",
  createdAt: "2026-08-22T00:00:00.000Z",
  artifacts: [
    {
      platform: "darwin-arm64",
      name: "t3-server-darwin-arm64.tar.gz",
      size: 1,
      sha256: "a".repeat(64),
    },
  ],
});

describe("update and provenance policy", () => {
  it("rejects upstream npm package fallbacks and rewrites them to t3-ctx", () => {
    assert.equal(containsUpstreamPackageFallback("npx t3@0.0.34-nightly.20260822.2"), true);
    assert.equal(containsUpstreamPackageFallback("npm install t3@0.0.34"), true);
    assert.equal(containsUpstreamPackageFallback("t3-ctx update --version 0.0.34"), false);
    assert.equal(
      replaceUpstreamUpdateCommand("npx t3@0.0.34-nightly.20260822.2", "0.0.34-nightly.20260822.2"),
      internalUpdateCommand("0.0.34-nightly.20260822.2"),
    );
    assert.throws(() => assertNoUpstreamPackageFallback("npx t3@latest service update", "docs"));
  });

  it("requires checksums always and GitHub OIDC attestations when authenticated", () => {
    const required = provenancePolicy({ githubAuthenticated: true, oidcAvailable: true });
    assert.equal(required.checksumRequired, true);
    assert.equal(required.privateSigningKey, "forbidden");
    assert.equal(shouldVerifyAttestation(required), true);
    assert.equal(
      shouldVerifyAttestation(
        provenancePolicy({ githubAuthenticated: true, oidcAvailable: false }),
      ),
      true,
    );
    assert.equal(
      shouldVerifyAttestation(
        provenancePolicy({ githubAuthenticated: false, oidcAvailable: false }),
      ),
      false,
    );
    assert.throws(() => assertNoPrivateSigningKey({ COSIGN_KEY: "secret" }));
    assert.deepEqual(
      attestationVerifyArgs({
        artifactPath: "a.tar.gz",
        owner: "Contextivity",
        repo: "t3code",
      }),
      ["attestation", "verify", "a.tar.gz", "--repo", "Contextivity/t3code"],
    );
  });

  it("uses explicit token or gh, and refuses untrusted GitHub mirrors", () => {
    assert.equal(
      resolveGitHubAuth({ env: { CONTEXTIVITY_GITHUB_TOKEN: "tok" } }).source,
      "explicit-token",
    );
    assert.equal(resolveGitHubAuth({ env: {}, ghToken: "from-gh" }).source, "gh");
    assert.throws(() =>
      resolveGitHubEndpoints({ CONTEXTIVITY_T3_GITHUB_BASE: "https://mirror.example" }),
    );
    const trusted = resolveGitHubEndpoints({
      CONTEXTIVITY_T3_GITHUB_BASE: "https://mirror.example",
      CONTEXTIVITY_T3_TRUST_MIRROR: "1",
    });
    assert.equal(trusted.trustedMirror, true);
  });

  it("fails promotion closed on Mac client mismatch and missing confirmation", () => {
    const mismatch = promoteCandidate({
      channel: "nightly",
      manifest,
      macClientVersion: "0.0.1",
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.failClosed, true);
      assert.equal(mismatch.advanceFleet, false);
    }
    const missing = promoteCandidate({
      channel: "nightly",
      manifest,
      macClientVersion: " ",
    });
    assert.equal(missing.ok, false);
    const ok = promoteCandidate({
      channel: "nightly",
      manifest,
      macClientVersion: "v0.0.34-nightly.20260822.2",
    });
    assert.equal(ok.ok, true);
  });
});

describe("workflow YAML and shell portability", () => {
  it("keeps candidate and promote workflows thin and script-driven", () => {
    for (const relative of expectedWorkflowPaths()) {
      const yaml = readFileSync(join(repoRoot, relative), "utf8");
      const result = validateWorkflowYaml(relative, yaml);
      assert.deepEqual(result.errors, [], result.errors.join("\n"));
    }
  });

  it("uses a POSIX launcher and lists ACP tests that exist", () => {
    const wrapper = readFileSync(join(repoRoot, "contextivity/bin/t3-ctx"), "utf8");
    assert.deepEqual(validatePosixShell(wrapper, "t3-ctx"), []);
    for (const file of GENERIC_ACP_FOCUSED_TESTS) {
      assert.equal(existsSync(join(repoRoot, file)), true, file);
    }
    const inventory = readFileSync(join(repoRoot, "contextivity/inventory.example.json"), "utf8");
    assert.equal(exampleInventoryLooksSafe(inventory), true);
    const upstream = readFileSync(join(repoRoot, "scripts/lib/cli-external-packages.ts"), "utf8");
    assert.equal(nativePrefixesMatchUpstream(upstream), true);
  });
});
