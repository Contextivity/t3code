/**
 * Typed ACP extension for namespaced sub-agent lifecycle events.
 *
 * Capability: client/agent `_meta.contextivity.subagentEvents.version = 1`.
 * Notification: `_contextivity/subagent_event`.
 *
 * Any ACP agent may advertise this contract. Contextivity is the first producer.
 * Parsing is defensive: a malformed envelope, including any unparseable record,
 * is ignored. Never throw into the ACP turn.
 */

export const ACP_SUBAGENT_EVENT_METHOD = "_contextivity/subagent_event";
export const ACP_SUBAGENT_EVENTS_VERSION = 1;
export const CONTEXTIVITY_META_NAMESPACE = "contextivity";

export const ACP_SUBAGENT_LIFECYCLE_STATES = [
  "spawned",
  "running",
  "waiting_input",
  "waiting_approval",
  "idle",
  "resetting",
  "completed",
  "failed",
  "cancelled",
] as const;

export type AcpSubagentLifecycleState = (typeof ACP_SUBAGENT_LIFECYCLE_STATES)[number];
export type AcpSubagentEventKind = "snapshot" | "delta";
export type AcpSubagentDeltaChange = "started" | "updated" | "terminal";

const LIFECYCLE_STATE_SET = new Set<string>(ACP_SUBAGENT_LIFECYCLE_STATES);
const TERMINAL_STATES = new Set<AcpSubagentLifecycleState>(["completed", "failed", "cancelled"]);
const TERMINAL_KINDS = new Set(["completed", "reported", "failed", "cancelled"]);
const REPORT_STATUSES = new Set(["completed", "failed", "needs_review", "findings"]);

const MAX_ID = 128;
const MAX_SESSION_ID = 128;
const MAX_NAME = 160;
const MAX_TYPE = 64;
const MAX_MODEL = 128;
const MAX_TASK_FIELD = 160;
const MAX_DESCRIPTION = 160;
const MAX_ACTIVITY = 160;
const MAX_SUMMARY = 240;
const MAX_ERROR = 240;
const MAX_RECENT = 5;
const MAX_RECENT_ITEM = 80;
const MAX_LINEAGE = 8;
const MAX_SNAPSHOT_RECORDS = 64;
const MAX_DELTA_RECORDS = 8;
const MAX_SPAWN_DEPTH = 7;

export interface AcpSubagentRecentActivity {
  readonly updatedAt: number;
  readonly assistantMessages: ReadonlyArray<string>;
  readonly toolCalls: ReadonlyArray<string>;
}

export interface AcpSubagentTerminal {
  readonly kind: string;
  readonly endedAt: number;
  readonly summary?: string;
  readonly error?: string;
  readonly reportStatus?: "completed" | "failed" | "needs_review" | "findings";
}

export interface AcpSubagentRecord {
  readonly agentId: string;
  readonly parentAgentId?: string;
  readonly displayName?: string;
  readonly typeName?: string;
  readonly role?: string;
  readonly lineage?: ReadonlyArray<string>;
  readonly spawnDepth?: number;
  readonly taskId?: string;
  readonly taskSubject?: string;
  readonly description?: string;
  readonly state: AcpSubagentLifecycleState;
  readonly modelId?: string;
  readonly latestActivity?: string;
  readonly lastToolName?: string;
  readonly recentActivity?: AcpSubagentRecentActivity;
  readonly terminal?: AcpSubagentTerminal;
  readonly runtimeEpoch?: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly updatedAt: number;
}

export interface AcpSubagentEventPayload {
  readonly version: typeof ACP_SUBAGENT_EVENTS_VERSION;
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: AcpSubagentEventKind;
  readonly change?: AcpSubagentDeltaChange;
  readonly records: ReadonlyArray<AcpSubagentRecord>;
}

export interface AcpSubagentEventDiagnostic {
  readonly version?: unknown;
  readonly sessionId?: string;
  readonly sequence?: unknown;
  readonly kind?: unknown;
  readonly change?: unknown;
  readonly recordCount: number;
  readonly agentIds: ReadonlyArray<string>;
  readonly parseFailed?: boolean;
}

