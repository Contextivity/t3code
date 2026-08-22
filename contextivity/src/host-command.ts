export const RESTART_COMMAND_FLAG = "restart-command";
export const HEALTH_COMMAND_FLAG = "health-command";
export const RESTART_COMMAND_B64_FLAG = "restart-command-b64";
export const HEALTH_COMMAND_B64_FLAG = "health-command-b64";

const ENCODED_TOKEN = /^[A-Za-z0-9_-]+$/u;

export function encodeHostCommandArg(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("Host command is empty.");
  }
  return Buffer.from(trimmed, "utf8").toString("base64url");
}

export function decodeHostCommandArg(encoded: string): string {
  if (!ENCODED_TOKEN.test(encoded)) {
    throw new Error("Host command encoding is invalid.");
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (decoded.length === 0 || encodeHostCommandArg(decoded) !== encoded) {
    throw new Error("Host command encoding is invalid.");
  }
  return decoded;
}

export function hostCommandFromFlags(
  flags: Readonly<Record<string, string | boolean>>,
  kind: "restart" | "health",
): string | undefined {
  const encodedName = kind === "restart" ? RESTART_COMMAND_B64_FLAG : HEALTH_COMMAND_B64_FLAG;
  const plainName = kind === "restart" ? RESTART_COMMAND_FLAG : HEALTH_COMMAND_FLAG;
  const encoded = flags[encodedName];
  const plain = flags[plainName];
  if (typeof encoded === "string") {
    return decodeHostCommandArg(encoded);
  }
  return typeof plain === "string" ? plain : undefined;
}
