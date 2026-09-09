import { ProviderGoalControlError, ProviderGoalControlInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";

const decodeCursor = Schema.decodeUnknownOption(Schema.Struct({ threadId: Schema.String }));
const decodeInput = Schema.decodeUnknownEffect(ProviderGoalControlInput);

export const routeGoalControl = (
  directory: ProviderSessionDirectoryShape,
  registry: ProviderAdapterRegistryShape,
) =>
  Effect.fn("ProviderGoalControl.route")(function* (raw: ProviderGoalControlInput) {
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError(
        () =>
          new ProviderGoalControlError({
            reason: "invalid_input",
            message: "Goal control requires an exact thread binding and explicit action.",
          }),
      ),
    );
    const binding = yield* directory.getBinding(input.threadId).pipe(
      Effect.mapError(
        () =>
          new ProviderGoalControlError({
            reason: "owner_unavailable",
            message: "Cannot read the provider owner for this T3 thread.",
          }),
      ),
    );
    if (Option.isNone(binding)) {
      return yield* new ProviderGoalControlError({
        reason: "owner_unavailable",
        message: "This T3 thread has no provider session binding.",
      });
    }
    const cursor = decodeCursor(binding.value.resumeCursor);
    if (
      binding.value.providerInstanceId !== input.expectedProviderInstanceId ||
      Option.isNone(cursor) ||
      cursor.value.threadId !== input.expectedNativeThreadId
    ) {
      return yield* new ProviderGoalControlError({
        reason: "owner_mismatch",
        message:
          "The T3 thread's provider instance or native thread has changed. Read its current binding before retrying.",
      });
    }
    const adapter = yield* registry.getByInstance(input.expectedProviderInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderGoalControlError({
            reason: "owner_unavailable",
            message: "The bound provider instance is not available.",
          }),
      ),
    );
    if (binding.value.provider !== adapter.provider) {
      return yield* new ProviderGoalControlError({
        reason: "owner_mismatch",
        message: "The provider binding and live adapter disagree.",
      });
    }
    if (!adapter.goalControl) {
      return yield* new ProviderGoalControlError({
        reason: "unsupported",
        message:
          "This provider adapter does not expose native goal control. A turn notification does not resume a limited goal.",
      });
    }
    // Never recover/start a session here: recovery can replace a missing native thread.
    if (!(yield* adapter.hasSession(input.threadId))) {
      return yield* new ProviderGoalControlError({
        reason: "owner_unavailable",
        message:
          "The owning provider session is not loaded. Resume it through T3 before reading a fresh goal-control owner.",
      });
    }
    return yield* adapter.goalControl(input);
  });
