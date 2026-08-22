import {
  CONTEXTIVITY_GITHUB_API_ENV,
  CONTEXTIVITY_GITHUB_BASE_ENV,
  CONTEXTIVITY_GITHUB_TOKEN_ENV,
  CONTEXTIVITY_TRUST_MIRROR_ENV,
  DEFAULT_GITHUB_API,
  DEFAULT_GITHUB_BASE,
} from "./config.ts";

export interface GitHubAuth {
  readonly token: string | null;
  readonly source: "explicit-token" | "gh" | "none";
}

export interface GitHubEndpoints {
  readonly api: string;
  readonly base: string;
  readonly trustedMirror: boolean;
}

export function readExplicitToken(env: Record<string, string | undefined>): string | null {
  const token = env[CONTEXTIVITY_GITHUB_TOKEN_ENV]?.trim() || env.GH_TOKEN?.trim() || "";
  return token.length > 0 ? token : null;
}

export function resolveGitHubAuth(input: {
  readonly env: Record<string, string | undefined>;
  readonly ghToken?: string | null;
}): GitHubAuth {
  const explicit = readExplicitToken(input.env);
  if (explicit) {
    return { token: explicit, source: "explicit-token" };
  }
  const ghToken = input.ghToken?.trim() ?? "";
  if (ghToken.length > 0) {
    return { token: ghToken, source: "gh" };
  }
  return { token: null, source: "none" };
}

export function redactSecrets(
  text: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted;
}

export function resolveGitHubEndpoints(env: Record<string, string | undefined>): GitHubEndpoints {
  const apiOverride = env[CONTEXTIVITY_GITHUB_API_ENV]?.trim() ?? "";
  const baseOverride = env[CONTEXTIVITY_GITHUB_BASE_ENV]?.trim() ?? "";
  if (apiOverride === "" && baseOverride === "") {
    return {
      api: DEFAULT_GITHUB_API,
      base: DEFAULT_GITHUB_BASE,
      trustedMirror: false,
    };
  }
  if (env[CONTEXTIVITY_TRUST_MIRROR_ENV]?.trim() !== "1") {
    throw new Error(
      `A GitHub mirror/base URL is set (${CONTEXTIVITY_GITHUB_API_ENV} / ${CONTEXTIVITY_GITHUB_BASE_ENV}) but ${CONTEXTIVITY_TRUST_MIRROR_ENV}=1 is not. Mirrors are untrusted unless that explicit policy is set.`,
    );
  }
  return {
    api: stripTrailingSlash(apiOverride || DEFAULT_GITHUB_API),
    base: stripTrailingSlash(baseOverride || DEFAULT_GITHUB_BASE),
    trustedMirror: true,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function authorizationHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
