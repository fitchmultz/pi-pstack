// Offline GitHub CLI for watch-pr-verdict.test.mjs. It answers the watcher's
// `gh api` reads from WATCH_PR_SCENARIO, a JSON file `{ polls: [state, ...] }`.
// Each pull request query starts the next poll; the last state repeats.
// `{ fail: { stderr, body?, status?, headers? } }` makes calls exit 1 as `gh api` does.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
appendFileSync(process.env.WATCH_PR_FIXTURE_LOG, `${JSON.stringify({
  program: process.argv[1],
  argv,
  at: Date.now(),
  env: {
    hasGhToken: "GH_TOKEN" in process.env,
    hasGithubToken: "GITHUB_TOKEN" in process.env,
  },
})}\n`);
if (!argv.some((arg, index) => arg === "--jq" && argv[index + 1] === ".")) {
  throw new Error("The fixture only supports gh api --jq . output.");
}
const { polls, fail } = JSON.parse(readFileSync(process.env.WATCH_PR_SCENARIO, "utf8"));
function print(value, status = 200, headers = {}) {
  if (argv.includes("--include")) {
    process.stdout.write(`HTTP/2.0 ${status} ${status === 200 ? "OK" : "Error"}\n`);
    for (const [name, value] of Object.entries(headers)) process.stdout.write(`${name}: ${value}\r\n`);
    process.stdout.write("\r\n");
  }
  if (value !== undefined) console.log(JSON.stringify(value));
}
function failure({ stderr, body, status, headers }) {
  if (status || body) print(body, status, headers);
  console.error(stderr);
  process.exit(1);
}
if (fail) failure(fail);
const counter = `${process.env.WATCH_PR_SCENARIO}.poll`;
let poll = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : -1;
const query = argv.find((arg) => arg.startsWith("query=")) ?? "";
if (query.includes("reviewThreads")) writeFileSync(counter, String(++poll));
const state = polls.length ? polls[Math.max(0, Math.min(poll, polls.length - 1))] : {};
if (state.fail && (!state.fail.endpoint || argv[1].includes(state.fail.endpoint))) {
  if (state.fail.firstPage) print(state.fail.firstPage, 200, state.fail.firstHeaders);
  failure(state.fail);
}
const pullRequest = (node) => ({ data: { repository: { pullRequest: node } } });

if (argv[0] !== "api") throw new Error(`Unexpected fixture command: ${JSON.stringify(argv)}`);
if (argv[1] === "graphql") {
  if (query.includes("reviewThreads")) {
    print(pullRequest({
      ...state.pullRequest,
      reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.threads ?? [] },
    }));
  } else if (query.includes("object(expression")) {
    // GitHub lists tree entries in name order.
    print({ data: { repository: { object: { entries: Object.entries(state.workflows ?? {}).sort().map(([name, text]) => (
      { name, type: "blob", object: { text } })) } } } });
  } else if (query.includes("headRefOid")) {
    print(pullRequest({ headRefOid: state.confirmHead ?? state.pullRequest.headRefOid }));
  } else if (query.includes("addPullRequestReviewThreadReply")) {
    const threadId = argv.find((arg) => arg.startsWith("threadId="))?.slice("threadId=".length) ?? "";
    const body = argv.find((arg) => arg.startsWith("body="))?.slice("body=".length) ?? "";
    print({
      data: {
        addPullRequestReviewThreadReply: {
          comment: state.replyComment ?? {
            id: "PRRC_reply_1",
            fullDatabaseId: "999001",
            url: `https://github.com/example/repo/pull/418#discussion_r999001`,
            createdAt: "2026-11-20T00:00:00Z",
            author: { login: "author" },
            threadId,
            body,
          },
        },
      },
    });
  } else if (query.includes("resolveReviewThread")) {
    const threadId = argv.find((arg) => arg.startsWith("threadId="))?.slice("threadId=".length) ?? "";
    print({
      data: {
        resolveReviewThread: {
          thread: { id: threadId, isResolved: state.resolveConfirmed ?? true },
        },
      },
    });
  } else throw new Error("Unexpected GraphQL query");
} else {
  const path = argv[1];
  if (!argv.includes("--paginate")) throw new Error(`REST read without --paginate: ${path}`);
  const sha = state.pullRequest.headRefOid;
  if (path.includes(`/commits/${sha}/check-runs`)) print({ check_runs: state.checkRuns ?? [] });
  else if (path.includes(`/commits/${sha}/status`)) print({ statuses: state.statuses ?? [] });
  else if (path.includes(`/actions/runs?head_sha=${sha}`)) print({ workflow_runs: state.runs ?? [] });
  else if (path.includes("/rules/branches/")) print(state.rules ?? []);
  else if (path.includes("/branches/")) print(state.branch ?? { protection: { enabled: false } });
  else if (/\/issues\/\d+\/comments/.test(path)) print(state.comments ?? []);
  else if (/\/pulls\/\d+\/reviews/.test(path)) print(state.reviews ?? []);
  else throw new Error(`Unexpected REST path: ${path}`);
}
