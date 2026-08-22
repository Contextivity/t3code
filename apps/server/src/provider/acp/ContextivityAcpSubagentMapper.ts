/**
 * Maps negotiated ACP sub-agent events onto T3's canonical task.* lifecycle.
 *
 * Child identity is `taskId` = record.agentId. `parentAgentId` is preserved.
 * Do not put the child id in TaskAgentLinkage.agentId (that field is the owner
 * of a nested background task). `taskType` is always `subagent` so ingestion
 * stamps agentKind=agent. timelineBypass keeps rows off the parent chat.
 */

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  RuntimeTaskId,
  type RuntimeTaskStatus,
  type TaskCompletedPayload,
  type TaskProgressPayload,
  type TaskStartedPayload,
  type TaskUpdatedPayload,
} from "@t3tools/contracts";

import {
  isAcpSubagentTerminalState,
  type AcpSubagentEventPayload,
  type AcpSubagentLifecycleState,
  type AcpSubagentRecord,
} from "./ContextivityAcpExtension.ts";

export type ContextivityMappedTaskEvent =
  | { readonly type: "task.started"; readonly payload: TaskStartedPayload }
  | { readonly type: "task.progress"; readonly payload: TaskProgressPayload }
  | { readonly type: "task.updated"; readonly payload: TaskUpdatedPayload }
  | { readonly type: "task.completed"; readonly payload: TaskCompletedPayload };

interface TrackedChild {
  runtimeEpoch: number;
  startedEmitted: boolean;
  terminalEmitted: boolean;
  lastStatus?: RuntimeTaskStatus;
}

export interface ContextivitySubagentMapperState {
  lastSequence: number;
  children: Map<string, TrackedChild>;
}

export function emptyContextivitySubagentMapperState(): ContextivitySubagentMapperState {
  return { lastSequence: 0, children: new Map() };
}

export function mapContextivitySubagentEvent(
  payload: AcpSubagentEventPayload,
  state: ContextivitySubagentMapperState,
): {
  readonly events: ReadonlyArray<ContextivityMappedTaskEvent>;
  readonly state: ContextivitySubagentMapperState;
} {
  if (payload.sequence <= state.lastSequence) {
    return { events: [], state };
  }

  const next: ContextivitySubagentMapperState = {
    lastSequence: payload.sequence,
    children: new Map(state.children),
  };
  const events: ContextivityMappedTaskEvent[] = [];

  if (payload.kind === "snapshot") {
    const seen = new Set(payload.records.map((record) => record.agentId));
    for (const [agentId, child] of next.children) {
      if (!seen.has(agentId) && !child.terminalEmitted) {
        emitCancelled(events, agentId, child);
      }
    }
    for (const record of payload.records) {
      applyRecord(events, next, record);
    }
    return { events, state: next };
  }

  for (const record of payload.records) {
    applyRecord(events, next, record, payload.change);
  }
  return { events, state: next };
}

function applyRecord(
  events: ContextivityMappedTaskEvent[],
  state: ContextivitySubagentMapperState,
  record: AcpSubagentRecord,
  change?: AcpSubagentEventPayload["change"],
): void {
  const epoch = record.runtimeEpoch ?? 0;
  const existing = state.children.get(record.agentId);
  if (existing && epoch < existing.runtimeEpoch) {
    return;
  }

  const isNewEpoch = existing === undefined || epoch > existing.runtimeEpoch;
  const child: TrackedChild = isNewEpoch
    ? { runtimeEpoch: epoch, startedEmitted: false, terminalEmitted: false }
    : existing;
  if (isNewEpoch) {
    state.children.set(record.agentId, child);
  }

  const terminal = isAcpSubagentTerminalState(record.state) || change === "terminal";
  if (child.terminalEmitted && !isNewEpoch) {
    if (terminal) return;
    emitProgressIfPresent(events, record);
    return;
  }

  if (!child.startedEmitted || isNewEpoch) {
    events.push({ type: "task.started", payload: startedPayload(record) });
    child.startedEmitted = true;
    child.terminalEmitted = false;
    child.lastStatus = "running";
  }

  if (terminal) {
    emitTerminal(events, record, child);
    return;
  }

  emitProgressIfPresent(events, record);

  const status = statusFromLifecycle(record.state);
  if (status !== undefined && status !== child.lastStatus) {
    events.push({
      type: "task.updated",
      payload: {
        taskId: RuntimeTaskId.make(record.agentId),
        status,
        ...linkage(record),
        ...(record.description || record.taskSubject
          ? { description: record.description ?? record.taskSubject }
          : {}),
      },
    });
    child.lastStatus = status;
  }
}

