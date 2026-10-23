import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const argv = process.argv.slice(2);
const program = process.argv[1];
appendFileSync(process.env.WATCH_PR_FIXTURE_LOG, JSON.stringify({ program, argv }) + "\n");
if (basename(program) === "gh" && argv[0] === "api") {
  console.error("Offline account router: select an explicit wrapper for GraphQL");
  process.exit(2);
}
const json = (value) => console.log(JSON.stringify(value));
const connection = (nodes, cursor) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const pullRequest = (value) => json({ data: { repository: { pullRequest: value } } });
const after = argv.find((arg) => arg.startsWith("after="));
if (argv[0] === "pr" && argv[1] === "view") {
  if (argv.at(-1) === "number,url") json({ number: 42, url: "https://github.com/owner/repo/pull/42" });
  else json({
    mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "APPROVED",
    headRefOid: "head", headRefName: "feature", baseRefName: "main",
    state: "OPEN", mergedAt: null, isDraft: false,
  });
} else if (argv[0] === "pr" && argv[1] === "list") {
  json([{ number: 42, headRefName: "feature", baseRefName: "main" }]);
} else if (argv[0] === "pr" && argv[1] === "checks") {
  json([]); // Force the real GraphQL fallback, not just the fast path.
} else if (argv[0] === "api" && argv[1] === "graphql") {
  const query = argv.find((arg) => arg.startsWith("query="));
  if (query?.includes("query ReviewThreads(")) {
    pullRequest({ reviewThreads: connection([{
      id: after ? "unresolved-later-page" : "resolved-first-page",
      isResolved: !after,
      comments: { nodes: [{ body: "Please fix", createdAt: "2026-01-01T00:00:00Z", path: "a.ts", line: 1, author: { login: "reviewer" } }] },
    }], after ? null : "threads-next") });
  } else if (query?.includes("query PrCheckRollup(")) {
    pullRequest({ commits: { nodes: [{ commit: { statusCheckRollup: {
      contexts: connection([after
        ? { __typename: "StatusContext", context: "legacy-ci", state: "SUCCESS", targetUrl: "" }
        : { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "" },
      ], after ? null : "checks-next"),
    } } }] } });
  } else if (query?.includes("query PrCommitStatuses(")) {
    pullRequest({ commits: { nodes: [
      { commit: { oid: "previous", statusCheckRollup: { state: "SUCCESS" } } },
      { commit: { oid: "head", statusCheckRollup: { state: "FAILURE" } } },
    ] } });
  } else throw new Error("Unexpected GraphQL query");
} else throw new Error(`Unexpected fixture command: ${JSON.stringify(argv)}`);
