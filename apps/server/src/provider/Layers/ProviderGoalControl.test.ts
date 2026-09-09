import { it } from "@effect/vitest";
import { assert, describe } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type ProviderGoalControlInput,
  type ProviderGoalControlResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type {
  ProviderSessionDirectoryShape,
  ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { routeGoalControl } from "./ProviderGoalControl.ts";

const input: ProviderGoalControlInput = {
  action: "get",
  threadId: ThreadId.make("t3-thread"),
  expectedProviderInstanceId: ProviderInstanceId.make("codex-two"),
  expectedNativeThreadId: "native-thread",
};
const binding: ProviderRuntimeBinding = {
  threadId: input.threadId,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: input.expectedProviderInstanceId,
  resumeCursor: { threadId: input.expectedNativeThreadId },
};
function fixture(value: ProviderRuntimeBinding | null = binding, loaded = true, supported = true) {
  const routed: string[] = [];
  let controls = 0;
  const directory = {
    getBinding: () => Effect.succeed(Option.fromNullishOr(value)),
  } as unknown as ProviderSessionDirectoryShape;
  const registry = {
    getByInstance: (id: string) => {
      routed.push(id);
      return Effect.succeed({
        provider: ProviderDriverKind.make("codex"),
        hasSession: (threadId: string) => {
          assert.equal(threadId, input.threadId);
          return Effect.succeed(loaded);
        },
        ...(supported
          ? {
              goalControl: (request: ProviderGoalControlInput) => {
                controls++;
                assert.deepEqual(request, input);
                return Effect.succeed({
                  threadId: request.threadId,
                  providerInstanceId: request.expectedProviderInstanceId,
                  ownerId: "b220998f-3b30-4b02-a9c7-91696d58222f",
                  goal: null,
                  turnDispatched: false,
                  continuationObserved: false,
                } satisfies ProviderGoalControlResult);
              },
            }
          : {}),
      });
    },
  } as unknown as ProviderAdapterRegistryShape;
  return { control: routeGoalControl(directory, registry), routed, controls: () => controls };
}
describe("T3 goal routing", () => {
  it.effect("rejects a missing owner before adapter lookup", () =>
    Effect.gen(function* () {
      const f = fixture(null);
      assert.equal((yield* f.control(input).pipe(Effect.flip)).reason, "owner_unavailable");
      assert.isEmpty(f.routed);
    }),
  );
  it.effect(
    "routes through the persisted instance rather than a default account or native ID as T3 ID",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.control(input);
        assert.deepEqual(f.routed, ["codex-two"]);
        assert.equal(f.controls(), 1);
      }),
  );
  it.effect("rejects conflicting persisted ownership before selecting an adapter", () =>
    Effect.gen(function* () {
      for (const patch of [
        { providerInstanceId: ProviderInstanceId.make("codex-one") },
        { resumeCursor: { threadId: "wrong" } },
        { resumeCursor: null },
      ]) {
        const f = fixture({ ...binding, ...patch });
        assert.equal((yield* f.control(input).pipe(Effect.flip)).reason, "owner_mismatch");
        assert.isEmpty(f.routed);
      }
    }),
  );
  it.effect(
    "rejects unloaded owners without session recovery and diagnoses unsupported adapters",
    () =>
      Effect.gen(function* () {
        assert.equal(
          (yield* fixture(binding, false).control(input).pipe(Effect.flip)).reason,
          "owner_unavailable",
        );
        assert.equal(
          (yield* fixture(binding, true, false).control(input).pipe(Effect.flip)).reason,
          "unsupported",
        );
      }),
  );
  it.effect("rejects missing resume intent and owner fields", () =>
    Effect.gen(function* () {
      const f = fixture();
      assert.equal(
        (yield* f
          .control({ ...input, action: "resume" } as ProviderGoalControlInput)
          .pipe(Effect.flip)).reason,
        "invalid_input",
      );
      assert.isEmpty(f.routed);
    }),
  );
});
