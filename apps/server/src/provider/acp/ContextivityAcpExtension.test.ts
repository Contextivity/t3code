import { describe, expect, it } from "vite-plus/test";

import {
  ACP_SUBAGENT_EVENT_METHOD,
  ACP_SUBAGENT_EVENTS_VERSION,
  acpRegistryClientCapabilities,
  agentAdvertisesContextivitySubagentEvents,
  parseAcpSubagentEvent,
  summarizeAcpSubagentEvent,
} from "./ContextivityAcpExtension.ts";

function record(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "child-1",
    state: "running",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("ContextivityAcpExtension", () => {
  it("advertises client capability version 1", () => {
    expect(acpRegistryClientCapabilities()).toEqual({
      _meta: { contextivity: { subagentEvents: { version: 1 } } },
    });
    expect(ACP_SUBAGENT_EVENT_METHOD).toBe("_contextivity/subagent_event");
    expect(ACP_SUBAGENT_EVENTS_VERSION).toBe(1);
  });

  it("negotiates matching agent _meta version 1 only", () => {
    expect(agentAdvertisesContextivitySubagentEvents(undefined)).toBe(false);
    expect(agentAdvertisesContextivitySubagentEvents({ _meta: {} })).toBe(false);
    expect(
      agentAdvertisesContextivitySubagentEvents({
        _meta: { contextivity: { subagentEvents: { version: 2 } } },
      }),
    ).toBe(false);
    expect(
      agentAdvertisesContextivitySubagentEvents({
        _meta: { contextivity: { subagentEvents: { version: 1 } } },
      }),
    ).toBe(true);
  });

  it("parses producer snapshot and delta envelopes", () => {
    const snapshot = parseAcpSubagentEvent({
      version: 1,
      sessionId: "sess-1",
      sequence: 1,
      kind: "snapshot",
      records: [record({ parentAgentId: "root", displayName: "Scout", typeName: "scout" })],
      extra: "ignored",
    });
    expect(snapshot).toMatchObject({
      version: 1,
      sessionId: "sess-1",
      sequence: 1,
      kind: "snapshot",
      records: [{ agentId: "child-1", parentAgentId: "root", typeName: "scout" }],
    });
    expect(snapshot).not.toHaveProperty("change");

    const delta = parseAcpSubagentEvent({
      version: 1,
      sessionId: "sess-1",
      sequence: 2,
      kind: "delta",
      change: "started",
      records: [record()],
    });
    expect(delta?.change).toBe("started");
  });

  it("rejects draft kind aliases and non-records envelopes", () => {
    for (const kind of ["started", "progress", "status", "completed", "updated", "terminal"]) {
      expect(
        parseAcpSubagentEvent({
          version: 1,
          sessionId: "s",
          sequence: 1,
          kind,
          records: [record()],
        }),
      ).toBeUndefined();
    }
    expect(
      parseAcpSubagentEvent({
        version: 1,
        sessionId: "s",
        sequence: 2,
        kind: "delta",
        change: "progress",
        records: [record()],
      }),
    ).toBeUndefined();
    expect(
      parseAcpSubagentEvent({
        version: 1,
        sessionId: "s",
        sequence: 3,
        kind: "delta",
        change: "started",
        subagent: record(),
      }),
    ).toBeUndefined();
    expect(
      parseAcpSubagentEvent({
        version: 1,
        sessionId: "s",
        sequence: 4,
        kind: "snapshot",
        subagents: [record()],
      }),
    ).toBeUndefined();
  });

  it("rejects malformed envelopes and unparseable records", () => {
    expect(
      parseAcpSubagentEvent({
        version: 1,
        sessionId: "s",
        sequence: 0,
        kind: "snapshot",
        records: [],
      }),
    ).toBeUndefined();
    expect(
      parseAcpSubagentEvent({
        version: 2,
        sessionId: "s",
        sequence: 1,
        kind: "snapshot",
        records: [],
      }),
    ).toBeUndefined();
    expect(
      parseAcpSubagentEvent({
        version: 1,
        sessionId: "s",
        sequence: 1,
        kind: "delta",
        records: [record()],
      }),
    ).toBeUndefined();
    expect(parseAcpSubagentEvent("nope")).toBeUndefined();
    expect(
      parseAcpSubagentEvent({
        version: 1,
        sessionId: "s",
        sequence: 1,
        kind: "snapshot",
        records: [record(), { agentId: "bad" }],
      }),
    ).toBeUndefined();
  });

  it("redacts and truncates display fields without inventing usage", () => {
    const parsed = parseAcpSubagentEvent({
      version: 1,
      sessionId: "s",
      sequence: 1,
      kind: "delta",
      change: "updated",
      records: [
        record({
          description: `api_key=sk-live-123 ${"x".repeat(400)}`,
          latestActivity: `token=super-secret ${"y".repeat(400)}`,
          unknownField: { nested: true },
          usage: { totalTokens: 9, inputTokens: 3, outputTokens: -1 },
          recentActivity: {
            updatedAt: 2,
            assistantMessages: ["one", "two", "three", "four", "five", "six"],
            toolCalls: ["read"],
          },
        }),
      ],
    });
    expect(parsed?.records).toHaveLength(1);
    expect(parsed?.records[0]?.description).toContain("[redacted]");
    expect(parsed?.records[0]?.description?.length).toBeLessThanOrEqual(160);
    expect(parsed?.records[0]?.latestActivity).toContain("[redacted]");
    expect(parsed?.records[0]?.latestActivity?.length).toBeLessThanOrEqual(160);
    expect(parsed?.records[0]).not.toHaveProperty("unknownField");
    expect(parsed?.records[0]).not.toHaveProperty("usage");
    expect(parsed?.records[0]?.recentActivity?.assistantMessages).toHaveLength(5);
  });

  it("rejects oversized identities and caps snapshot, delta, and lineage bounds", () => {
    expect(
      parseAcpSubagentEvent({
        version: 1,
        sessionId: "s".repeat(129),
        sequence: 1,
        kind: "snapshot",
        records: [record()],
      }),
    ).toBeUndefined();
    expect(
      parseAcpSubagentEvent({
        version: 1,
        sessionId: "s",
        sequence: 1,
        kind: "snapshot",
        records: [record({ agentId: "x".repeat(129) })],
      }),
    ).toBeUndefined();

    const snapshot = parseAcpSubagentEvent({
      version: 1,
      sessionId: "s",
      sequence: 1,
      kind: "snapshot",
      records: Array.from({ length: 64 }, (_, index) => record({ agentId: `a${index}` })),
    });
    expect(snapshot?.records).toHaveLength(64);
    expect(
      parseAcpSubagentEvent({
        version: 1,
        sessionId: "s",
        sequence: 1,
        kind: "snapshot",
        records: Array.from({ length: 65 }, (_, index) => record({ agentId: `a${index}` })),
      }),
    ).toBeUndefined();

    const delta = parseAcpSubagentEvent({
      version: 1,
      sessionId: "s",
      sequence: 2,
      kind: "delta",
      change: "updated",
      records: Array.from({ length: 12 }, (_, index) => record({ agentId: `d${index}` })),
    });
    expect(delta?.records).toHaveLength(8);

    const withLineage = parseAcpSubagentEvent({
      version: 1,
      sessionId: "s",
      sequence: 3,
      kind: "snapshot",
      records: [
        record({
          lineage: Array.from({ length: 12 }, (_, index) => `id-${index}`),
        }),
      ],
    });
    expect(withLineage?.records[0]?.lineage).toHaveLength(8);
    expect(
      parseAcpSubagentEvent({
        version: 1,
        sessionId: "s",
        sequence: 4,
        kind: "snapshot",
        records: [record({ lineage: ["ok", "x".repeat(129), "kept"] })],
      })?.records[0]?.lineage,
    ).toEqual(["ok", "kept"]);
  });

  it("summarizes payloads without copying secrets", () => {
    const summary = summarizeAcpSubagentEvent({
      version: 1,
      sessionId: "sess",
      sequence: 8,
      kind: "delta",
      change: "updated",
      records: [record({ description: "token=secret-value" })],
    });
    expect(summary).toMatchObject({
      version: 1,
      sessionId: "sess",
      sequence: 8,
      kind: "delta",
      recordCount: 1,
      agentIds: ["child-1"],
    });
    expect(JSON.stringify(summary)).not.toContain("secret-value");
  });
});
