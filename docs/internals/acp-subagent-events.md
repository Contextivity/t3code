# ACP sub-agent events

T3 Code's ACP Registry client can ingest a namespaced ACP extension that carries
typed sub-agent lifecycle. Any ACP agent may implement it. Contextivity is the
first producer (`contextivity-agent --mode acp`).

Do not infer child identity or status from tool names or thought text. Standard
ACP `session/update` traffic stays unchanged for agents that omit this
extension.

## Capability negotiation

On `initialize`, T3 always advertises:

```json
{
  "clientCapabilities": {
    "_meta": {
      "contextivity": {
        "subagentEvents": { "version": 1 }
      }
    }
  }
}
```

T3 ingests events only when the agent advertises the matching version on
`agentCapabilities._meta`. A missing `_meta`, a different version, or events
sent without advertisement are ignored. The primary turn continues.

## Notification

JSON-RPC method: `_contextivity/subagent_event`.

| Field       | Meaning                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| `version`   | Always `1`                                                                          |
| `sessionId` | ACP session id for this connection                                                  |
| `sequence`  | Per-session integer starting at `1`; duplicates and out-of-order deltas are ignored |
| `kind`      | `snapshot` (reconcile roster) or `delta` (one change)                               |
| `change`    | Deltas only: `started`, `updated`, or `terminal`                                    |
| `records`   | Bounded child records. Aliases `subagent` / `subagents` are also accepted           |

T3 also accepts host-task kind aliases (`started`, `progress`, `status`,
`completed`) and maps them onto `delta` + `change`. Producers should emit the
snapshot/delta wire.

Emit a `snapshot` after `session/new`, `session/load`, and reconnect. Parents
before children. `change: "terminal"` once per `agentId`+`runtimeEpoch`. A later
summary patch is `updated`. A new `runtimeEpoch` is a fresh start, not a
resurrection.

## Record fields

Authoritative, bounded, sanitized. Omit usage unless the runtime actually has
per-child counts.

| Field                                                   | Notes                                                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `agentId`                                               | Stable child id. T3 uses this as `taskId`, never as `TaskAgentLinkage.agentId`                                        |
| `parentAgentId`                                         | Direct parent when nested                                                                                             |
| `displayName`, `typeName`, `role`                       | Title / role. `role` may mirror `typeName`                                                                            |
| `lineage`                                               | Root-first id path including self                                                                                     |
| `spawnDepth`                                            | `0` = direct child of the orchestrator                                                                                |
| `taskId`, `taskSubject`, `description`                  | Subject/preview only; never the full prompt                                                                           |
| `state`                                                 | `spawned`, `running`, `waiting_input`, `waiting_approval`, `idle`, `resetting`, `completed`, `failed`, `cancelled`    |
| `modelId`                                               | Compact model id when known                                                                                           |
| `latestActivity`, `lastToolName`, `recentActivity`      | Bounded recent assistant/tool strings                                                                                 |
| `terminal`                                              | `kind`, `endedAt`, optional bounded `summary` / `error` / `reportStatus`                                              |
| `usage`                                                 | Optional `{ totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, toolUses, durationMs }` |
| `runtimeEpoch`, `startedAt`, `completedAt`, `updatedAt` | Timing / identity. `updatedAt` is required                                                                            |

Hidden reasoning, secrets, env/auth, cwd, session files, process ids, and
unbounded transcripts must not be included. Malformed optional fields drop that
record; a bad envelope is ignored. The primary turn must not fail.

## T3 mapping

Ingestion lives on ACP Registry only. Cursor and Grok ignore the extension
notification.

| Producer                     | Canonical event                                          |
| ---------------------------- | -------------------------------------------------------- |
| First observation of a child | `task.started`                                           |
| Activity / usage             | `task.progress`                                          |
| Non-terminal `state`         | `task.updated` (`pending`, `running`, `waiting`, `idle`) |
| `completed` / `failed`       | `task.completed` with that status                        |
| `cancelled`                  | `task.updated` cancelled, then `task.completed` stopped  |

Every mapped event sets `taskType: "subagent"` and `timelineBypass: true` so
`ProviderRuntimeIngestion` stamps `agentKind=agent` and the existing
`subagentRuntime` fold / Agents panel can render it. Child identity is `taskId`.
Snapshots cancel known non-terminal children that disappeared. Events are
processed even when no turn is active (session load / snapshot).
