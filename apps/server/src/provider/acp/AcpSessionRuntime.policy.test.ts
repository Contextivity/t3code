import { describe, expect, it } from "@effect/vitest";

import { resolveAcpAuthMethodId, resolveAcpSessionMcpServers } from "./AcpSessionRuntime.ts";

describe("resolveAcpAuthMethodId", () => {
  it("uses the configured method when set", () => {
    expect(
      resolveAcpAuthMethodId({
        configuredAuthMethodId: " api_key ",
        advertisedAuthMethods: [{ id: "token" }, { id: "api_key" }],
      }),
    ).toBe("api_key");
  });

  it("falls back to the first advertised method", () => {
    expect(
      resolveAcpAuthMethodId({
        advertisedAuthMethods: [{ id: "token" }, { id: "api_key" }],
      }),
    ).toBe("token");
  });

  it("skips authentication when nothing is advertised or configured", () => {
    expect(resolveAcpAuthMethodId({ advertisedAuthMethods: [] })).toBeUndefined();
    expect(resolveAcpAuthMethodId({})).toBeUndefined();
  });
});

describe("resolveAcpSessionMcpServers", () => {
  const requested = [
    {
      type: "http" as const,
      name: "t3-code",
      url: "http://127.0.0.1:9/mcp",
      headers: [{ name: "Authorization", value: "Bearer test" }],
    },
  ];

  it("always passes requested servers when policy is always", () => {
    expect(
      resolveAcpSessionMcpServers({
        requested,
        policy: "always",
        initializeResult: { protocolVersion: 1 },
      }),
    ).toEqual(requested);
  });

  it("omits servers when the agent does not advertise HTTP MCP under auto", () => {
    expect(
      resolveAcpSessionMcpServers({
        requested,
        policy: "auto",
        initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      }),
    ).toEqual([]);
  });

  it("passes servers when auto policy sees HTTP MCP", () => {
    expect(
      resolveAcpSessionMcpServers({
        requested,
        policy: "auto",
        initializeResult: {
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: { http: true } },
        },
      }),
    ).toEqual(requested);
  });

  it("never passes servers under never policy", () => {
    expect(
      resolveAcpSessionMcpServers({
        requested,
        policy: "never",
        initializeResult: {
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: { http: true } },
        },
      }),
    ).toEqual([]);
  });
});
