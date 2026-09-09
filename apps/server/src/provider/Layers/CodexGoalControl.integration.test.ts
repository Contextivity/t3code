// @effect-diagnostics nodeBuiltinImport:off - disposable loopback quota fixture.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexClient from "effect-codex-app-server/client";
import { assert, describe } from "vite-plus/test";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";

// Opt in with a native binary. The disposable provider points only to an offline loopback endpoint.
const binary = process.env.T3_CODEX_GOAL_TEST_BINARY;
const decodeCompleted = Schema.decodeUnknownEffect(CodexSchema.V2TurnCompletedNotification);
const decodeCursor = Schema.decodeUnknownEffect(Schema.Struct({ threadId: Schema.String }));
describe.runIf(binary)("native Codex goal-control round trip", () => {
  it.effect(
    "resumes a disposable goal through its owning runtime with one native continuation and no accounting reset",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-goal-roundtrip-" });
        const denialServer = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const server = NodeHttp.createServer((request, response) => {
              request.resume();
              response.writeHead(429, { "content-type": "application/json" });
              response.end(
                '{"error":{"type":"usage_limit_reached","message":"Disposable quota denial","plan_type":"plus","resets_at":4102444800}}',
              );
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            return server;
          }),
          (server) =>
            Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        const address = denialServer.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die("Missing quota fixture port");
        yield* fs.writeFileString(
          `${home}/config.toml`,
          `model_provider = "offline"
[model_providers.offline]
name = "offline"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`,
        );
        const env = { HOME: home, CODEX_HOME: home, PATH: process.env.PATH ?? "" };
        const seeded = yield* Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(binary!, ["app-server"], {
              cwd: home,
              env,
              extendEnv: false,
              forceKillAfter: "2 seconds",
            }),
          );
          return yield* Effect.gen(function* () {
            const client = yield* CodexClient.CodexAppServerClient;
            yield* client.request("initialize", buildCodexInitializeParams());
            yield* client.notify("initialized", undefined);
            const thread = yield* client.request("thread/start", { cwd: home });
            return (yield* client.request("thread/goal/set", {
              threadId: thread.thread.id,
              objective: "Disposable goal-control fixture",
              status: "paused",
              tokenBudget: 1024,
            })).goal;
          }).pipe(Effect.provide(CodexClient.layerChildProcess(child)));
        }).pipe(Effect.scoped);
        const threadId = ThreadId.make("disposable-t3-goal-thread");
        const providerInstanceId = ProviderInstanceId.make("offline-fixture");
        const runtime = yield* makeCodexSessionRuntime({
          threadId,
          providerInstanceId,
          binaryPath: binary!,
          homePath: home,
          environment: env,
          cwd: home,
          runtimeMode: "full-access",
          resumeCursor: { threadId: seeded.threadId },
        });
        const session = yield* runtime.start();
        const cursor = yield* decodeCursor(session.resumeCursor);
        assert.equal(cursor.threadId, seeded.threadId);
        const binding = {
          threadId,
          expectedProviderInstanceId: providerInstanceId,
          expectedNativeThreadId: seeded.threadId,
        };
        const snapshot = yield* runtime.goalControl({ ...binding, action: "get" });
        assert.deepEqual(snapshot.goal, seeded);
        const before = yield* runtime.readThread;
        const continuation = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.method === "turn/completed"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const input = {
          ...binding,
          action: "resume" as const,
          ownerId: snapshot.ownerId,
          attemptId: "43d82415-87de-441e-8110-72223d33c8f5",
          expectedGoal: seeded,
        };
        const resumed = yield* runtime.goalControl(input);
        assert.equal(resumed.goal?.status, "active");
        assert.equal(resumed.goal?.objective, seeded.objective);
        assert.equal(resumed.goal?.tokenBudget, seeded.tokenBudget);
        assert.equal(resumed.goal?.tokensUsed, seeded.tokensUsed);
        assert.equal(resumed.goal?.timeUsedSeconds, seeded.timeUsedSeconds);
        assert.equal(resumed.goal?.createdAt, seeded.createdAt);
        assert.isFalse(resumed.turnDispatched);
        assert.equal(
          (yield* runtime.goalControl(input).pipe(Effect.flip)).reason,
          "attempt_already_used",
        );
        const observed = yield* Fiber.join(continuation);
        const after = yield* runtime.readThread;
        assert.equal(observed.filter((event) => event.method === "turn/started").length, 1);
        assert.equal(after.turns.length, before.turns.length + 1);
        const terminal = observed.find((event) => event.method === "turn/completed");
        assert.isDefined(terminal);
        const completed = yield* decodeCompleted(terminal!.payload);
        assert.equal(completed.turn.status, "failed");
        assert.equal(completed.turn.error?.codexErrorInfo, "usageLimitExceeded");
        const limited = yield* runtime.goalControl({ ...binding, action: "get" });
        assert.equal(limited.goal?.status, "usageLimited");
        assert.equal(limited.goal?.objective, seeded.objective);
        assert.equal(limited.goal?.tokenBudget, seeded.tokenBudget);
        assert.equal(
          (yield* runtime.goalControl(input).pipe(Effect.flip)).reason,
          "attempt_already_used",
        );
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
