// Offline GitHub CLI for watch-run.test.mjs. Answers `gh api` REST calls from
// WATCH_RUN_SCENARIO JSON (`{ polls: [state, ...], fail? }`). Each call to the
// watched workflow run endpoint (without `/jobs`) advances the poll index.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
appendFileSync(process.env.WATCH_RUN_FIXTURE_LOG, `${JSON.stringify({
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
if (argv[0] !== "api") {
  throw new Error(`Unexpected fixture command: ${JSON.stringify(argv)}`);
}

const { polls = [], fail } = JSON.parse(readFileSync(process.env.WATCH_RUN_SCENARIO, "utf8"));

function printPage(value, status = 200, headers = {}) {
  if (argv.includes("--include")) {
    process.stdout.write(`HTTP/2.0 ${status} ${status === 200 ? "OK" : "Error"}\n`);
    for (const [name, headerValue] of Object.entries(headers)) {
      process.stdout.write(`${name}: ${headerValue}\r\n`);
    }
    process.stdout.write("\r\n");
  }
  if (value !== undefined) console.log(JSON.stringify(value));
}

function failWith({ stderr = "gh: HTTP error", body, status, headers, exitCode = 1 }) {
  if (status || body) printPage(body, status ?? 500, headers ?? {});
  console.error(stderr);
  process.exit(exitCode);
}

if (fail) failWith(fail);

const path = argv[1];
const endpoint = path.split("/actions/")[1];
const runPath = `runs/${process.env.WATCH_RUN_ID}`;
const isJobs = endpoint === `${runPath}/jobs?per_page=100`;
const isRun = endpoint === runPath;
if (argv.includes("--paginate") !== (isJobs || endpoint === `${runPath}/concurrency_groups?per_page=100`)) {
  throw new Error(`Unexpected pagination for ${path}`);
}

const counterFile = `${process.env.WATCH_RUN_SCENARIO}.poll`;
let poll = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : -1;
if (isRun) {
  poll += 1;
  writeFileSync(counterFile, String(poll));
}
const state = polls.length ? polls[Math.max(0, Math.min(poll, polls.length - 1))] : {};

if (state.fail && (!state.fail.endpoint || path.includes(state.fail.endpoint))) {
  failWith(state.fail);
}

if (isRun) {
  printPage(state.run);
} else if (isJobs) {
  const pages = state.jobPages ?? [{ total_count: (state.jobs ?? []).length, jobs: state.jobs ?? [] }];
  for (const page of pages) {
    printPage(page);
  }
} else if (endpoint in (state.diagnostics ?? {})) {
  printPage(state.diagnostics[endpoint]);
} else {
  throw new Error(`Unexpected REST path: ${path}`);
}
