import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type ProviderNativeGoal,
  type ProviderSession,
  type ProviderGoalControlInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexClient from "effect-codex-app-server/client";
import { makeCodexGoalControl } from "./CodexGoalControl.ts";

const ownerId = "b220998f-3b30-4b02-a9c7-91696d58222f";
const attemptId = "e208fae3-8a65-4f79-9fb9-340a81f5d08f";
const instance = ProviderInstanceId.make("codex-fixture");
const t3 = ThreadId.make("t3-disposable");
const get: ProviderGoalControlInput = {
  action: "get",
  threadId: t3,
  expectedProviderInstanceId: instance,
  expectedNativeThreadId: "native-disposable",
};
const initial: ProviderNativeGoal = {
  threadId: "native-disposable",
  objective: "Keep the existing goal",
  status: "usageLimited",
  tokenBudget: 1000,
  tokensUsed: 321,
  timeUsedSeconds: 45,
  createdAt: 10,
  updatedAt: 20,
};
const setup = Effect.fn("goalFixture")(function* () {
  let goal: ProviderNativeGoal | null = { ...initial };
  let status = "idle";
  let session: ProviderSession = {
    threadId: t3,
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: instance,
    status: "ready",
    runtimeMode: "full-access",
    resumeCursor: { threadId: initial.threadId },
    createdAt: "2026-09-09T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
  };
  let error: CodexErrors.CodexAppServerRequestError | undefined;
  let corrupt = false;
  let hang = false;
  let denyStatus = false;
  const entered = yield* Deferred.make<void>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = (method: string, params: unknown) =>
    Effect.suspend((): Effect.Effect<unknown, CodexErrors.CodexAppServerRequestError> => {
      calls.push({ method, params });
      if (method === "thread/goal/get") return Effect.succeed({ goal });
      if (method === "thread/read")
        return Effect.succeed({ thread: { id: initial.threadId, status: { type: status } } });
      assert.equal(method, "thread/goal/set", "goal control must never wake or interrupt a turn");
      if (error) return Effect.fail(error);
      if (hang) return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const update = params as { status: ProviderNativeGoal["status"] };
      goal = {
        ...goal!,
        status: denyStatus ? "usageLimited" : update.status,
        updatedAt: 21,
        ...(corrupt ? { tokensUsed: 0 } : {}),
      };
      return Effect.succeed({ goal });
    });
  const mutex = yield* Semaphore.make(1);
  const control = makeCodexGoalControl({
    ownerId,
    session: Effect.sync(() => session),
    mutex,
    client: { request: request as CodexClient.CodexAppServerClient["Service"]["request"] },
  });
  const resume = (): Extract<ProviderGoalControlInput, { action: "resume" | "pause" }> => ({
    ...get,
    action: "resume",
    ownerId,
    attemptId,
    expectedGoal: { ...goal! },
  });
  return {
    control,
    calls,
    resume,
    mutex,
    goal: () => goal,
    setGoal: (value: ProviderNativeGoal | null) => {
      goal = value;
    },
    setStatus: (value: string) => {
      status = value;
    },
    setSession: (value: Partial<ProviderSession>) => {
      session = { ...session, ...value };
    },
    deny: () => {
      error = new CodexErrors.CodexAppServerRequestError({
        code: 429,
        errorMessage: "usage_limit_exceeded: try after reset",
      });
    },
    entered: Deferred.await(entered),
    hang: () => {
      hang = true;
    },
    denyStatus: () => {
      denyStatus = true;
    },
    corrupt: () => {
      corrupt = true;
    },
  };
});

