import * as NodeChildProcess from "node:child_process";
import type { CommandResult } from "./updater.ts";
import { redactSecrets } from "./github-auth.ts";

export interface SpawnRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly input?: string;
}

export const HOST_RESTART_TIMEOUT_MS = 60_000;
export const HOST_HEALTH_TIMEOUT_MS = 30_000;

export async function runBoundedHostCommand(
  command: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { code: 1, stdout: "", stderr: "Host command is empty." };
  }
  try {
    return await spawnCommand({
      command: "sh",
      args: ["-c", trimmed],
      timeoutMs,
    });
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export function spawnCommand(request: SpawnRequest): Promise<CommandResult> {
  const { command, args = [], cwd, env, timeoutMs, input } = request;
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out: ${command}`));
        return;
      }
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

export function redactCommandResult(
  result: CommandResult,
  secrets: readonly (string | null | undefined)[],
): CommandResult {
  return {
    code: result.code,
    stdout: redactSecrets(result.stdout, secrets),
    stderr: redactSecrets(result.stderr, secrets),
  };
}
