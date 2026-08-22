/**
 * Fork-only Contextivity distribution detection. Official T3 clients ignore
 * unknown local metadata; protocol-visible serverVersion stays the upstream
 * nightly from package.json. This module must not rewrite that version.
 */
export const CONTEXTIVITY_DISTRIBUTION_ENV = "CONTEXTIVITY_T3_DISTRIBUTION";

export function isContextivityDistributionFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[CONTEXTIVITY_DISTRIBUTION_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export const UPSTREAM_NPM_UPDATE_REFUSAL =
  "This Contextivity T3 server does not install upstream package t3@<version>. Use t3-ctx update or t3-ctx fleet on the host instead.";
