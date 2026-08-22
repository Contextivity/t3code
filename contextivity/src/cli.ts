#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flagBool, flagString, parseArgs, usage } from "./args.ts";
import { CANDIDATE_SERVER_CHECKS, DOWNSTREAM_GITHUB, GENERIC_ACP_FOCUSED_TESTS } from "./config.ts";
import { createGitRunner } from "./git-runner.ts";
import { resolveGitHubAuth, resolveGitHubEndpoints } from "./github-auth.ts";
import { formatChecksumFile } from "./hash.ts";
import { decodeInventory } from "./inventory.ts";
import { executeTwoPhase, gateFleetWithMacClient, planFleetUpdate } from "./fleet.ts";
import {
  buildCandidateManifest,
  candidateReleaseTag,
  decodeManifest,
  encodeManifest,
} from "./manifest.ts";
import { detectHostPlatform } from "./platforms.ts";
import { promoteCandidate, buildChannelPointer } from "./promote.ts";
import {
  assertGhArgvHasNoSecret,
  candidateReleaseNotes,
  candidateReleaseTitle,
  decodeChannelPointer,
  ghReleaseCreateArgs,
  ghReleaseDownloadArgs,
  ghReleaseViewArgs,
  releaseAssetFiles,
  resolveExactReleaseTag,
} from "./release.ts";
import { redactCommandResult, spawnCommand } from "./spawn.ts";
import { failClosed, syncExactUpstreamTag, type SyncFailure } from "./sync.ts";
import {
  findNamedUpstreamNightly,
  lsRemoteArgs,
  requireNewestUpstreamNightly,
  type UpstreamNightly,
  upstreamRemoteUrl,
} from "./upstream.ts";
import {
  activateAndVerify,
  layoutAt,
  resolveLayoutRoot,
  rollbackCurrent,
  stageCandidate,
  updaterStatus,
} from "./updater.ts";
import { reportSyncFailureIssue } from "./issues.ts";
import { resolveMacClientVersion } from "./mac-client.ts";
import {
  expectedWorkflowPaths,
  validatePosixShell,
  validateWorkflowYaml,
} from "./workflow-validate.ts";
import { tarExtractArgs } from "./pack.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireFlag(flags: ReturnType<typeof parseArgs>["flags"], name: string): string {
  const value = flagString(flags, name);
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

