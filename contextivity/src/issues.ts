import { MAINTENANCE_ISSUE_LABEL } from "./config.ts";
import { syncFailureIssueBody, syncFailureIssueTitle, type SyncFailure } from "./sync.ts";

export interface IssueSummary {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly htmlUrl: string;
}

export interface IssueClient {
  readonly searchOpen: (title: string) => Promise<readonly IssueSummary[]>;
  readonly create: (input: {
    readonly title: string;
    readonly body: string;
    readonly labels: readonly string[];
  }) => Promise<IssueSummary>;
}

export interface DedupedIssueResult {
  readonly created: boolean;
  readonly issue: IssueSummary;
}

export async function reportSyncFailureIssue(
  client: IssueClient,
  failure: SyncFailure,
): Promise<DedupedIssueResult> {
  const title = syncFailureIssueTitle(failure.tag);
  const existing = (await client.searchOpen(title)).find((issue) => issue.title === title);
  if (existing) {
    return { created: false, issue: existing };
  }
  const issue = await client.create({
    title,
    body: syncFailureIssueBody(failure),
    labels: [MAINTENANCE_ISSUE_LABEL],
  });
  return { created: true, issue };
}
