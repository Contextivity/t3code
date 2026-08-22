import { normalizeVersion } from "./promote.ts";

export function parseMacPlistVersion(plistText: string): string | null {
  const short = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u.exec(
    plistText,
  );
  if (short?.[1]) return normalizeVersion(short[1]);
  const quoted = /CFBundleShortVersionString\s*=\s*"([^"]+)"/u.exec(plistText);
  if (quoted?.[1]) return normalizeVersion(quoted[1]);
  const defaults = plistText.trim();
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(defaults)) return defaults;
  return null;
}

export function resolveMacClientVersion(input: {
  readonly envVersion?: string;
  readonly plistText?: string;
  readonly commandOutput?: string;
}): string {
  const envVersion = input.envVersion?.trim() ?? "";
  if (envVersion.length > 0) return normalizeVersion(envVersion);
  if (input.commandOutput) {
    const parsed = parseMacPlistVersion(input.commandOutput);
    if (parsed) return parsed;
  }
  if (input.plistText) {
    const parsed = parseMacPlistVersion(input.plistText);
    if (parsed) return parsed;
  }
  throw new Error(
    "Could not determine the official Mac desktop version. Pass --mac-client-version or set CONTEXTIVITY_T3_MAC_CLIENT_VERSION. Promotion and fleet activation fail closed.",
  );
}

export const DEFAULT_MAC_READ_VERSION_COMMAND = [
  "defaults",
  "read",
  "/Applications/T3 Code.app/Contents/Info",
  "CFBundleShortVersionString",
] as const;
