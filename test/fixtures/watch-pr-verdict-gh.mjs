// Offline GitHub CLI for watch-pr-verdict.test.mjs. It answers the watcher's
// `gh api` reads from WATCH_PR_SCENARIO, a JSON file `{ polls: [state, ...] }`.
// Each pull request query starts the next poll; the last state repeats.
// `{ fail: { stderr, body? } }` makes every call exit 1 as `gh api` does.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
appendFileSync(process.env.WATCH_PR_FIXTURE_LOG, `${JSON.stringify({ program: process.argv[1], argv })}\n`);
const { polls, fail } = JSON.parse(readFileSync(process.env.WATCH_PR_SCENARIO, "utf8"));
if (fail) {
  if (fail.body) console.log(JSON.stringify(argv.includes("--slurp") ? [fail.body] : fail.body));
  console.error(fail.stderr);
  process.exit(1);
}
const counter = `${process.env.WATCH_PR_SCENARIO}.poll`;
let poll = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : -1;
const query = argv.find((arg) => arg.startsWith("query=")) ?? "";
if (query.includes("reviewThreads")) writeFileSync(counter, String(++poll));
const state = polls[Math.min(poll, polls.length - 1)];
const print = (value) => console.log(JSON.stringify(value));
const pullRequest = (node) => ({ data: { repository: { pullRequest: node } } });

if (argv[0] !== "api") throw new Error(`Unexpected fixture command: ${JSON.stringify(argv)}`);
if (argv[1] === "graphql") {
  if (query.includes("reviewThreads")) {
    print([pullRequest({
      ...state.pullRequest,
      reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.threads ?? [] },
    })]);
  } else if (query.includes("object(expression")) {
    // GitHub lists tree entries in name order.
    print({ data: { repository: { object: { entries: Object.entries(state.workflows ?? {}).sort().map(([name, text]) => (
      { name, type: "blob", object: { text } })) } } } });
  } else if (query.includes("headRefOid")) {
    print(pullRequest({ headRefOid: state.confirmHead ?? state.pullRequest.headRefOid }));
  } else throw new Error("Unexpected GraphQL query");
} else {
  const path = argv[1];
  if (!argv.includes("--paginate") || !argv.includes("--slurp")) throw new Error(`REST read without --paginate --slurp: ${path}`);
  const sha = state.pullRequest.headRefOid;
  if (path.includes(`/commits/${sha}/check-runs`)) print([{ check_runs: state.checkRuns ?? [] }]);
  else if (path.includes(`/commits/${sha}/status`)) print([{ statuses: state.statuses ?? [] }]);
  else if (path.includes(`/actions/runs?head_sha=${sha}`)) print([{ workflow_runs: state.runs ?? [] }]);
  else if (path.includes("/rules/branches/")) print([state.rules ?? []]);
  else if (path.includes("/branches/")) print([state.branch ?? { protection: { enabled: false } }]);
  else if (/\/issues\/\d+\/comments/.test(path)) print([state.comments ?? []]);
  else if (/\/pulls\/\d+\/reviews/.test(path)) print([state.reviews ?? []]);
  else throw new Error(`Unexpected REST path: ${path}`);
}
