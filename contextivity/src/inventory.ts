import { SCHEMA_VERSION } from "./config.ts";
import { parseJsonObject } from "./json.ts";

export type HostTransport = "local" | "ssh";

export interface InventoryHost {
  readonly name: string;
  readonly via: HostTransport;
  readonly sshAlias?: string;
  readonly clientGate?: boolean;
  readonly healthCommand?: string;
  readonly restartCommand?: string;
}

export interface Inventory {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly channel: "nightly" | "stable" | "candidate";
  readonly hosts: readonly InventoryHost[];
}

const FORBIDDEN_HARDCODED = [
  /rfranke/i,
  /100\.\d+\.\d+\.\d+/u,
  /ai-dev-w1/i,
  /macbook/i,
  /tail398e94/i,
];

export function assertNoHardcodedSecrets(text: string, label: string): void {
  if (text.includes("ghp_") || text.includes("github_pat_")) {
    throw new Error(
      `${label} contains a GitHub token. Credentials must stay out of inventory files.`,
    );
  }
}

export function decodeInventory(text: string): Inventory {
  assertNoHardcodedSecrets(text, "inventory");
  const raw = parseJsonObject(text, "inventory");
  if (raw["schemaVersion"] !== SCHEMA_VERSION) {
    throw new Error(`Unsupported inventory schemaVersion '${String(raw["schemaVersion"])}'.`);
  }
  const channel = raw["channel"];
  if (channel !== "nightly" && channel !== "stable" && channel !== "candidate") {
    throw new Error("inventory.channel must be candidate, nightly, or stable.");
  }
  const hostsRaw = raw["hosts"];
  if (!Array.isArray(hostsRaw) || hostsRaw.length === 0) {
    throw new Error("inventory.hosts must be a non-empty array.");
  }
  const names = new Set<string>();
  const hosts = hostsRaw.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`inventory.hosts[${index}] must be an object.`);
    }
    const host = entry as Record<string, unknown>;
    const name = String(host["name"] ?? "").trim();
    const via = host["via"];
    if (name.length === 0) throw new Error(`inventory.hosts[${index}].name is required.`);
    if (names.has(name)) throw new Error(`Duplicate inventory host '${name}'.`);
    names.add(name);
    if (via !== "local" && via !== "ssh") {
      throw new Error(`inventory.hosts[${index}].via must be local or ssh.`);
    }
    const sshAlias = typeof host["sshAlias"] === "string" ? host["sshAlias"].trim() : undefined;
    if (via === "ssh") {
      if (!sshAlias) {
        throw new Error(`inventory.hosts[${index}] ssh transport requires sshAlias.`);
      }
      if (sshAlias.includes("@") || sshAlias.includes("://")) {
        throw new Error(
          `inventory.hosts[${index}].sshAlias must be an SSH config alias, not user@host or a URL.`,
        );
      }
    }
    const decoded: InventoryHost = {
      name,
      via,
      ...(sshAlias ? { sshAlias } : {}),
      ...(host["clientGate"] === true ? { clientGate: true } : {}),
      ...(typeof host["healthCommand"] === "string"
        ? { healthCommand: host["healthCommand"] }
        : {}),
      ...(typeof host["restartCommand"] === "string"
        ? { restartCommand: host["restartCommand"] }
        : {}),
    };
    return decoded;
  });
  if (hosts.filter((host) => host.via === "local").length !== 1) {
    throw new Error("inventory must contain exactly one host with via=local.");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    channel,
    hosts,
  };
}

export function exampleInventoryLooksSafe(text: string): boolean {
  return !FORBIDDEN_HARDCODED.some((pattern) => pattern.test(text));
}

export function clientGateHost(inventory: Inventory): InventoryHost | null {
  return inventory.hosts.find((host) => host.clientGate === true) ?? null;
}