function emitTerminal(
  events: ContextivityMappedTaskEvent[],
  record: AcpSubagentRecord,
  child: TrackedChild,
): void {
  const summary = terminalSummary(record);
  const error = record.terminal?.error;
  const endedAt = epochMillisToIso(record.completedAt ?? record.terminal?.endedAt);

  if (record.state === "cancelled" || record.terminal?.kind === "cancelled") {
    events.push({
      type: "task.updated",
      payload: {
        taskId: RuntimeTaskId.make(record.agentId),
        status: "cancelled",
        ...linkage(record),
        ...(error ? { error } : {}),
        ...(endedAt ? { endedAt } : {}),
      },
    });
    events.push({
      type: "task.completed",
      payload: {
        taskId: RuntimeTaskId.make(record.agentId),
        status: "stopped",
        ...linkage(record),
        ...(summary ? { summary } : {}),
        ...(record.usage ? { typedUsage: record.usage } : {}),
      },
    });
    child.terminalEmitted = true;
    child.lastStatus = "cancelled";
    return;
  }

  const failed = record.state === "failed" || record.terminal?.kind === "failed";
  events.push({
    type: "task.completed",
    payload: {
      taskId: RuntimeTaskId.make(record.agentId),
      status: failed ? "failed" : "completed",
      ...linkage(record),
      ...(summary ? { summary } : {}),
      ...(record.usage ? { typedUsage: record.usage } : {}),
    },
  });
  child.terminalEmitted = true;
  child.lastStatus = failed ? "failed" : "completed";
}

function emitCancelled(
  events: ContextivityMappedTaskEvent[],
  agentId: string,
  child: TrackedChild,
): void {
  const taskId = RuntimeTaskId.make(agentId);
  const identity = {
    taskType: "subagent",
    timelineBypass: true,
  } as const;
  events.push({
    type: "task.updated",
    payload: { taskId, status: "cancelled", ...identity },
  });
  events.push({
    type: "task.completed",
    payload: { taskId, status: "stopped", ...identity },
  });
  child.terminalEmitted = true;
  child.lastStatus = "cancelled";
}

function emitProgressIfPresent(
  events: ContextivityMappedTaskEvent[],
  record: AcpSubagentRecord,
): void {
  const summary =
    record.latestActivity ??
    record.lastToolName ??
    record.recentActivity?.assistantMessages.at(-1) ??
    record.recentActivity?.toolCalls.at(-1);
  if (!summary && !record.lastToolName && !record.usage) return;
  const description =
    record.displayName ?? record.description ?? record.taskSubject ?? record.agentId;
  events.push({
    type: "task.progress",
    payload: {
      taskId: RuntimeTaskId.make(record.agentId),
      description,
      ...linkage(record),
      ...(summary ? { summary } : {}),
      ...(record.lastToolName ? { lastToolName: record.lastToolName } : {}),
      ...(record.usage ? { typedUsage: record.usage } : {}),
    },
  });
}

function startedPayload(record: AcpSubagentRecord): TaskStartedPayload {
  const title = record.displayName ?? record.agentId;
  const description = record.description ?? record.taskSubject ?? title;
  return {
    taskId: RuntimeTaskId.make(record.agentId),
    description,
    ...linkage(record),
    title,
  };
}

function linkage(record: AcpSubagentRecord): {
  readonly taskType: "subagent";
  readonly title?: string;
  readonly role?: string;
  readonly model?: string;
  readonly parentAgentId?: string;
  readonly agentPath?: string;
  readonly timelineBypass: true;
} {
  const title = record.displayName;
  const role = record.role ?? record.typeName;
  const agentPath =
    record.lineage && record.lineage.length > 0 ? `/${record.lineage.join("/")}` : undefined;
  return {
    taskType: "subagent",
    timelineBypass: true,
    ...(title ? { title } : {}),
    ...(role ? { role } : {}),
    ...(record.modelId ? { model: record.modelId } : {}),
    ...(record.parentAgentId ? { parentAgentId: record.parentAgentId } : {}),
    ...(agentPath ? { agentPath } : {}),
  };
}

function statusFromLifecycle(state: AcpSubagentLifecycleState): RuntimeTaskStatus | undefined {
  switch (state) {
    case "spawned":
      return "pending";
    case "running":
    case "resetting":
      return "running";
    case "waiting_input":
    case "waiting_approval":
      return "waiting";
    case "idle":
      return "idle";
    default:
      return undefined;
  }
}

function terminalSummary(record: AcpSubagentRecord): string | undefined {
  return record.terminal?.summary ?? record.terminal?.error ?? record.description;
}

function epochMillisToIso(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return Option.getOrUndefined(Option.map(DateTime.make(ms), DateTime.formatIso));
}