export function contextivitySubagentEventsClientMeta(): {
  readonly contextivity: { readonly subagentEvents: { readonly version: 1 } };
} {
  return {
    [CONTEXTIVITY_META_NAMESPACE]: { subagentEvents: { version: ACP_SUBAGENT_EVENTS_VERSION } },
  };
}

export function acpRegistryClientCapabilities(): {
  readonly _meta: {
    readonly contextivity: { readonly subagentEvents: { readonly version: 1 } };
  };
} {
  return { _meta: contextivitySubagentEventsClientMeta() };
}

export function agentAdvertisesContextivitySubagentEvents(
  capabilities?: { readonly _meta?: unknown } | null,
): boolean {
  return metaAdvertisesSubagentEvents(capabilities?._meta);
}

export function isAcpSubagentTerminalState(state: AcpSubagentLifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

export function summarizeAcpSubagentEvent(value: unknown): AcpSubagentEventDiagnostic {
  if (!isRecord(value)) {
    return { recordCount: 0, agentIds: [], parseFailed: true };
  }
  const records = recordsFromUnknown(value) ?? [];
  const agentIds: string[] = [];
  for (const item of records) {
    if (!isRecord(item) || typeof item.agentId !== "string") continue;
    const id = item.agentId.slice(0, MAX_ID);
    if (id.length > 0) agentIds.push(id);
    if (agentIds.length >= 20) break;
  }
  return {
    ...(value.version !== undefined ? { version: value.version } : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId.slice(0, MAX_ID) } : {}),
    ...(value.sequence !== undefined ? { sequence: value.sequence } : {}),
    ...(value.kind !== undefined ? { kind: value.kind } : {}),
    ...(value.change !== undefined ? { change: value.change } : {}),
    recordCount: records.length,
    agentIds,
  };
}

export function parseAcpSubagentEvent(value: unknown): AcpSubagentEventPayload | undefined {
  try {
    if (!isRecord(value)) return undefined;
    if (value.version !== ACP_SUBAGENT_EVENTS_VERSION) return undefined;
    const sessionId = boundIdentity(value.sessionId, MAX_SESSION_ID);
    if (!sessionId) return undefined;
    if (!Number.isInteger(value.sequence) || (value.sequence as number) < 1) return undefined;
    if (value.kind !== "snapshot" && value.kind !== "delta") return undefined;
    if (
      value.kind === "delta" &&
      value.change !== "started" &&
      value.change !== "updated" &&
      value.change !== "terminal"
    ) {
      return undefined;
    }
    if (!Array.isArray(value.records)) return undefined;
    // Snapshots are authoritative. Truncating would drop children, and the mapper
    // would then cancel the missing ones. Reject the whole envelope instead.
    if (value.kind === "snapshot" && value.records.length > MAX_SNAPSHOT_RECORDS) {
      return undefined;
    }
    const limit = value.kind === "snapshot" ? MAX_SNAPSHOT_RECORDS : MAX_DELTA_RECORDS;
    const records: AcpSubagentRecord[] = [];
    for (const item of value.records) {
      if (records.length >= limit) break;
      const parsed = parseAcpSubagentRecord(item);
      if (!parsed) return undefined;
      records.push(parsed);
    }
    return {
      version: ACP_SUBAGENT_EVENTS_VERSION,
      sessionId,
      sequence: value.sequence as number,
      kind: value.kind,
      ...(value.kind === "delta" ? { change: value.change as AcpSubagentDeltaChange } : {}),
      records,
    };
  } catch {
    return undefined;
  }
}