async function discoverUpstream(remote: string): Promise<UpstreamNightly> {
  const result = await spawnCommand({
    command: "git",
    args: lsRemoteArgs(remote),
    cwd: repoRoot,
    timeoutMs: 60_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git ls-remote failed");
  }
  return requireNewestUpstreamNightly(result.stdout);
}

async function githubToken(): Promise<string | null> {
  const explicit = resolveGitHubAuth({ env: process.env }).token;
  if (explicit) return explicit;
  try {
    const gh = await spawnCommand({
      command: "gh",
      args: ["auth", "token"],
      timeoutMs: 10_000,
    });
    if (gh.code === 0 && gh.stdout.trim().length > 0) return gh.stdout.trim();
  } catch {
    return null;
  }
  return null;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.command) {
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(`${usage()}\n`);
      return 0;
    case "discover-upstream": {
      const endpoints = resolveGitHubEndpoints(process.env);
      const remote = flagString(parsed.flags, "remote") ?? upstreamRemoteUrl(endpoints.base);
      writeJson(await discoverUpstream(remote));
      return 0;
    }
    case "sync-tag": {
      const tag = requireFlag(parsed.flags, "tag");
      const endpoints = resolveGitHubEndpoints(process.env);
      const remote = flagString(parsed.flags, "remote") ?? upstreamRemoteUrl(endpoints.base);
      const ls = await spawnCommand({
        command: "git",
        args: lsRemoteArgs(remote),
        cwd: repoRoot,
        timeoutMs: 60_000,
      });
      if (ls.code !== 0) {
        const failure = failClosed(tag, ls.stderr.trim() || "git ls-remote failed");
        writeJson(failure);
        return 2;
      }
      const nightly = findNamedUpstreamNightly(ls.stdout, tag);
      if (!nightly) {
        const failure = failClosed(
          tag.startsWith("v") ? tag : `v${tag}`,
          `Requested nightly tag ${tag} was not found on upstream.`,
        );
        writeJson(failure);
        return 2;
      }
      const result = await syncExactUpstreamTag({
        git: createGitRunner(repoRoot),
        remote,
        nightly,
      });
      writeJson(result);
      return result.ok ? 0 : 2;
    }
    case "report-sync-failure": {
      const failure: SyncFailure = failClosed(
        requireFlag(parsed.flags, "tag"),
        requireFlag(parsed.flags, "reason"),
        flagString(parsed.flags, "conflicts")?.split(",") ?? [],
      );
      const token = await githubToken();
      if (!token) {
        writeJson({ created: false, skipped: "no-github-auth", failure });
        return 0;
      }
      const endpoints = resolveGitHubEndpoints(process.env);
      const result = await reportSyncFailureIssue(
        {
          searchOpen: async (title) => {
            const query = encodeURIComponent(
              `repo:${DOWNSTREAM_GITHUB.owner}/${DOWNSTREAM_GITHUB.repo} is:issue is:open in:title ${title}`,
            );
            const response = await fetch(`${endpoints.api}/search/issues?q=${query}`, {
              headers: { Authorization: `Bearer ${token}`, "User-Agent": "contextivity-t3" },
            });
            if (!response.ok) return [];
            const body = (await response.json()) as {
              items?: Array<{ number: number; title: string; html_url: string; state: string }>;
            };
            return (body.items ?? []).map((item) => ({
              number: item.number,
              title: item.title,
              state: item.state === "closed" ? "closed" : "open",
              htmlUrl: item.html_url,
            }));
          },
          create: async (input) => {
            const response = await fetch(
              `${endpoints.api}/repos/${DOWNSTREAM_GITHUB.owner}/${DOWNSTREAM_GITHUB.repo}/issues`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "User-Agent": "contextivity-t3",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(input),
              },
            );
            if (!response.ok) {
              throw new Error(`GitHub issue create failed (${response.status}).`);
            }
            const body = (await response.json()) as {
              number: number;
              title: string;
              html_url: string;
              state: string;
            };
            return {
              number: body.number,
              title: body.title,
              state: body.state === "closed" ? "closed" : "open",
              htmlUrl: body.html_url,
            };
          },
        },
        failure,
      );
      writeJson({ ...result, failure });
      return 0;
    }
    case "candidate-test-plan":
      writeJson({
        focusedTests: GENERIC_ACP_FOCUSED_TESTS,
        serverChecks: CANDIDATE_SERVER_CHECKS,
        downstreamTests: "node --test --experimental-strip-types contextivity/src/*.test.ts",
      });
      return 0;
    case "validate-workflows": {
      const errors: string[] = [];
      for (const relative of expectedWorkflowPaths()) {
        const yaml = readFileSync(join(repoRoot, relative), "utf8");
        const result = validateWorkflowYaml(relative, yaml);
        if (!result.ok) errors.push(...result.errors);
      }
      const wrapper = readFileSync(join(repoRoot, "contextivity/bin/t3-ctx"), "utf8");
      errors.push(...validatePosixShell(wrapper, "contextivity/bin/t3-ctx"));
      if (errors.length > 0) {
        process.stderr.write(`${errors.join("\n")}\n`);
        return 1;
      }
      writeJson({ ok: true, workflows: expectedWorkflowPaths() });
      return 0;
    }
    case "check-mac-client": {
      const macClientVersion = resolveMacClientVersion({
        envVersion:
          flagString(parsed.flags, "mac-client-version") ??
          process.env.CONTEXTIVITY_T3_MAC_CLIENT_VERSION,
      });
      const upstreamVersion = requireFlag(parsed.flags, "upstream-version");
      const promotion = promoteCandidate({
        channel: "nightly",
        macClientVersion,
        manifest: buildCandidateManifest({
          upstreamVersion,
          upstreamCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          contextivityRevision: "bbbbbbb",
          buildRevision: "check",
          nodeEngine: ">=24",
          createdAt: "2026-08-22T00:00:00.000Z",
          artifacts: [
            {
              platform: "darwin-arm64",
              name: "placeholder.tar.gz",
              size: 1,
              sha256: "a".repeat(64),
            },
          ],
        }),
      });
      writeJson(promotion);
      return promotion.ok ? 0 : 2;
    }
    case "write-manifest": {
      const artifactsJson = requireFlag(parsed.flags, "artifacts");
      const artifacts = JSON.parse(artifactsJson) as Array<{
        platform: "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";
        name: string;
        size: number;
        sha256: string;
      }>;
      const manifest = buildCandidateManifest({
        upstreamVersion: requireFlag(parsed.flags, "upstream-version"),
        upstreamTag: flagString(parsed.flags, "upstream-tag"),
        upstreamCommit: requireFlag(parsed.flags, "upstream-commit"),
        contextivityRevision: requireFlag(parsed.flags, "contextivity-revision"),
        buildRevision: requireFlag(parsed.flags, "build-revision"),
        nodeEngine: requireFlag(parsed.flags, "node-engine"),
        createdAt: flagString(parsed.flags, "created-at") ?? new Date().toISOString(),
        artifacts,
      });
      const encoded = encodeManifest(manifest);
      const out = flagString(parsed.flags, "out");
      if (out) {
        mkdirSync(dirname(resolve(out)), { recursive: true });
        writeFileSync(out, encoded);
        writeFileSync(
          join(dirname(resolve(out)), "SHA256SUMS"),
          formatChecksumFile(manifest.artifacts),
        );
      }
      process.stdout.write(encoded);
      return 0;
    }
    case "promote": {
      const manifest = decodeManifest(readFileSync(requireFlag(parsed.flags, "manifest"), "utf8"));
      const result = promoteCandidate({
        channel: requireFlag(parsed.flags, "channel") as "nightly" | "stable",
        manifest,
        macClientVersion: resolveMacClientVersion({
          envVersion:
            flagString(parsed.flags, "mac-client-version") ??
            process.env.CONTEXTIVITY_T3_MAC_CLIENT_VERSION,
        }),
        requestedInstallId: flagString(parsed.flags, "version"),
      });
      if (result.ok) {
        writeJson(
          buildChannelPointer({
            channel: result.channel,
            candidateTag: `contextivity-candidate/${result.installId}`,
            installId: result.installId,
            upstreamVersion: result.upstreamVersion,
            contextivityRevision: result.contextivityRevision,
            promotedAt: new Date().toISOString(),
          }),
        );
        return 0;
      }
      writeJson(result);
      return 2;
    }
    case "updater": {
      const action = parsed.positionals[0] ?? "status";
      const layout = layoutAt(resolveLayoutRoot(process.env));
      if (action === "status") {
        writeJson(updaterStatus(layout));
        return 0;
      }
      if (action === "check" || action === "update") {
        const token = await githubToken();
        const repo = `${DOWNSTREAM_GITHUB.owner}/${DOWNSTREAM_GITHUB.repo}`;
        const target = resolveExactReleaseTag({
          version: flagString(parsed.flags, "version"),
          channel: flagString(parsed.flags, "channel"),
        });
        const cacheDir = join(layout.root, "cache");
        mkdirSync(cacheDir, { recursive: true });
        const ghEnv = token ? { ...process.env, GH_TOKEN: token } : process.env;
        const runGh = async (args: readonly string[]) => {
          assertGhArgvHasNoSecret(args, [token]);
          const spawned = await spawnCommand({
            command: "gh",
            args,
            env: ghEnv,
            timeoutMs: 180_000,
          });
          return redactCommandResult(spawned, [token]);
        };
        let installId = target.installId;
        let candidateTag = target.tag;
        if (target.pointer) {
          const pointerDir = join(cacheDir, "pointer");
          mkdirSync(pointerDir, { recursive: true });
          const downloaded = await runGh(
            ghReleaseDownloadArgs({
              tag: target.tag,
              repo,
              dir: pointerDir,
              pattern: "pointer.json",
            }),
          );
          if (downloaded.code !== 0) {
            throw new Error(downloaded.stderr || `Failed to download ${target.tag}.`);
          }
          const pointer = decodeChannelPointer(
            readFileSync(join(pointerDir, "pointer.json"), "utf8"),
          );
          installId = pointer.installId;
          candidateTag = pointer.candidateTag;
        }
        if (!installId) {
          throw new Error("Could not resolve install id.");
        }
        if (action === "check") {
          const current = updaterStatus(layout).current;
          writeJson({
            current,
            target: installId,
            candidateTag,
            upToDate: current === installId,
          });
          return 0;
        }
        const artifactDir = join(cacheDir, installId);
        mkdirSync(artifactDir, { recursive: true });
        const platform = detectHostPlatform().platform;
        for (const pattern of ["manifest.json", `t3-server-${platform}.tar.gz`, "SHA256SUMS"]) {
          const downloaded = await runGh(
            ghReleaseDownloadArgs({
              tag: candidateTag,
              repo,
              dir: artifactDir,
              pattern,
            }),
          );
          if (downloaded.code !== 0 && pattern !== "SHA256SUMS") {
            throw new Error(
              downloaded.stderr || `Failed to download ${pattern} from ${candidateTag}.`,
            );
          }
        }
        const manifest = decodeManifest(readFileSync(join(artifactDir, "manifest.json"), "utf8"));
        const archivePath = join(artifactDir, `t3-server-${platform}.tar.gz`);
        const staged = await stageCandidate({
          layout,
          manifest,
          archivePath,
          github: DOWNSTREAM_GITHUB,
          githubAuthenticated: Boolean(token),
          oidcAvailable: Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL),
          commands: {
            extractArchive: async (source, destination) => {
              const result = await spawnCommand({
                command: "tar",
                args: tarExtractArgs(source, destination),
                timeoutMs: 120_000,
              });
              if (result.code !== 0) {
                throw new Error(result.stderr.trim() || "tar extract failed");
              }
            },
            preflight: async (versionDir) =>
              spawnCommand({
                command: "node",
                args: [join(versionDir, "dist/bin.mjs"), "--help"],
                env: { ...process.env, CONTEXTIVITY_T3_DISTRIBUTION: "1" },
                timeoutMs: 30_000,
              }),
            verifyAttestation: token
              ? async (args) =>
                  spawnCommand({
                    command: "gh",
                    args,
                    env: ghEnv,
                    timeoutMs: 60_000,
                  })
              : undefined,
          },
        });
        if (flagBool(parsed.flags, "stage-only")) {
          writeJson({
            installId: staged.installId,
            versionDir: staged.versionDir,
            activated: false,
          });
          return 0;
        }
        const activated = await activateAndVerify({
          layout,
          installId: staged.installId,
          commands: {
            extractArchive: async () => undefined,
            preflight: async () => ({ code: 0, stdout: "", stderr: "" }),
          },
        });
        writeJson({
          installId: staged.installId,
          current: activated.current,
          previous: activated.previous,
        });
        return 0;
      }
      if (action === "rollback") {
        writeJson(rollbackCurrent(layout));
        return 0;
      }
      if (action === "activate") {
        const installId = requireFlag(parsed.flags, "version");
        writeJson(
          await activateAndVerify({
            layout,
            installId,
            commands: {
              extractArchive: async () => undefined,
              preflight: async () => ({ code: 0, stdout: "", stderr: "" }),
            },
          }),
        );
        return 0;
      }
      if (action === "stage") {
        const manifest = decodeManifest(
          readFileSync(requireFlag(parsed.flags, "manifest"), "utf8"),
        );
        const archivePath = requireFlag(parsed.flags, "archive");
        const token = await githubToken();
        const staged = await stageCandidate({
          layout,
          manifest,
          archivePath,
          github: DOWNSTREAM_GITHUB,
          githubAuthenticated: Boolean(token),
          oidcAvailable: Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL),
          commands: {
            extractArchive: async (source, destination) => {
              const result = await spawnCommand({
                command: "tar",
                args: tarExtractArgs(source, destination),
                timeoutMs: 120_000,
              });
              if (result.code !== 0) {
                throw new Error(result.stderr.trim() || "tar extract failed");
              }
            },
            preflight: async (versionDir) =>
              spawnCommand({
                command: "node",
                args: [join(versionDir, "dist/bin.mjs"), "--help"],
                env: { ...process.env, CONTEXTIVITY_T3_DISTRIBUTION: "1" },
                timeoutMs: 30_000,
              }),
            verifyAttestation: token
              ? async (args) =>
                  spawnCommand({
                    command: "gh",
                    args,
                    env: { ...process.env, GH_TOKEN: token },
                    timeoutMs: 60_000,
                  })
              : undefined,
          },
        });
        writeJson({ installId: staged.installId, versionDir: staged.versionDir });
        return 0;
      }
      throw new Error(`Unknown updater action '${action}'.`);
    }
    case "fleet": {
      const action = parsed.positionals[0] ?? "update";
      const inventory = decodeInventory(
        readFileSync(requireFlag(parsed.flags, "inventory"), "utf8"),
      );
      const manifest = decodeManifest(readFileSync(requireFlag(parsed.flags, "manifest"), "utf8"));
      const macClientVersion = flagString(parsed.flags, "mac-client-version");
      if (macClientVersion) {
        const gate = gateFleetWithMacClient({ manifest, macClientVersion });
        if (!gate.ok) {
          writeJson({ ok: false, reason: gate.reason, failClosed: true });
          return 2;
        }
      }
      const plan = planFleetUpdate({
        inventory,
        manifest,
        stageOnly: flagBool(parsed.flags, "stage-only") || action === "stage",
      });
      const result = await executeTwoPhase({
        plan,
        executor: {
          run: async (command) => {
            const spawned = await spawnCommand({
              command: command.argv[0] ?? "t3-ctx",
              args: command.argv.slice(1),
              timeoutMs: 300_000,
            });
            return {
              host: command.host,
              ok: spawned.code === 0,
              detail: spawned.stderr.trim() || spawned.stdout.trim(),
            };
          },
        },
      });
      writeJson(result);
      return result.ok ? 0 : 2;
    }
    case "publish-candidate": {
      const dir = requireFlag(parsed.flags, "dir");
      const repo =
        flagString(parsed.flags, "repo") ?? `${DOWNSTREAM_GITHUB.owner}/${DOWNSTREAM_GITHUB.repo}`;
      const manifest = decodeManifest(readFileSync(join(dir, "manifest.json"), "utf8"));
      const tag = candidateReleaseTag(manifest);
      const token = await githubToken();
      const ghEnv = token ? { ...process.env, GH_TOKEN: token } : process.env;
      const viewArgs = ghReleaseViewArgs(tag, repo);
      assertGhArgvHasNoSecret(viewArgs, [token]);
      const existing = await spawnCommand({
        command: "gh",
        args: viewArgs,
        env: ghEnv,
        timeoutMs: 30_000,
      });
      if (existing.code === 0) {
        throw new Error(
          `Candidate ${tag} already exists; refusing to overwrite an immutable release.`,
        );
      }
      const files = releaseAssetFiles(dir);
      const createArgs = ghReleaseCreateArgs({
        tag,
        repo,
        title: candidateReleaseTitle(manifest),
        notes: candidateReleaseNotes(manifest),
        files,
      });
      assertGhArgvHasNoSecret(createArgs, [token]);
      const created = await spawnCommand({
        command: "gh",
        args: createArgs,
        env: ghEnv,
        timeoutMs: 180_000,
      });
      if (created.code !== 0) {
        throw new Error(redactCommandResult(created, [token]).stderr || "gh release create failed");
      }
      writeJson({ ok: true, tag, files: files.map((file) => file.split("/").at(-1)) });
      return 0;
    }
    case "host-platform":
      writeJson(detectHostPlatform());
      return 0;
    default:
      process.stderr.write(`Unknown command '${parsed.command}'.\n${usage()}\n`);
      return 1;
  }
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

export { main };
