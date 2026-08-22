import { spawnCommand } from "./spawn.ts";
import type { GitRunner } from "./sync.ts";

async function git(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return spawnCommand({ command: "git", args, cwd, timeoutMs: 120_000 });
}

function conflictPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(?:CONFLICT(?: \([^)]+\))?:|U\t)(?:Merge conflict in )?(.+)$/u.exec(line);
    if (match?.[1]) paths.add(match[1].trim());
    const colon = /^CONFLICT \(content\): Merge conflict in (.+)$/u.exec(line);
    if (colon?.[1]) paths.add(colon[1].trim());
  }
  return [...paths];
}

export function createGitRunner(cwd: string): GitRunner {
  return {
    fetchExactTag: async (remote, tag) => {
      const result = await git(
        ["fetch", "--no-tags", remote, `refs/tags/${tag}:refs/tags/${tag}`],
        cwd,
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `git fetch ${tag} failed`);
      }
    },
    revParse: async (rev) => {
      const result = await git(["rev-parse", rev], cwd);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `git rev-parse ${rev} failed`);
      }
      return result.stdout.trim();
    },
    mergeCommit: async (rev) => {
      const result = await git(["merge", "--no-edit", "--no-ff", rev], cwd);
      if (result.code === 0) return { ok: true };
      return { ok: false, conflicts: conflictPaths(`${result.stdout}\n${result.stderr}`) };
    },
    abortMerge: async () => {
      await git(["merge", "--abort"], cwd);
    },
    isAncestor: async (ancestor, descendant) => {
      const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
      return result.code === 0;
    },
    readFileAt: async (rev, filePath) => {
      const result = await git(["show", `${rev}:${filePath}`], cwd);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `git show ${rev}:${filePath} failed`);
      }
      return result.stdout;
    },
    currentBranch: async () => {
      const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "git rev-parse --abbrev-ref HEAD failed");
      }
      return result.stdout.trim();
    },
    hasUncommittedChanges: async () => {
      const result = await git(["status", "--porcelain"], cwd);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "git status failed");
      }
      return result.stdout.trim().length > 0;
    },
  };
}
