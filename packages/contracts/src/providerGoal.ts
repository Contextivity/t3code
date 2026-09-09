import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderNativeGoal = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  objective: Schema.String,
  status: Schema.Literals([
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ]),
  tokenBudget: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  tokensUsed: Schema.Int,
  timeUsedSeconds: Schema.Int,
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
});
export type ProviderNativeGoal = typeof ProviderNativeGoal.Type;

const binding = {
  threadId: ThreadId,
  expectedProviderInstanceId: ProviderInstanceId,
  expectedNativeThreadId: TrimmedNonEmptyString,
};
export const ProviderGoalControlInput = Schema.Union([
  Schema.Struct({ ...binding, action: Schema.Literal("get") }),
  Schema.Struct({
    ...binding,
    action: Schema.Literals(["resume", "pause"]),
    ownerId: Schema.String.check(Schema.isUUID()),
    attemptId: Schema.String.check(Schema.isUUID()),
    expectedGoal: ProviderNativeGoal,
  }),
]);
export type ProviderGoalControlInput = typeof ProviderGoalControlInput.Type;

export const ProviderGoalControlResult = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  ownerId: Schema.String.check(Schema.isUUID()),
  goal: Schema.NullOr(ProviderNativeGoal),
  // T3 sends no turn/start. Codex owns any asynchronous goal continuation.
  turnDispatched: Schema.Literal(false),
  // Acceptance is distinct from continuation; observe the existing native turn events.
  continuationObserved: Schema.Literal(false),
});
export type ProviderGoalControlResult = typeof ProviderGoalControlResult.Type;

export class ProviderGoalControlError extends Schema.TaggedError<ProviderGoalControlError>()(
  "ProviderGoalControlError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "owner_unavailable",
      "owner_mismatch",
      "unsupported",
      "active_turn",
      "goal_missing",
      "goal_changed",
      "terminal_goal",
      "budget_exhausted",
      "attempt_already_used",
      "attempt_capacity",
      "native_request_failed",
      "native_state_changed",
    ]),
    message: Schema.String,
    nativeCode: Schema.optionalKey(Schema.Number),
  },
  { httpApiStatus: 409 },
) {}
