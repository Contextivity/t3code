/**
 * Typed ACP extension for namespaced sub-agent lifecycle events.
 *
 * Capability: client/agent `_meta.contextivity.subagentEvents.version = 1`.
 * Notification: `_contextivity/subagent_event`.
 *
 * Any ACP agent may advertise this contract. Contextivity is the first producer.
 * Parsing is defensive: malformed optional fields drop that record; a bad
 * envelope is ignored. Never throw into the ACP turn.
 */

import type { RuntimeTaskUsage } from "@t3tools/contracts";

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
const MAX_DESCRIPTION = 160;
const MAX_ACTIVITY = 160;
const MAX_SUMMARY = 240;
const MAX_ERROR = 240;
const MAX_RECENT = 5;
const MAX_RECENT_ITEM = 80;
const MAX_LINEAGE = 16;
const MAX_ROSTER = 100;

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
  readonly usage?: RuntimeTaskUsage;
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
    if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return undefined;
    const sessionId = boundId(value.sessionId);
    if (!sessionId) return undefined;
    if (!Number.isInteger(value.sequence) || (value.sequence as number) < 1) return undefined;
    const normalized = normalizeKind(value);
    if (!normalized) return undefined;
    const rawRecords = recordsFromUnknown(value);
    if (rawRecords === undefined) return undefined;
    const records: AcpSubagentRecord[] = [];
    for (const item of rawRecords) {
      const parsed = parseAcpSubagentRecord(item);
      if (!parsed) continue;
      records.push(parsed);
      if (records.length >= MAX_ROSTER) break;
    }
    if (normalized.kind === "delta" && records.length === 0) return undefined;
    return {
      version: ACP_SUBAGENT_EVENTS_VERSION,
      sessionId,
      sequence: value.sequence as number,
      kind: normalized.kind,
      ...(normalized.change ? { change: normalized.change } : {}),
      records,
    };
  } catch {
    return undefined;
  }
}

export function parseAcpSubagentRecord(value: unknown): AcpSubagentRecord | undefined {
  if (!isRecord(value)) return undefined;
  const agentId = boundId(value.agentId);
  if (!agentId) return undefined;
  if (!LIFECYCLE_STATE_SET.has(value.state as string)) return undefined;
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;

  const parentAgentId = boundId(value.parentAgentId);
  const displayName = boundedText(value.displayName, MAX_DESCRIPTION);
  const typeName = boundedText(value.typeName, MAX_DESCRIPTION);
  const role = boundedText(value.role, MAX_DESCRIPTION) ?? typeName;
  const taskId = boundId(value.taskId);
  const taskSubject = boundedText(value.taskSubject, MAX_DESCRIPTION);
  const description = boundedText(value.description, MAX_DESCRIPTION);
  const modelId = boundedText(value.modelId, MAX_DESCRIPTION);
  const latestActivity = boundedText(value.latestActivity, MAX_ACTIVITY);
  const lastToolName = boundedText(value.lastToolName, MAX_ACTIVITY);
  const lineage = Array.isArray(value.lineage)
    ? value.lineage
        .flatMap((id) => {
          const next = boundId(id);
          return next ? [next] : [];
        })
        .slice(0, MAX_LINEAGE)
    : [];
  const recent = parseRecentActivity(value.recentActivity);
  const terminal = parseTerminal(value.terminal);
  const usage = parseUsage(value.usage ?? value.typedUsage);

  return {
    agentId,
    state: value.state as AcpSubagentLifecycleState,
    updatedAt: value.updatedAt,
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
      ? { spawnDepth: value.spawnDepth }
      : {}),
    ...(typeof value.runtimeEpoch === "number" && Number.isFinite(value.runtimeEpoch)
      ? { runtimeEpoch: value.runtimeEpoch }
      : {}),
    ...(typeof value.startedAt === "number" && Number.isFinite(value.startedAt)
      ? { startedAt: value.startedAt }
      : {}),
    ...(typeof value.completedAt === "number" && Number.isFinite(value.completedAt)
      ? { completedAt: value.completedAt }
      : {}),
    ...(recent ? { recentActivity: recent } : {}),
    ...(terminal ? { terminal } : {}),
    ...(usage ? { usage } : {}),
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

function normalizeKind(
  rec: Record<string, unknown>,
): { kind: AcpSubagentEventKind; change?: AcpSubagentDeltaChange } | undefined {
  if (rec.kind === "snapshot") return { kind: "snapshot" };
  if (rec.kind === "delta") {
    if (rec.change !== "started" && rec.change !== "updated" && rec.change !== "terminal") {
      return undefined;
    }
    return { kind: "delta", change: rec.change };
  }
  // Host-task aliases: the T3 ingestion brief listed per-lifecycle kinds.
  // The producer wire uses snapshot/delta; accept both so either side can land.
  if (rec.kind === "started") return { kind: "delta", change: "started" };
  if (rec.kind === "progress" || rec.kind === "status" || rec.kind === "updated") {
    return { kind: "delta", change: "updated" };
  }
  if (rec.kind === "completed" || rec.kind === "terminal") {
    return { kind: "delta", change: "terminal" };
  }
  return undefined;
}

function recordsFromUnknown(value: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(value.records)) return value.records;
  if (Array.isArray(value.subagents)) return value.subagents;
  if (value.subagent !== undefined) return [value.subagent];
  return undefined;
}

function parseRecentActivity(value: unknown): AcpSubagentRecentActivity | undefined {
  if (!isRecord(value) || typeof value.updatedAt !== "number") return undefined;
  return {
    updatedAt: value.updatedAt,
    assistantMessages: boundStringList(value.assistantMessages),
    toolCalls: boundStringList(value.toolCalls),
  };
}

function parseTerminal(value: unknown): AcpSubagentTerminal | undefined {
  if (!isRecord(value)) return undefined;
  if (!TERMINAL_KINDS.has(value.kind as string) || typeof value.endedAt !== "number") {
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
    endedAt: value.endedAt,
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    ...(reportStatus ? { reportStatus } : {}),
  };
}

function parseUsage(value: unknown): RuntimeTaskUsage | undefined {
  if (!isRecord(value)) return undefined;
  const totalTokens = nonNegativeInt(value.totalTokens);
  if (totalTokens === undefined) return undefined;
  const inputTokens = nonNegativeInt(value.inputTokens);
  const cachedInputTokens = nonNegativeInt(value.cachedInputTokens);
  const outputTokens = nonNegativeInt(value.outputTokens);
  const reasoningOutputTokens = nonNegativeInt(value.reasoningOutputTokens);
  const toolUses = nonNegativeInt(value.toolUses);
  const durationMs = nonNegativeInt(value.durationMs);
  return {
    totalTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
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

function boundId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= MAX_ID ? trimmed : trimmed.slice(0, MAX_ID);
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