describe("native goal control", () => {
  it.effect("bounds a lost native response and refuses to replay its mutation", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      f.hang();
      const input = f.resume();
      const pending = yield* f.control(input).pipe(Effect.flip, Effect.forkScoped);
      yield* f.entered;
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(pending);
      assert.equal(error.reason, "native_request_failed");
      assert.include(error.message, "timed out");
      assert.equal((yield* f.control(input).pipe(Effect.flip)).reason, "attempt_already_used");
      assert.equal(f.calls.filter((c) => c.method === "thread/goal/set").length, 1);
    }).pipe(Effect.scoped),
  );
  it.effect("returns a native usage-limited result without silently resetting it again", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      f.denyStatus();
      assert.equal((yield* f.control(f.resume())).goal?.status, "usageLimited");
      assert.equal(f.calls.filter((c) => c.method === "thread/goal/set").length, 1);
    }),
  );

  it.effect(
    "reads and resumes the exact native thread without replacing accounting or starting a turn",
    () =>
      Effect.gen(function* () {
        const f = yield* setup();
        assert.deepEqual((yield* f.control(get)).goal, initial);
        const result = yield* f.control(f.resume());
        assert.equal(result.goal?.status, "active");
        assert.equal(result.goal?.tokensUsed, 321);
        assert.equal(result.goal?.timeUsedSeconds, 45);
        assert.equal(result.goal?.tokenBudget, 1000);
        assert.equal(result.goal?.objective, initial.objective);
        assert.isFalse(result.turnDispatched);
        assert.deepEqual(
          f.calls.filter((c) => c.method === "thread/goal/set"),
          [{ method: "thread/goal/set", params: { threadId: initial.threadId, status: "active" } }],
        );
      }),
  );
  it.effect("allows explicit recovery from a previous failed turn without an active turn", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      f.setSession({ status: "error" });
      f.setStatus("systemError");
      assert.equal((yield* f.control(f.resume())).goal?.status, "active");
    }),
  );
  it.effect(
    "preserves an unbudgeted goal and supports pause through the same status-only API",
    () =>
      Effect.gen(function* () {
        const f = yield* setup();
        f.setGoal({ ...initial, tokenBudget: null });
        yield* f.control({ ...f.resume(), action: "pause" });
        assert.equal(f.goal()?.status, "paused");
        assert.isNull(f.goal()?.tokenBudget);
      }),
  );
  it.effect("rejects wrong or stale live owners before RPC", () =>
    Effect.gen(function* () {
      for (const patch of [
        { ownerId: attemptId },
        { expectedNativeThreadId: "other" },
        { expectedProviderInstanceId: ProviderInstanceId.make("other") },
        { threadId: ThreadId.make("other") },
      ]) {
        const f = yield* setup();
        assert.equal(
          (yield* f.control({ ...f.resume(), ...patch }).pipe(Effect.flip)).reason,
          "owner_mismatch",
        );
        assert.isEmpty(f.calls);
      }
    }),
  );
  it.effect("rejects a closed owner rather than recovering or starting another session", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      f.setSession({ status: "closed" });
      assert.equal((yield* f.control(get).pipe(Effect.flip)).reason, "owner_unavailable");
      assert.isEmpty(f.calls);
    }),
  );
  it.effect("does not change or interrupt active turns even when local session state lags", () =>
    Effect.gen(function* () {
      for (const local of [true, false]) {
        const f = yield* setup();
        if (local) f.setSession({ status: "running" });
        else f.setStatus("active");
        assert.equal((yield* f.control(f.resume()).pipe(Effect.flip)).reason, "active_turn");
        assert.isFalse(f.calls.some((c) => c.method === "thread/goal/set"));
      }
    }),
  );
  it.effect("rejects stale snapshots, completed goals and exhausted budgets", () =>
    Effect.gen(function* () {
      for (const [patch, reason] of [
        [{ status: "complete" }, "terminal_goal"],
        [{ tokenBudget: 321 }, "budget_exhausted"],
      ] as const) {
        const f = yield* setup();
        f.setGoal({ ...initial, ...patch });
        assert.equal((yield* f.control(f.resume()).pipe(Effect.flip)).reason, reason);
      }
      const f = yield* setup();
      const input = f.resume();
      f.setGoal({ ...initial, tokensUsed: 322 });
      assert.equal((yield* f.control(input).pipe(Effect.flip)).reason, "goal_changed");
      f.setGoal(null);
      assert.equal((yield* f.control(input).pipe(Effect.flip)).reason, "goal_missing");
    }),
  );
  it.effect("propagates native quota denial and never replays the same attempt", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      f.deny();
      const input = f.resume();
      const error = yield* f.control(input).pipe(Effect.flip);
      assert.equal(error.reason, "native_request_failed");
      assert.equal(error.nativeCode, 429);
      assert.include(error.message, "usage_limit_exceeded");
      assert.equal((yield* f.control(input).pipe(Effect.flip)).reason, "attempt_already_used");
      assert.equal(f.calls.filter((c) => c.method === "thread/goal/set").length, 1);
      assert.deepEqual(f.goal(), initial);
    }),
  );
  it.effect("serializes concurrent resumes and rejects duplicate mutation attempts", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      const input = f.resume();
      const outcomes = yield* Effect.all(
        [f.control(input).pipe(Effect.result), f.control(input).pipe(Effect.result)],
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes.filter((r) => r._tag === "Success").length, 1);
      assert.equal(f.calls.filter((c) => c.method === "thread/goal/set").length, 1);
    }),
  );
  it.effect("reports unexpected native accounting changes without a corrective reset", () =>
    Effect.gen(function* () {
      const f = yield* setup();
      f.corrupt();
      assert.equal((yield* f.control(f.resume()).pipe(Effect.flip)).reason, "native_state_changed");
      assert.equal(f.calls.filter((c) => c.method === "thread/goal/set").length, 1);
    }),
  );
});
