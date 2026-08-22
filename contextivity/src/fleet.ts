import type { CandidateManifest } from "./manifest.ts";
import { promoteCandidate } from "./promote.ts";
import type { Inventory, InventoryHost } from "./inventory.ts";
import { formatInstallId } from "./identity.ts";
import {
  encodeHostCommandArg,
  HEALTH_COMMAND_B64_FLAG,
  RESTART_COMMAND_B64_FLAG,
} from "./host-command.ts";

export type FleetPhase = "resolve" | "stage" | "activate" | "rollback";

export interface HostCommand {
  readonly host: string;
  readonly argv: readonly string[];
}

export interface HostResult {
  readonly host: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface FleetExecutor {
  readonly run: (command: HostCommand) => Promise<HostResult>;
}

export interface FleetPlan {
  readonly installId: string;
  readonly stage: readonly HostCommand[];
  readonly activate: readonly HostCommand[];
  readonly rollback: readonly HostCommand[];
}

export function hostArgv(host: InventoryHost, args: readonly string[]): HostCommand {
  if (host.via === "local") {
    return { host: host.name, argv: ["t3-ctx", ...args] };
  }
  const alias = host.sshAlias;
  if (!alias) {
    throw new Error(`Host '${host.name}' is missing sshAlias.`);
  }
  return { host: host.name, argv: ["ssh", alias, "--", "t3-ctx", ...args] };
}

export function updaterActivateArgs(host: InventoryHost, installId: string): readonly string[] {
  const args = ["updater", "activate", "--version", installId];
  if (host.restartCommand) {
    args.push(`--${RESTART_COMMAND_B64_FLAG}`, encodeHostCommandArg(host.restartCommand));
  }
  if (host.healthCommand) {
    args.push(`--${HEALTH_COMMAND_B64_FLAG}`, encodeHostCommandArg(host.healthCommand));
  }
  return args;
}

export function planFleetUpdate(input: {
  readonly inventory: Inventory;
  readonly manifest: CandidateManifest;
  readonly stageOnly?: boolean;
}): FleetPlan {
  const installId = formatInstallId(
    input.manifest.upstreamVersion,
    input.manifest.contextivityRevision,
  );
  const stage = input.inventory.hosts.map((host) =>
    hostArgv(host, ["updater", "update", "--version", installId, "--stage-only"]),
  );
  const activate = input.stageOnly
    ? []
    : input.inventory.hosts.map((host) => hostArgv(host, updaterActivateArgs(host, installId)));
  const rollback = input.inventory.hosts.map((host) => hostArgv(host, ["updater", "rollback"]));
  return { installId, stage, activate, rollback };
}

export async function executeTwoPhase(input: {
  readonly executor: FleetExecutor;
  readonly plan: FleetPlan;
}): Promise<
  | { readonly ok: true; readonly installId: string; readonly staged: readonly string[] }
  | {
      readonly ok: false;
      readonly installId: string;
      readonly phase: FleetPhase;
      readonly failedHost: string;
      readonly detail: string;
      readonly rolledBack: readonly string[];
      readonly activateNone: boolean;
    }
> {
  const staged: string[] = [];
  for (const command of input.plan.stage) {
    const result = await runHost(input.executor, command);
    if (!result.ok) {
      return {
        ok: false,
        installId: input.plan.installId,
        phase: "stage",
        failedHost: result.host,
        detail: result.detail,
        rolledBack: [],
        activateNone: true,
      };
    }
    staged.push(result.host);
  }

  const activated: string[] = [];
  for (const command of input.plan.activate) {
    const result = await runHost(input.executor, command);
    if (!result.ok) {
      const rolledBack: string[] = [];
      for (const hostName of [...activated].reverse()) {
        const rollback = input.plan.rollback.find((entry) => entry.host === hostName);
        if (!rollback) continue;
        const rollbackResult = await runHost(input.executor, rollback);
        if (rollbackResult.ok) rolledBack.push(hostName);
      }
      return {
        ok: false,
        installId: input.plan.installId,
        phase: "activate",
        failedHost: result.host,
        detail: result.detail,
        rolledBack,
        activateNone: activated.length === 0,
      };
    }
    activated.push(result.host);
  }

  return { ok: true, installId: input.plan.installId, staged };
}

async function runHost(executor: FleetExecutor, command: HostCommand): Promise<HostResult> {
  try {
    return await executor.run(command);
  } catch (error) {
    return {
      host: command.host,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function gateFleetWithMacClient(input: {
  readonly manifest: CandidateManifest;
  readonly macClientVersion: string;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const promotion = promoteCandidate({
    channel: "nightly",
    manifest: input.manifest,
    macClientVersion: input.macClientVersion,
  });
  if (!promotion.ok) {
    return { ok: false, reason: promotion.reason };
  }
  return { ok: true };
}
