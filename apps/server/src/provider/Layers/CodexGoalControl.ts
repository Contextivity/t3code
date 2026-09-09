import {
  ProviderGoalControlError,
  type ProviderGoalControlInput,
  type ProviderGoalControlResult,
  ProviderNativeGoal,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Semaphore from "effect/Semaphore";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexClient from "effect-codex-app-server/client";

const goalEquivalence = Schema.toEquivalence(ProviderNativeGoal);
const decodeCursor = Schema.decodeUnknownOption(Schema.Struct({ threadId: Schema.String }));
const isGoalControlError = Schema.is(ProviderGoalControlError);
const isNativeRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const sameGoal = (a: ProviderNativeGoal, b: ProviderNativeGoal) =>
  goalEquivalence(
    { ...a, tokenBudget: a.tokenBudget ?? null },
    { ...b, tokenBudget: b.tokenBudget ?? null },
  );

export const makeCodexGoalControl = (options: {
  readonly ownerId: string;
  readonly session: Effect.Effect<ProviderSession>;
  readonly client: Pick<CodexClient.CodexAppServerClient["Service"], "request">;
  readonly mutex: Semaphore.Semaphore;
}) => {
  const attempts = new Set<string>();
  return Effect.fn("CodexGoalControl.control")(function* (
    input: ProviderGoalControlInput,
  ): Effect.fn.Return<ProviderGoalControlResult, ProviderGoalControlError> {
    return yield* Effect.gen(function* () {
      const session = yield* options.session;
      const cursor = decodeCursor(session.resumeCursor);
      if (session.status === "closed" || session.status === "connecting") {
        return yield* new ProviderGoalControlError({
          reason: "owner_unavailable",
          message: "The owning Codex session is not ready.",
        });
      }
      if (
        session.threadId !== input.threadId ||
        cursor._tag === "None" ||
        cursor.value.threadId !== input.expectedNativeThreadId ||
        session.providerInstanceId !== input.expectedProviderInstanceId ||
        (input.action !== "get" && input.ownerId !== options.ownerId)
      ) {
        return yield* new ProviderGoalControlError({
          reason: "owner_mismatch",
          message:
            "Goal control owner does not match the live Codex session. Read a fresh owner before retrying.",
        });
      }
      const threadId = cursor.value.threadId;
      const response = yield* options.client.request("thread/goal/get", { threadId });
      let goal = response.goal ?? null;
      if (goal && goal.threadId !== threadId) {
        return yield* new ProviderGoalControlError({
          reason: "owner_mismatch",
          message: "Codex returned a goal for another native thread.",
        });
      }
      if (input.action !== "get") {
        if (attempts.has(input.attemptId)) {
          return yield* new ProviderGoalControlError({
            reason: "attempt_already_used",
            message:
              "This goal-control attempt was already sent; read the goal to reconcile its outcome. It will not be replayed.",
          });
        }
        if (!goal)
          return yield* new ProviderGoalControlError({
            reason: "goal_missing",
            message: "No existing native goal to update.",
          });
        if (!sameGoal(goal, input.expectedGoal))
          return yield* new ProviderGoalControlError({
            reason: "goal_changed",
            message: "The native goal changed since it was read. No update was sent.",
          });
        if (goal.status === "complete")
          return yield* new ProviderGoalControlError({
            reason: "terminal_goal",
            message: "A completed goal cannot be resumed or replaced by this operation.",
          });
        if (
          input.action === "resume" &&
          goal.tokenBudget != null &&
          goal.tokensUsed >= goal.tokenBudget
        ) {
          return yield* new ProviderGoalControlError({
            reason: "budget_exhausted",
            message:
              "The existing goal token budget is exhausted. Goal control does not increase it.",
          });
        }
        const thread = yield* options.client.request("thread/read", {
          threadId,
          includeTurns: false,
        });
        if (thread.thread.id !== threadId)
          return yield* new ProviderGoalControlError({
            reason: "owner_mismatch",
            message: "Codex returned another native thread.",
          });
        if (
          session.activeTurnId ||
          session.status === "running" ||
          thread.thread.status.type === "active" ||
          thread.thread.status.type === "notLoaded"
        ) {
          return yield* new ProviderGoalControlError({
            reason: "active_turn",
            message:
              "The owning Codex thread is active or unavailable. Let its active turn finish; goal control never interrupts it.",
          });
        }
        if (attempts.size >= 128)
          return yield* new ProviderGoalControlError({
            reason: "attempt_capacity",
            message:
              "This owner has exhausted its goal-control attempt capacity. No update was sent.",
          });
        // Record before crossing the RPC boundary, including failures and lost responses.
        attempts.add(input.attemptId);
        const status = input.action === "resume" ? "active" : "paused";
        if (goal.status !== status) {
          const before = goal;
          goal = (yield* options.client.request("thread/goal/set", { threadId, status })).goal;
          if (!sameGoal({ ...goal, status: before.status, updatedAt: before.updatedAt }, before)) {
            return yield* new ProviderGoalControlError({
              reason: "native_state_changed",
              message:
                "Codex changed goal identity, budget, or accounting during a status-only update. Read the native state; no corrective write or retry was sent.",
            });
          }
        }
      }
      return {
        threadId: input.threadId,
        providerInstanceId: input.expectedProviderInstanceId,
        ownerId: options.ownerId,
        goal,
        turnDispatched: false,
        continuationObserved: false,
      } satisfies ProviderGoalControlResult;
    }).pipe(
      options.mutex.withPermit,
      Effect.timeout("10 seconds"),
      Effect.mapError((error) => {
        if (isGoalControlError(error)) return error;
        if (isNativeRequestError(error)) {
          return new ProviderGoalControlError({
            reason: error.code === -32601 ? "unsupported" : "native_request_failed",
            message: error.errorMessage,
            nativeCode: error.code,
          });
        }
        return new ProviderGoalControlError({
          reason: "native_request_failed",
          message:
            error._tag === "TimeoutError"
              ? "Goal control timed out. An update may have been accepted; read native state before any new intent. The attempt will not be replayed."
              : error.message,
        });
      }),
    );
  });
};
