import { classifyTaskAgentKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AcpSubagentEventPayload, AcpSubagentRecord } from "./ContextivityAcpExtension.ts";
import {
  emptyContextivitySubagentMapperState,
  mapContextivitySubagentEvent,
  type ContextivityMappedTaskEvent,
  type ContextivitySubagentMapperState,
} from "./ContextivityAcpSubagentMapper.ts";

function record(overrides: Partial<AcpSubagentRecord> = {}): AcpSubagentRecord {
  return {
    agentId: "child-1",
    state: "running",
    updatedAt: 1,
    ...overrides,
  };
}

function event(
  overrides: Partial<AcpSubagentEventPayload> & Pick<AcpSubagentEventPayload, "sequence" | "kind">,
): AcpSubagentEventPayload {
  return {
    version: 1,
    sessionId: "sess",
    records: [record()],
    ...overrides,
  };
}

function apply(
  payload: AcpSubagentEventPayload,
  state: ContextivitySubagentMapperState = emptyContextivitySubagentMapperState(),
) {
  return mapContextivitySubagentEvent(payload, state);
}

function types(events: ReadonlyArray<ContextivityMappedTaskEvent>) {
  return events.map((entry) => entry.type);
}

describe("ContextivityAcpSubagentMapper", () => {
  it("maps start/progress/waiting/idle/completion and classifies as an agent task", () => {
    let state = emptyContextivitySubagentMapperState();
    const started = apply(
      event({
        sequence: 1,
        kind: "delta",
        change: "started",
        records: [
          record({
            displayName: "Scout",
            typeName: "scout",
            description: "Inspect the repo",
            modelId: "gpt-5.4-mini",
            parentAgentId: "root",
            lineage: ["root", "child-1"],
            state: "spawned",
          }),
        ],
      }),
      state,
    );
    state = started.state;
    expect(started.events[0]).toMatchObject({
      type: "task.started",
      payload: {
        taskId: "child-1",
        title: "Scout",
        role: "scout",
        model: "gpt-5.4-mini",
        parentAgentId: "root",
        taskType: "subagent",
        timelineBypass: true,
        agentPath: "/root/child-1",
      },
    });
    expect(started.events[0]?.payload).not.toHaveProperty("agentId");
    expect(
      classifyTaskAgentKind({
        taskType:
          started.events[0]?.type === "task.started"
            ? started.events[0].payload.taskType
            : undefined,
      }),
    ).toBe("agent");

    const waiting = apply(
      event({
        sequence: 2,
        kind: "delta",
        change: "updated",
        records: [record({ state: "waiting_approval", latestActivity: "needs permission" })],
      }),
      state,
    );
    expect(
      waiting.events.some(
        (entry) => entry.type === "task.updated" && entry.payload.status === "waiting",
      ),
    ).toBe(true);
    expect(waiting.events.some((entry) => entry.type === "task.progress")).toBe(true);
    state = waiting.state;

    const idle = apply(
      event({
        sequence: 3,
        kind: "delta",
        change: "updated",
        records: [record({ state: "idle" })],
      }),
      state,
    );
    expect(
      idle.events.some((entry) => entry.type === "task.updated" && entry.payload.status === "idle"),
    ).toBe(true);
    state = idle.state;

    const completed = apply(
      event({
        sequence: 4,
        kind: "delta",
        change: "terminal",
        records: [
          record({
            state: "completed",
            terminal: { kind: "completed", endedAt: 2, summary: "done" },
          }),
        ],
      }),
      state,
    );
    expect(completed.events).toMatchObject([
      { type: "task.completed", payload: { status: "completed", summary: "done" } },
    ]);
  });

  it("emits cancelled then stopped for cancellation", () => {
    const { events } = apply(
      event({
        sequence: 1,
        kind: "delta",
        change: "terminal",
        records: [record({ state: "cancelled", terminal: { kind: "cancelled", endedAt: 2 } })],
      }),
    );
    expect(events).toMatchObject([
      { type: "task.started" },
      { type: "task.updated", payload: { status: "cancelled" } },
      { type: "task.completed", payload: { status: "stopped" } },
    ]);
  });

  it("treats a later summary patch as updated, not a second terminal", () => {
    let state = emptyContextivitySubagentMapperState();
    const completed = apply(
      event({
        sequence: 1,
        kind: "delta",
        change: "terminal",
        records: [
          record({
            runtimeEpoch: 1,
            state: "completed",
            terminal: { kind: "completed", endedAt: 2, summary: "done" },
          }),
        ],
      }),
      state,
    );
    state = completed.state;
    const patch = apply(
      event({
        sequence: 2,
        kind: "delta",
        change: "updated",
        records: [
          record({
            runtimeEpoch: 1,
            state: "completed",
            latestActivity: "wrote report",
            terminal: { kind: "completed", endedAt: 2, summary: "done, with notes" },
          }),
        ],
      }),
      state,
    );
    expect(patch.events.some((entry) => entry.type === "task.completed")).toBe(false);
    expect(patch.events.some((entry) => entry.type === "task.progress")).toBe(true);
  });

  it("supports concurrent children and nesting", () => {
    const { events } = apply(
      event({
        sequence: 1,
        kind: "snapshot",
        records: [
          record({ agentId: "parent", displayName: "Coordinator", typeName: "coordinator" }),
          record({
            agentId: "child-a",
            parentAgentId: "parent",
            displayName: "Worker A",
            typeName: "worker",
          }),
          record({
            agentId: "child-b",
            parentAgentId: "parent",
            displayName: "Worker B",
            typeName: "worker",
            latestActivity: "searching",
          }),
        ],
      }),
    );
    const startedIds = events
      .filter((entry) => entry.type === "task.started")
      .map((entry) => entry.payload.taskId);
    expect(startedIds).toEqual(["parent", "child-a", "child-b"]);
    expect(
      events.find((entry) => entry.type === "task.started" && entry.payload.taskId === "child-a")
        ?.payload.parentAgentId,
    ).toBe("parent");
  });

  it("ignores duplicate and out-of-order sequences and does not emit duplicate terminals", () => {
    let state = emptyContextivitySubagentMapperState();
    const first = apply(
      event({
        sequence: 1,
        kind: "delta",
        change: "started",
        records: [record({ state: "spawned" })],
      }),
      state,
    );
    state = first.state;
    const dup = apply(
      event({
        sequence: 1,
        kind: "delta",
        change: "terminal",
        records: [record({ state: "failed" })],
      }),
      state,
    );
    expect(dup.events).toEqual([]);
    const third = apply(
      event({
        sequence: 3,
        kind: "delta",
        change: "terminal",
        records: [
          record({
            state: "completed",
            terminal: { kind: "completed", endedAt: 2, summary: "first terminal" },
          }),
        ],
      }),
      state,
    );
    state = third.state;
    expect(types(third.events)).toContain("task.completed");
    const late = apply(
      event({
        sequence: 2,
        kind: "delta",
        change: "terminal",
        records: [record({ state: "failed", terminal: { kind: "failed", endedAt: 3 } })],
      }),
      state,
    );
    expect(late.events).toEqual([]);
    const duplicateTerminal = apply(
      event({
        sequence: 4,
        kind: "delta",
        change: "terminal",
        records: [record({ state: "failed", terminal: { kind: "failed", endedAt: 4 } })],
      }),
      state,
    );
    expect(duplicateTerminal.events).toEqual([]);
  });

  it("snapshot restore does not resurrect a same-epoch completed child", () => {
    let state = emptyContextivitySubagentMapperState();
    const completed = apply(
      event({
        sequence: 1,
        kind: "delta",
        change: "terminal",
        records: [
          record({
            runtimeEpoch: 1,
            state: "completed",
            terminal: { kind: "completed", endedAt: 2, summary: "done" },
          }),
        ],
      }),
      state,
    );
    state = completed.state;
    const snapshot = apply(
      event({
        sequence: 2,
        kind: "snapshot",
        records: [
          record({
            runtimeEpoch: 1,
            state: "completed",
            terminal: { kind: "completed", endedAt: 2, summary: "done" },
          }),
        ],
      }),
      state,
    );
    expect(snapshot.events).toEqual([]);
  });

  it("higher runtimeEpoch is a fresh start, not a resurrection", () => {
    let state = emptyContextivitySubagentMapperState();
    const first = apply(
      event({
        sequence: 1,
        kind: "delta",
        change: "terminal",
        records: [
          record({
            runtimeEpoch: 1,
            state: "completed",
            terminal: { kind: "completed", endedAt: 2 },
          }),
        ],
      }),
      state,
    );
    state = first.state;
    const respawn = apply(
      event({
        sequence: 2,
        kind: "delta",
        change: "started",
        records: [record({ runtimeEpoch: 2, state: "running", displayName: "Scout" })],
      }),
      state,
    );
    expect(respawn.events[0]).toMatchObject({ type: "task.started", payload: { title: "Scout" } });
  });

  it("snapshot cancels missing non-terminal children", () => {
    let state = emptyContextivitySubagentMapperState();
    const two = apply(
      event({
        sequence: 1,
        kind: "snapshot",
        records: [record({ agentId: "keep" }), record({ agentId: "drop" })],
      }),
      state,
    );
    state = two.state;
    const next = apply(
      event({
        sequence: 2,
        kind: "snapshot",
        records: [record({ agentId: "keep", state: "running" })],
      }),
      state,
    );
    expect(
      next.events.some(
        (entry) =>
          entry.type === "task.updated" &&
          entry.payload.taskId === "drop" &&
          entry.payload.status === "cancelled",
      ),
    ).toBe(true);
    expect(
      next.events.some(
        (entry) =>
          entry.type === "task.completed" &&
          entry.payload.taskId === "drop" &&
          entry.payload.status === "stopped",
      ),
    ).toBe(true);
  });
});
