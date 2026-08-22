export interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) break;
    if (token === "--") {
      positionals.push(...rest.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const name = token.slice(2);
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("-")) {
        flags[name] = true;
      } else {
        flags[name] = next;
        index += 1;
      }
      continue;
    }
    positionals.push(token);
  }
  return { command, positionals, flags };
}

export function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] === true || flags[name] === "true" || flags[name] === "1";
}

export function usage(): string {
  return `t3-ctx — Contextivity downstream T3 distribution

Usage:
  t3-ctx discover-upstream [--remote <url>]
  t3-ctx sync-tag --tag <vX.Y.Z-nightly.date.run> [--remote <url>]
  t3-ctx report-sync-failure --tag <tag> --reason <text>
  t3-ctx write-manifest --out <file> [identity and artifact flags]
  t3-ctx candidate-test-plan
  t3-ctx validate-workflows
  t3-ctx check-mac-client --mac-client-version <version> --upstream-version <version>
  t3-ctx promote --channel nightly|stable --manifest <file> --mac-client-version <version>
  t3-ctx updater status|check|update|stage|activate|rollback
  t3-ctx publish-candidate --dir <dir> --repo <owner/repo>
  t3-ctx fleet update --inventory <file> --manifest <file> --mac-client-version <version> [--stage-only]
`;
}