export function parseAcpSubagentRecord(value: unknown): AcpSubagentRecord | undefined {
  if (!isRecord(value)) return undefined;
  const agentId = boundIdentity(value.agentId);
  if (!agentId) return undefined;
  if (!LIFECYCLE_STATE_SET.has(value.state as string)) return undefined;
  const updatedAt = asTimestamp(value.updatedAt);
  if (updatedAt === undefined) return undefined;

  const parentAgentId = boundIdentity(value.parentAgentId);
  const displayName = boundedText(value.displayName, MAX_NAME);
  const typeName = boundedText(value.typeName, MAX_TYPE);
  const role = boundedText(value.role, MAX_TYPE);
  const taskId = boundIdentity(value.taskId, MAX_TASK_FIELD);
  const taskSubject = boundedText(value.taskSubject, MAX_TASK_FIELD);
  const description = boundedText(value.description, MAX_DESCRIPTION);
  const modelId = boundedText(value.modelId, MAX_MODEL);
  const latestActivity = boundedText(value.latestActivity, MAX_ACTIVITY);
  const lastToolName = boundedText(value.lastToolName, MAX_RECENT_ITEM);
  const lineage = Array.isArray(value.lineage)
    ? value.lineage
        .flatMap((id) => {
          const next = boundIdentity(id);
          return next ? [next] : [];
        })
        .slice(0, MAX_LINEAGE)
    : [];
  const recent = parseRecentActivity(value.recentActivity);
  const terminal = parseTerminal(value.terminal);
  const startedAt = asTimestamp(value.startedAt);
  const completedAt = asTimestamp(value.completedAt);

  return {
    agentId,
    state: value.state as AcpSubagentLifecycleState,
    updatedAt,
    ...(parentAgentId ? { parentAgentId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(typeName ? { typeName } : {}),
    ...(role ? { role } : {}),
    ...(taskId ? { taskId } : {}),
    ...(taskSubject ? { taskSubject } : {}),
    ...(description ? { description } : {}),
    ...(modelId ? { modelId } : {}),
    ...(latestActivity ? { latestActivity } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(lineage.length > 0 ? { lineage } : {}),
    ...(typeof value.spawnDepth === "number" && Number.isFinite(value.spawnDepth)
      ? { spawnDepth: Math.min(Math.max(0, Math.trunc(value.spawnDepth)), MAX_SPAWN_DEPTH) }
      : {}),
    ...(typeof value.runtimeEpoch === "number" && Number.isFinite(value.runtimeEpoch)
      ? { runtimeEpoch: value.runtimeEpoch }
      : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(recent ? { recentActivity: recent } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

function metaAdvertisesSubagentEvents(meta: unknown): boolean {
  if (!isRecord(meta)) return false;
  const ns = meta[CONTEXTIVITY_META_NAMESPACE];
  if (!isRecord(ns)) return false;
  const advertised = ns.subagentEvents;
  if (!isRecord(advertised)) return false;
  return advertised.version === ACP_SUBAGENT_EVENTS_VERSION;
}

function recordsFromUnknown(value: Record<string, unknown>): unknown[] | undefined {
  return Array.isArray(value.records) ? value.records : undefined;
}

function parseRecentActivity(value: unknown): AcpSubagentRecentActivity | undefined {
  if (!isRecord(value)) return undefined;
  const updatedAt = asTimestamp(value.updatedAt);
  if (updatedAt === undefined) return undefined;
  return {
    updatedAt,
    assistantMessages: boundStringList(value.assistantMessages),
    toolCalls: boundStringList(value.toolCalls),
  };
}

function parseTerminal(value: unknown): AcpSubagentTerminal | undefined {
  if (!isRecord(value)) return undefined;
  const endedAt = asTimestamp(value.endedAt);
  if (!TERMINAL_KINDS.has(value.kind as string) || endedAt === undefined) {
    return undefined;
  }
  const summary = boundedText(value.summary, MAX_SUMMARY);
  const error = boundedText(value.error, MAX_ERROR);
  const reportStatus =
    typeof value.reportStatus === "string" && REPORT_STATUSES.has(value.reportStatus)
      ? (value.reportStatus as AcpSubagentTerminal["reportStatus"])
      : undefined;
  return {
    kind: value.kind as string,
    endedAt,
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    ...(reportStatus ? { reportStatus } : {}),
  };
}

function boundStringList(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const next = boundedText(item, MAX_RECENT_ITEM);
    if (next) out.push(next);
    if (out.length >= MAX_RECENT) break;
  }
  return out;
}

function asTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundIdentity(value: unknown, max = MAX_ID): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return undefined;
  return value;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const redacted = normalized.replace(
    /\b(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*\S+/gi,
    "[redacted]",
  );
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, Math.max(0, max - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
