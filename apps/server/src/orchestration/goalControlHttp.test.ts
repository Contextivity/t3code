import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { assert, describe, it } from "vite-plus/test";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentOrchestrationHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  ProviderGoalControlError,
  ProviderInstanceId,
  ThreadId,
  type AuthEnvironmentScope,
  type ProviderGoalControlInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { orchestrationHttpApiLayer } from "./http.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

const decodeGoalError = Schema.decodeUnknownSync(ProviderGoalControlError);
class TestApi extends HttpApi.make("environment").add(EnvironmentOrchestrationHttpApi) {}
const get: ProviderGoalControlInput = {
  action: "get",
  threadId: ThreadId.make("disposable-http"),
  expectedProviderInstanceId: ProviderInstanceId.make("codex-test"),
  expectedNativeThreadId: "native-http",
};
const resume: Extract<ProviderGoalControlInput, { action: "resume" | "pause" }> = {
  ...get,
  action: "resume",
  ownerId: "b220998f-3b30-4b02-a9c7-91696d58222f",
  attemptId: "e208fae3-8a65-4f79-9fb9-340a81f5d08f",
  expectedGoal: {
    threadId: "native-http",
    objective: "Fixture",
    status: "usageLimited",
    tokenBudget: null,
    tokensUsed: 321,
    timeUsedSeconds: 5,
    createdAt: 1,
    updatedAt: 2,
  },
};
function fixture(scopes: ReadonlyArray<AuthEnvironmentScope> | null, deny = false) {
  let calls = 0;
  const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
    scopes === null
      ? Effect.fail(
          new EnvironmentAuthInvalidError({
            code: "auth_invalid",
            reason: "missing_credential",
            traceId: "test",
          }),
        )
      : Effect.provideService(httpEffect, EnvironmentAuthenticatedPrincipal, {
          sessionId: AuthSessionId.make("test"),
          subject: "test-user",
          method: "bearer-access-token",
          scopes: new Set(scopes),
        }),
  );
  const service = Layer.succeed(ProviderService, {
    goalControl: (input: ProviderGoalControlInput) => {
      calls++;
      return deny
        ? Effect.fail(
            new ProviderGoalControlError({
              reason: "native_request_failed",
              message: "usage_limit_exceeded",
              nativeCode: 429,
            }),
          )
        : Effect.succeed({
            threadId: input.threadId,
            providerInstanceId: input.expectedProviderInstanceId,
            ownerId: resume.ownerId,
            goal:
              input.action === "get"
                ? resume.expectedGoal
                : { ...input.expectedGoal, status: "active" as const },
            turnDispatched: false as const,
            continuationObserved: false as const,
          });
    },
  } as unknown as ProviderService["Service"]);
  const routes = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(orchestrationHttpApiLayer),
    Layer.provide(auth),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, {} as ProjectionSnapshotQuery["Service"])),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {} as OrchestrationEngineService["Service"]),
    ),
    Layer.provideMerge(service),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeHttpPlatform.layer,
        Etag.layer,
        WorkspacePaths.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-goal-http-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
  const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
  return {
    ...web,
    calls: () => calls,
    request: (body: unknown) =>
      web.handler(
        new Request("http://localhost/api/orchestration/goal-control", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
  };
}
describe("goal-control HTTP contract", () => {
  it("requires authentication and operate scope for resume; read scope alone can inspect", async () => {
    for (const [scopes, body, status, calls] of [
      [null, get, 401, 0],
      [[AuthOrchestrationReadScope], get, 200, 1],
      [[AuthOrchestrationReadScope], resume, 403, 0],
      [[AuthOrchestrationOperateScope], resume, 200, 1],
    ] as const) {
      const f = fixture(scopes);
      try {
        assert.equal((await f.request(body)).status, status);
        assert.equal(f.calls(), calls);
      } finally {
        await f.dispose();
      }
    }
  });
  it("rejects missing resume ownership and preserves native quota diagnostics", async () => {
    const f = fixture([AuthOrchestrationOperateScope], true);
    try {
      assert.equal((await f.request({ ...get, action: "resume" })).status, 400);
      assert.equal(f.calls(), 0);
      const response = await f.request(resume);
      assert.equal(response.status, 409);
      const body = decodeGoalError(await response.json());
      assert.equal(body.reason, "native_request_failed");
      assert.equal(body.nativeCode, 429);
      assert.equal(body.message, "usage_limit_exceeded");
      assert.equal(f.calls(), 1);
    } finally {
      await f.dispose();
    }
  });
});
