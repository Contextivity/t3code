import { type AcpRegistrySettings, ProviderDriverKind } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");

export type AcpRegistryMcpPolicy = Extract<AcpSessionRuntime.AcpMcpPolicy, "auto" | "never">;

interface AcpRegistryRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn" | "mcpPolicy"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly settings: AcpRegistrySettings;
  readonly environment?: NodeJS.ProcessEnv;
}

export function tokenizeAcpRegistryLaunchArgs(
  launchArgs: string | undefined,
): ReadonlyArray<string> {
  return tokenizeCliArgs(launchArgs);
}

export function buildAcpRegistrySpawnInput(
  settings: Pick<AcpRegistrySettings, "binaryPath" | "launchArgs">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const command = settings.binaryPath.trim();
  return {
    command,
    args: tokenizeAcpRegistryLaunchArgs(settings.launchArgs),
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export function resolveAcpRegistryMcpPolicy(
  settings: Pick<AcpRegistrySettings, "attachMcpWhenSupported">,
): AcpRegistryMcpPolicy {
  return settings.attachMcpWhenSupported ? "auto" : "never";
}

export const makeAcpRegistryRuntime = (
  input: AcpRegistryRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildAcpRegistrySpawnInput(input.settings, input.cwd, input.environment),
        authMethodId: input.settings.authMethodId,
        mcpPolicy: resolveAcpRegistryMcpPolicy(input.settings),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveAcpRegistryModelId(model: string | null | undefined): string | undefined {
  const normalized = normalizeModelSlug(model?.trim() || undefined, ACP_REGISTRY_DRIVER_KIND);
  return normalized ?? undefined;
}

export function currentAcpRegistryModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyAcpRegistryModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}

export function applyAcpRegistryConfigOptionSelections<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
  readonly selections:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  if (!input.selections || input.selections.length === 0) {
    return Effect.void;
  }
  return Effect.forEach(
    input.selections,
    (selection) =>
      input.runtime
        .setConfigOption(selection.id, selection.value)
        .pipe(Effect.mapError(input.mapError)),
    { discard: true },
  );
}
