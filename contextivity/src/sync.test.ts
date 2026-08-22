import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { failClosed, syncExactUpstreamTag, type GitRunner } from "./sync.ts";
import type { UpstreamNightly } from "./upstream.ts";
import { reportSyncFailureIssue, type IssueClient, type IssueSummary } from "./issues.ts";

const nightly: UpstreamNightly = {
  tag: "v0.0.34-nightly.20260822.2",
  version: "0.0.34-nightly.20260822.2",
  date: "20260822",
  runNumber: 2,
  commit: "c".repeat(40),
};

function gitStub(overrides: Partial<GitRunner> = {}): GitRunner {
  return {
    fetchExactTag: async () => undefined,
    revParse: async (rev) => (rev === "HEAD" ? "d".repeat(40) : nightly.commit),
    mergeCommit: async () => ({ ok: true }),
    abortMerge: async () => undefined,
    isAncestor: async () => false,
    readFileAt: async () => JSON.stringify({ version: nightly.version }),
    currentBranch: async () => "main",
    hasUncommittedChanges: async () => false,
    ...overrides,
  };
}

NodeTest.describe("exact-tag sync fail-closed", () => {
  NodeTest.it("merges the exact upstream tag when the worktree is clean", async () => {
    const result = await syncExactUpstreamTag({
      git: gitStub(),
      remote: "origin",
      nightly,
    });
    NodeAssert.equal(result.ok, true);
    if (result.ok) {
      NodeAssert.equal(result.tag, nightly.tag);
      NodeAssert.equal(result.alreadyContained, false);
    }
  });

  NodeTest.it("skips merge when the tag is already an ancestor", async () => {
    const result = await syncExactUpstreamTag({
      git: gitStub({ isAncestor: async () => true }),
      remote: "origin",
      nightly,
    });
    NodeAssert.equal(result.ok, true);
    if (result.ok) NodeAssert.equal(result.alreadyContained, true);
  });

  NodeTest.it("fails closed on merge conflicts and does not publish", async () => {
    let aborted = false;
    const result = await syncExactUpstreamTag({
      git: gitStub({
        mergeCommit: async () => ({ ok: false, conflicts: ["apps/server/src/server.ts"] }),
        abortMerge: async () => {
          aborted = true;
        },
      }),
      remote: "origin",
      nightly,
    });
    NodeAssert.equal(result.ok, false);
    NodeAssert.equal(aborted, true);
    if (!result.ok) {
      NodeAssert.equal(result.failClosed, true);
      NodeAssert.equal(result.publish, false);
      NodeAssert.equal(result.advanceFleet, false);
      NodeAssert.deepEqual(result.conflicts, ["apps/server/src/server.ts"]);
    }
  });

  NodeTest.it("fails closed on dirty worktree, version mismatch, and fetch errors", async () => {
    const dirty = await syncExactUpstreamTag({
      git: gitStub({ hasUncommittedChanges: async () => true }),
      remote: "origin",
      nightly,
    });
    NodeAssert.equal(dirty.ok, false);

    const mismatch = await syncExactUpstreamTag({
      git: gitStub({
        readFileAt: async () => JSON.stringify({ version: "0.0.1" }),
      }),
      remote: "origin",
      nightly,
    });
    NodeAssert.equal(mismatch.ok, false);

    const fetchFail = await syncExactUpstreamTag({
      git: gitStub({
        fetchExactTag: async () => {
          throw new Error("network");
        },
      }),
      remote: "origin",
      nightly,
    });
    NodeAssert.equal(fetchFail.ok, false);
  });

  NodeTest.it("deduplicates maintenance issues for the same failed tag", async () => {
    const existing: IssueSummary = {
      number: 9,
      title: "Contextivity T3 nightly sync failed: v0.0.34-nightly.20260822.2",
      state: "open",
      htmlUrl: "https://github.com/Contextivity/t3code/issues/9",
    };
    const created: IssueSummary[] = [];
    const client: IssueClient = {
      searchOpen: async () => [existing],
      create: async (input) => {
        const issue = {
          number: 10,
          title: input.title,
          state: "open" as const,
          htmlUrl: "https://example.test/10",
        };
        created.push(issue);
        return issue;
      },
    };
    const first = await reportSyncFailureIssue(
      client,
      failClosed(nightly.tag, "conflict", ["a.ts"]),
    );
    NodeAssert.equal(first.created, false);
    NodeAssert.equal(first.issue.number, 9);
    NodeAssert.equal(created.length, 0);

    const emptyClient: IssueClient = {
      searchOpen: async () => [],
      create: async (input) => ({
        number: 11,
        title: input.title,
        state: "open",
        htmlUrl: "https://example.test/11",
      }),
    };
    const second = await reportSyncFailureIssue(
      emptyClient,
      failClosed(nightly.tag, "conflict", ["a.ts"]),
    );
    NodeAssert.equal(second.created, true);
    NodeAssert.equal(second.issue.number, 11);
  });
});
