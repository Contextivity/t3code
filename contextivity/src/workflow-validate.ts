import { containsUpstreamPackageFallback } from "./update-metadata.ts";

export interface WorkflowValidation {
  readonly path: string;
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const BASHISMS = [
  { id: "double-bracket", pattern: /\[\[/u },
  { id: "source-builtin", pattern: /\bsource\s+/u },
  { id: "function-keyword", pattern: /\bfunction\s+\w+/u },
  { id: "declare-array", pattern: /\bdeclare\s+-a\b/u },
];

export function validatePosixShell(script: string, label: string): string[] {
  const errors: string[] = [];
  if (!script.startsWith("#!/usr/bin/env sh") && !script.startsWith("#!/bin/sh")) {
    errors.push(`${label} must use a POSIX sh shebang.`);
  }
  for (const bashism of BASHISMS) {
    if (bashism.pattern.test(script)) {
      errors.push(`${label} contains bashism ${bashism.id}.`);
    }
  }
  return errors;
}

export function validateWorkflowYaml(path: string, yaml: string): WorkflowValidation {
  const errors: string[] = [];
  const lines = yaml.split(/\r?\n/u);
  if (lines.length > 280) {
    errors.push(
      `${path} has ${lines.length} lines. Keep workflow YAML thin and put logic in contextivity/src.`,
    );
  }
  if (
    !yaml.includes("node contextivity/src/cli.ts") &&
    !yaml.includes("node --experimental-strip-types contextivity/src/cli.ts")
  ) {
    errors.push(`${path} must invoke contextivity/src/cli.ts rather than inlining the pipeline.`);
  }
  if (
    containsUpstreamPackageFallback(yaml) ||
    /npm publish/u.test(yaml) ||
    /vp pm publish/u.test(yaml)
  ) {
    errors.push(`${path} must not publish or install upstream package t3@<version>.`);
  }
  if (path.includes("candidate") && !yaml.includes("attest-build-provenance")) {
    errors.push(`${path} must request GitHub OIDC artifact attestations.`);
  }
  if (path.includes("candidate") && !yaml.includes("id-token: write")) {
    errors.push(`${path} needs id-token: write for Sigstore/GitHub OIDC attestations.`);
  }
  if (path.includes("candidate") && !yaml.includes("attestations: write")) {
    errors.push(`${path} needs attestations: write.`);
  }
  if (
    path.includes("promote") &&
    !yaml.includes("mac-client-version") &&
    !yaml.includes("macClientVersion")
  ) {
    errors.push(`${path} must require an exact official Mac client version.`);
  }
  if (path.includes("candidate")) {
    if (
      !yaml.includes("candidate-test-plan") &&
      !yaml.includes("ContextivityAcpExtension.test.ts")
    ) {
      errors.push(`${path} must run the generic ACP plus sub-agent focused tests.`);
    }
    if (!yaml.includes("report-sync-failure")) {
      errors.push(`${path} must report fail-closed sync failures.`);
    }
    if (!yaml.includes("sync-tag")) {
      errors.push(`${path} must sync the exact upstream nightly tag.`);
    }
    if (!yaml.includes("publish-candidate") && !yaml.includes("gh release create")) {
      errors.push(`${path} must publish an immutable GitHub candidate release.`);
    }
    if (!yaml.includes("contextivity-sync/") && !yaml.includes("git push")) {
      errors.push(`${path} must persist the synced merge commit for later jobs.`);
    }
  }
  return { path, ok: errors.length === 0, errors };
}

export function expectedWorkflowPaths(): readonly string[] {
  return [
    ".github/workflows/contextivity-candidate.yml",
    ".github/workflows/contextivity-promote.yml",
  ];
}
