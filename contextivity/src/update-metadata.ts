import { FORBIDDEN_UPSTREAM_PACKAGE_PATTERNS } from "./config.ts";

export function internalUpdateCommand(upstreamVersion: string): string {
  return `t3-ctx update --version ${upstreamVersion}`;
}

export function fleetUpdateCommand(channel: "nightly" | "stable"): string {
  return `t3-ctx fleet update --channel ${channel}`;
}

export function containsUpstreamPackageFallback(text: string): boolean {
  return FORBIDDEN_UPSTREAM_PACKAGE_PATTERNS.some((pattern) => pattern.test(text));
}

export function assertNoUpstreamPackageFallback(text: string, label: string): void {
  if (containsUpstreamPackageFallback(text)) {
    throw new Error(
      `${label} offers upstream package t3@<version>. Downstream updates must use t3-ctx / t3-ctx fleet.`,
    );
  }
}

export function replaceUpstreamUpdateCommand(command: string, upstreamVersion: string): string {
  if (!containsUpstreamPackageFallback(command)) {
    return command;
  }
  return internalUpdateCommand(upstreamVersion);
}

export function downstreamUpdateGuidance(serverLabel: string): string {
  return `This ${serverLabel} is a Contextivity distribution. Use \`t3-ctx update\` on the host, not \`npx t3@<version>\`.`;
}
