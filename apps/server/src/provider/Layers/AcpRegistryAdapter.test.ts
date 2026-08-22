// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  AcpRegistrySettings,
  ApprovalRequestId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  acpRegistryPromptSettlementBelongsToContext,
  makeAcpRegistryAdapter,
} from "./AcpRegistryAdapter.ts";

const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function makeMockAcpRegistryWrapper(extraEnv?: Record<string, string>, argLogPath?: string) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-acp-agent.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const argLogLine = argLogPath ? `printf '%s\\n' "$@" > ${JSON.stringify(argLogPath)}` : "";
  const script = `#!/bin/sh
${envExports}
${argLogLine}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const acpRegistryAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-acp-registry-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (
  input: { readonly binaryPath: string } & Partial<AcpRegistrySettings>,
  options?: Parameters<typeof makeAcpRegistryAdapter>[1],
) => makeAcpRegistryAdapter(decodeAcpRegistrySettings(input), options).pipe(Effect.orDie);

it("requires a settlement to match the live ACP Registry turn", () => {
  const staleTurnId = ThreadId.make("stale-turn") as unknown as import("@t3tools/contracts").TurnId;
  const replacementTurnId = ThreadId.make(
    "replacement-turn",
  ) as unknown as import("@t3tools/contracts").TurnId;

  assert.isFalse(
    acpRegistryPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    acpRegistryPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it.layer(acpRegistryAdapterTestLayer)("AcpRegistryAdapterLive", (it) => {
  it.effect("passes launch arguments to the ACP agent", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-launch-args");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-args-")),
      );
      const argLogPath = NodePath.join(tempDir, "args.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper(undefined, argLogPath),
      );
      const adapter = yield* makeTestAdapter({
        binaryPath: wrapperPath,
        launchArgs: "--mode acp",
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const argLog = yield* Effect.promise(() => NodeFSP.readFile(argLogPath, "utf8"));
      assert.equal(argLog.trim(), "--mode\nacp");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("authenticates with the configured method id", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-auth-configured");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-auth-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_AUTH_METHODS: "token,api_key",
        }),
      );
      const adapter = yield* makeTestAdapter({
        binaryPath: wrapperPath,
        authMethodId: "api_key",
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            entry.method === "authenticate" &&
            typeof entry.params === "object" &&
            entry.params !== null &&
            (entry.params as { methodId?: string }).methodId === "api_key",
        ),
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("skips authenticate when the agent advertises no methods", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-auth-none");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-auth-none-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_AUTH_METHODS: "",
        }),
      );
      const adapter = yield* makeTestAdapter({ binaryPath: wrapperPath });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isFalse(requests.some((entry) => entry.method === "authenticate"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("omits T3 MCP servers when the agent does not advertise HTTP MCP", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-mcp-omit");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-mcp-omit-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_REJECT_MCP: "1",
        }),
      );
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("env-1"),
        threadId,
        providerSessionId: "mcp-session",
        providerInstanceId: ProviderInstanceId.make("acpRegistry"),
        endpoint: "http://127.0.0.1:9/mcp",
        authorizationHeader: "Bearer test",
      });
      const adapter = yield* makeTestAdapter({
        binaryPath: wrapperPath,
        attachMcpWhenSupported: true,
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const sessionNew = requests.find((entry) => entry.method === "session/new");
      assert.isDefined(sessionNew);
      const params = sessionNew?.params as { mcpServers?: unknown[] } | undefined;
      assert.deepStrictEqual(params?.mcpServers ?? [], []);

      McpProviderSession.clearMcpProviderSession(threadId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("attaches T3 MCP when the agent advertises HTTP MCP", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-mcp-attach");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-mcp-attach-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_ADVERTISE_HTTP_MCP: "1",
        }),
      );
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("env-1"),
        threadId,
        providerSessionId: "mcp-session",
        providerInstanceId: ProviderInstanceId.make("acpRegistry"),
        endpoint: "http://127.0.0.1:9/mcp",
        authorizationHeader: "Bearer test",
      });
      const adapter = yield* makeTestAdapter({
        binaryPath: wrapperPath,
        attachMcpWhenSupported: true,
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const sessionNew = requests.find((entry) => entry.method === "session/new");
      const params = sessionNew?.params as
        | { mcpServers?: ReadonlyArray<{ name?: string }> }
        | undefined;
      assert.isTrue(params?.mcpServers?.some((server) => server.name === "t3-code") === true);

      McpProviderSession.clearMcpProviderSession(threadId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("never sends MCP servers when the attach switch is off", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-mcp-never");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-mcp-never-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_ADVERTISE_HTTP_MCP: "1",
          T3_ACP_REJECT_MCP: "1",
        }),
      );
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("env-1"),
        threadId,
        providerSessionId: "mcp-session",
        providerInstanceId: ProviderInstanceId.make("acpRegistry"),
        endpoint: "http://127.0.0.1:9/mcp",
        authorizationHeader: "Bearer test",
      });
      const adapter = yield* makeTestAdapter({
        binaryPath: wrapperPath,
        attachMcpWhenSupported: false,
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const sessionNew = requests.find((entry) => entry.method === "session/new");
      const params = sessionNew?.params as { mcpServers?: unknown[] } | undefined;
      assert.deepStrictEqual(params?.mcpServers ?? [], []);

      McpProviderSession.clearMcpProviderSession(threadId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("starts a session, switches models, and maps prompt events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-prompt-flow");
      const wrapperPath = yield* Effect.promise(() => makeMockAcpRegistryWrapper());
      const adapter = yield* makeTestAdapter({ binaryPath: wrapperPath });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("acpRegistry"),
          model: "grok-mock-alt",
        },
      });

      assert.equal(session.provider, "acpRegistry");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello registry",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
        assert.equal(delta.payload.streamKind, "assistant_text");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("applies config option selections after session start", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-config-options");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-config-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter({ binaryPath: wrapperPath });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("acpRegistry"),
          model: "grok-build",
          options: [{ id: "mode", value: "code" }],
        },
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            typeof entry.params === "object" &&
            entry.params !== null &&
            (entry.params as { configId?: string; value?: string }).configId === "mode" &&
            (entry.params as { value?: string }).value === "code",
        ),
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps reasoning chunks to reasoning_text content deltas", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-thought");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({
          T3_ACP_EMIT_THOUGHT: "1",
        }),
      );
      const adapter = yield* makeTestAdapter({ binaryPath: wrapperPath });
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "think first", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const thought = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.isDefined(thought);
      if (thought?.type === "content.delta") {
        assert.equal(thought.payload.delta, "thinking out loud");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("preserves namespaced tool-call metadata on canonical tool data", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-tool-meta");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_EMIT_TOOL_META: "1",
        }),
      );
      const adapter = yield* makeTestAdapter({ binaryPath: wrapperPath });
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "request.opened") {
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            );
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "run a tool", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const toolEvent = runtimeEvents.find(
        (event) =>
          (event.type === "item.updated" || event.type === "item.completed") &&
          event.payload.itemType !== "assistant_message",
      );
      assert.isDefined(toolEvent);
      if (toolEvent?.type === "item.updated" || toolEvent?.type === "item.completed") {
        const data = toolEvent.payload.data as { _meta?: unknown } | undefined;
        assert.deepStrictEqual(data?._meta, {
          "contextivity.dev/subagent": { id: "child-1", title: "Subagent" },
        });
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sends image attachments as ACP image prompt parts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-image");
      const serverConfig = yield* ServerConfig;
      const attachmentId = "acp-registry-image-11111111-1111-4111-8111-111111111111";
      const imagePath = NodePath.join(serverConfig.attachmentsDir, `${attachmentId}.png`);
      yield* Effect.promise(() => NodeFSP.writeFile(imagePath, PNG_1X1));
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-image-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter({ binaryPath: wrapperPath });
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(turnCompleted, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "describe this",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "pixel.png",
            mimeType: "image/png",
            sizeBytes: PNG_1X1.byteLength,
          },
        ],
      });
      yield* Deferred.await(turnCompleted);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompt = requests.find((entry) => entry.method === "session/prompt");
      const params = prompt?.params as
        | { prompt?: ReadonlyArray<{ type?: string; mimeType?: string; data?: string }> }
        | undefined;
      assert.isTrue(
        params?.prompt?.some(
          (part) =>
            part.type === "image" &&
            part.mimeType === "image/png" &&
            typeof part.data === "string" &&
            part.data.length > 0,
        ) === true,
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("responds to ACP approvals using provider-supplied option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-approval");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-registry-approval-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "agent-defined-approval-id",
        }),
      );
      const adapter = yield* makeTestAdapter({ binaryPath: wrapperPath });
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "agent-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores replayed session/load updates when resuming", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-load-replay");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({ T3_ACP_EMIT_LOAD_REPLAY: "1" }),
      );
      const adapter = yield* makeTestAdapter({ binaryPath: wrapperPath });
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "after resume",
        attachments: [],
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels an in-flight prompt and accepts a follow-up turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-registry-cancel");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAcpRegistryWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter({ binaryPath: wrapperPath });
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpRegistry"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({
        threadId,
        input: "hang forever",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");

      const followUpEventsBefore = runtimeEvents.length;
      yield* adapter.sendTurn({
        threadId,
        input: "continue after stop",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const followUpCompletedEvents = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(followUpCompletedEvents, 1);
      assert.equal(followUpCompletedEvents[0]?.payload.state, "completed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
