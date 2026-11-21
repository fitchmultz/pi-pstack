// The watch-pr skill's watcher, run as agents run it: the real script, a
// configuration file, and a GitHub CLI executable on PATH. The CLI is the
// offline fixture; every scenario below replays GitHub API bodies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyWorkflow } from "../skills/watch-pr/scripts/triggers.mjs";

const script = fileURLToPath(new URL("../skills/watch-pr/scripts/watch-pr.mjs", import.meta.url));
const threadsScript = fileURLToPath(new URL("../skills/watch-pr/scripts/pr-threads.mjs", import.meta.url));
const fixture = readFileSync(new URL("./fixtures/watch-pr-verdict-gh.mjs", import.meta.url), "utf8");

const HEAD = "abe04d463cbda8f7f34b2237de00fcea57cb4c45";
const OLD = "11a9aa048330dd5d4ea528e1884db45fcc7054b1";
const DURABLE = "Pi Durable Review";
const CURSOR = "Cursor Automation: PR Bug Review - Maintained Repos";
const CONFIG = {
  "*": { gh: "gh-personal" },
  fitchmultz: { reviewers: [{ name: DURABLE, check: DURABLE }, { name: "Cursor automation", check: CURSOR }] },
  acme: {
    gh: "gh-work",
    reviewers: [{
      name: "Greptile", author: "greptile-apps[bot]", verdict: "Confidence Score: (\\d+/\\d+)",
      pass: "5/5", commit: "/commit/([0-9a-f]{40})",
    }],
  },
  "acme/app": { mergeWithoutApproval: true, reviewers: [{ name: "Review bot", check: "Review bot" }] },
};

// The `on:` sections of fitchmultz/pi's workflows on 2026-11-10 (paths shortened).
const PI_WORKFLOWS = {
  "ci.yml": "name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\n\njobs: {}\n",
  "nix.yml": "name: Nix\n\n# Release tags are built exactly as tagged.\non:\n  push:\n    tags:\n      - 'v*.*.*'\n  pull_request:\n    branches: [main]\n    paths:\n      - 'flake.nix'\n      - 'nix/**'\n  workflow_run:\n    workflows: [CI]\n\njobs: {}\n",
  "env.yml": "name: Environments\non:\n  push:\n    branches: [main, \"durable-env-*\"]\n    paths: [\"packages/env/**\"]\n  pull_request:\n    branches: [main]\n    paths: [\"packages/env/**\", \".github/workflows/env.yml\"]\n  workflow_dispatch:\n\njobs: {}\n",
  "pr-gate.yml": "name: PR Gate\n\non:\n  pull_request_target:\n    types: [opened]\n\njobs: {}\n",
  "npm-audit.yml": "name: npm audit\n\non:\n  schedule:\n    - cron: '37 7 * * *'\n  workflow_dispatch:\n\njobs: {}\n",
};

let nextId = 1;
const check = (name, conclusion, suite = nextId, status) => ({
  id: nextId++, name, status: status ?? (conclusion === null ? "in_progress" : "completed"), conclusion,
  details_url: `https://example.test/${encodeURIComponent(name)}`, check_suite: { id: suite }, app: { slug: "app" },
});
const open = (overrides = {}) => ({
  url: "https://github.com/fitchmultz/pi/pull/418", state: "OPEN", isDraft: false, mergedAt: null,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, headRefOid: HEAD, baseRefName: "main",
  mergeCommit: null, ...overrides,
});
const thread = (path, line, body) => ({
  isResolved: false, path, line, originalLine: line, comments: { nodes: [{ author: { login: "cursor" }, body }] },
});
const richThread = ({
  id = "PRRT_thread_1",
  isResolved = false,
  isOutdated = false,
  path = "src/app.ts",
  line = 42,
  originalLine = line,
  comments = [],
} = {}) => ({
  id,
  isResolved,
  isOutdated,
  path,
  line,
  originalLine,
  comments: { nodes: comments },
});
const reviewersPassed = () => [check(DURABLE, "success"), check(CURSOR, "success")];
const CI_SUITE = 116071010177;
const ciJobs = (last) => [
  check("build-check", "success", CI_SUITE), check("test (coding-agent)", "success", CI_SUITE),
  check("macos-restart-background", last, CI_SUITE),
];
const CI_RUN = "https://github.com/fitchmultz/pi/actions/runs/42858443183";
const ciRun = (event, conclusion = "success") => ({
  id: 42858443183, path: ".github/workflows/ci.yml", event, check_suite_id: CI_SUITE,
  status: conclusion === null ? "in_progress" : "completed", conclusion, html_url: CI_RUN,
});

/** Runs the watcher against a scenario. `gh` records which executable ran each read. */
function watch(polls, { args = ["--once"], repo = "fitchmultz/pi", config = CONFIG, env = {}, fail } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "watch-pr-verdict-"));
  try {
    for (const name of ["gh", "gh-personal", "gh-work", "gh-other"]) {
      writeFileSync(join(temp, name), `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
    }
    const scenario = join(temp, "scenario.json");
    const log = join(temp, "calls.ndjson");
    const configFile = join(temp, "watch-pr.json");
    writeFileSync(scenario, JSON.stringify({ polls, fail }));
    writeFileSync(log, "");
    if (config !== null) writeFileSync(configFile, typeof config === "string" ? config : JSON.stringify(config));
    const result = spawnSync(process.execPath, [script, "418", "--repo", repo, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${temp}:${process.env.PATH}`, WATCH_PR_CONFIG: configFile,
        WATCH_PR_SCENARIO: scenario, WATCH_PR_FIXTURE_LOG: log, ...env,
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    return {
      code: result.status,
      out: result.stdout,
      err: result.stderr,
      lines: result.stdout.trimEnd().split("\n"),
      gh: [...new Set(calls.map((call) => basename(call.program)))],
      calls,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Runs `pr-threads.mjs` against the offline GitHub CLI fixture. */
function runThreads(polls, { args = [], config = CONFIG, env = {}, fail, bodyFileContent } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "watch-pr-threads-"));
  try {
    for (const name of ["gh", "gh-personal", "gh-work", "gh-other"]) {
      writeFileSync(join(temp, name), `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
    }
    const scenario = join(temp, "scenario.json");
    const log = join(temp, "calls.ndjson");
    const configFile = join(temp, "watch-pr.json");
    writeFileSync(scenario, JSON.stringify({ polls, fail }));
    writeFileSync(log, "");
    if (config !== null) writeFileSync(configFile, typeof config === "string" ? config : JSON.stringify(config));
    let resolvedArgs = args;
    if (bodyFileContent !== undefined) {
      const bodyFile = join(temp, "reply.md");
      writeFileSync(bodyFile, bodyFileContent);
      resolvedArgs = args.map((arg) => (arg === "$BODY_FILE" ? bodyFile : arg));
    }
    const result = spawnSync(process.execPath, [threadsScript, ...resolvedArgs], {
      encoding: "utf8",
      env: {
        PATH: `${temp}:${process.env.PATH}`, WATCH_PR_CONFIG: configFile,
        WATCH_PR_SCENARIO: scenario, WATCH_PR_FIXTURE_LOG: log, ...env,
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    return {
      code: result.status,
      out: result.stdout,
      err: result.stderr,
      lines: result.stdout.trimEnd().split("\n"),
      gh: [...new Set(calls.map((call) => basename(call.program)))],
      calls,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
/** The verdict block: everything after the timestamped progress lines. */
const verdict = (result) => result.lines.filter((line) => !/^\d{4}-\d\d-\d\dT/.test(line));

// fitchmultz/pi#418 on 2026-11-10: GitHub had not created the pull_request run
// of CI. The pull request showed two passed reviewer checks and merge state
// CLEAN for 14 minutes, and a hand-made watcher reported it green.
test("a commit whose CI has not started is never READY", () => {
  const unregistered = { pullRequest: open(), workflows: PI_WORKFLOWS, checkRuns: reviewersPassed() };
  const once = watch([unregistered]);
  assert.equal(once.code, 5);
  assert.equal(once.lines[0], "BLOCKED: not ready; waiting for: no run of 1 workflow (ci.yml)");
  assert.ok(once.lines.includes(`checks on ${HEAD.slice(0, 7)}: 2 passed, 0 failed, 0 pending, 0 skipped`));
  assert.ok(once.lines.includes("expected checks: not registered: no run of 1 workflow (ci.yml)"));

  // CI then ran through workflow_dispatch, which the pull request's own check list does not show.
  const dispatched = (last) => ({ ...unregistered, checkRuns: [...reviewersPassed(), ...ciJobs(last)], runs: [ciRun("workflow_dispatch", last)] });
  const running = watch([dispatched(null)]);
  assert.equal(running.code, 5);
  assert.equal(running.lines[0], "BLOCKED: not ready; waiting for: 1 check pending");
  assert.ok(running.lines.includes("  pending: macos-restart-background"));

  // No pull_request run exists, so nothing shows whether the path-filtered workflows were skipped.
  const watched = watch([unregistered, dispatched(null), dispatched("success")], { args: ["--interval", "0.05"] });
  assert.equal(watched.code, 9);
  assert.deepEqual(watched.lines.slice(0, 2).map((line) => line.replace(/^\S+ /, "")), [
    `waiting on ${HEAD.slice(0, 7)}: no run of 1 workflow (ci.yml)`,
    `waiting on ${HEAD.slice(0, 7)}: 1 check pending`,
  ]);
  assert.equal(verdict(watched)[0],
    "UNKNOWN: cannot tell whether env.yml, nix.yml were skipped by filters or have not started");

  // With the pull_request run, GitHub has evaluated every pull_request workflow for this commit.
  const registered = watch([{ ...dispatched("success"), runs: [ciRun("pull_request")] }]);
  assert.equal(registered.code, 0);
  assert.deepEqual(registered.lines, [
    "READY",
    "pr: https://github.com/fitchmultz/pi/pull/418",
    `commit: ${HEAD} (head did not move during this watch)`,
    `checks on ${HEAD.slice(0, 7)}: 5 passed, 0 failed, 0 pending, 0 skipped`,
    "expected checks: all present (1 workflow that every push starts)",
    "reviewers:",
    `  ${DURABLE}: passed on ${HEAD.slice(0, 7)}`,
    `  Cursor automation: passed on ${HEAD.slice(0, 7)}`,
    "unresolved review threads: 0",
    "merge: MERGEABLE; GitHub merge state CLEAN; review decision none",
  ]);
});

// GitHub creates the check of a job that needs another job only when that job
// ends, and a run that needs approval or has an invalid file ends with no job.
test("a workflow run counts while its jobs do not exist", () => {
  const state = (run, jobs) => ({
    pullRequest: open(), workflows: PI_WORKFLOWS, runs: [run],
    checkRuns: [...reviewersPassed(), ...jobs.map((name) => check(name, "success", CI_SUITE))],
  });
  const between = watch([state(ciRun("pull_request", null), ["build-check"])]);
  assert.equal(between.code, 5);
  assert.equal(between.lines[0], "BLOCKED: not ready; waiting for: 1 check pending");
  assert.ok(between.lines.includes("checks on abe04d4: 3 passed, 0 failed, 1 pending, 0 skipped"));
  assert.ok(between.lines.includes("  pending: workflow ci.yml"));

  const unapproved = watch([state(ciRun("pull_request", "action_required"), [])]);
  assert.equal(unapproved.code, 4);
  assert.equal(unapproved.lines[0], "BLOCKED: 1 check failed");
  assert.ok(unapproved.lines.includes(`  failed: workflow ci.yml (action_required) ${CI_RUN}`));
});

// 100 `gh pr checks --watch` jobs in 30 days ended on "no checks reported".
test("a commit without checks is waited on, then reported as unknown, never as ready", () => {
  const bare = { pullRequest: open() };
  const late = watch([bare, { ...bare, checkRuns: [check("build", "success")] }], { args: ["--interval", "0.05"], config: null });
  assert.equal(late.code, 0);
  assert.match(late.lines[0], /waiting on abe04d4: checks may not have registered yet$/);
  assert.equal(verdict(late)[0], "READY");
  assert.ok(late.lines.includes("expected checks: none known (no required status checks, no workflow that every push starts)"));

  const never = watch([bare], { args: ["--interval", "0.05"], config: null });
  assert.equal(never.code, 9);
  assert.equal(verdict(never)[0], "UNKNOWN: no checks on this commit, and nothing says whether any are expected");
});

// A private repository on 2026-11-10: 15 checks passed, but none of the nine
// required Depot CI checks had been reported 75 minutes after the push.
test("required status checks that were never reported keep the pull request from READY", () => {
  const rules = [
    { type: "pull_request", parameters: {} },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "Depot CI / verify" }, { context: "Depot CI / checks" }] } },
  ];
  const state = {
    pullRequest: open({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }), rules,
    checkRuns: [check("Review bot", "success")], statuses: [{ context: "app-verify", state: "success", target_url: "" }],
    comments: [{ user: { login: "greptile-apps[bot]" }, updated_at: "2026-11-10T16:30:56Z", body: `Confidence Score: 5/5 (https://github.com/acme/app/commit/${HEAD})` }],
  };
  const missing = watch([state], { repo: "acme/app" });
  assert.equal(missing.code, 5);
  assert.equal(missing.lines[0],
    "BLOCKED: not ready; waiting for: 2 required checks not reported (Depot CI / verify, Depot CI / checks)");

  const reported = watch([{ ...state, checkRuns: [...state.checkRuns, check("Depot CI / verify", "success"), check("Depot CI / checks", "success")] }], { repo: "acme/app" });
  assert.equal(reported.code, 0);
  assert.deepEqual(reported.lines.slice(3), [
    "checks on abe04d4: 4 passed, 0 failed, 0 pending, 0 skipped",
    "expected checks: all present (2 required checks)",
    "reviewers:",
    "  Greptile: 5/5 on abe04d4",
    "  Review bot: passed on abe04d4",
    "unresolved review threads: 0",
    "merge: MERGEABLE; GitHub merge state BLOCKED; review decision REVIEW_REQUIRED (configuration allows a merge without approval)",
  ]);

  // Without that setting, the review that GitHub requires blocks.
  const comments = [{ ...state.comments[0], body: state.comments[0].body.replace("acme/app", "acme/other") }];
  const unapproved = watch([{ ...state, rules: [], comments }], { repo: "acme/other" });
  assert.equal(unapproved.code, 6);
  assert.equal(unapproved.lines[0], "BLOCKED: GitHub requires an approving review");
  assert.equal(unapproved.lines.at(-1), "merge: MERGEABLE; GitHub merge state BLOCKED; review decision REVIEW_REQUIRED");
});

test("the GitHub CLI comes from the owner's configuration, and WATCH_PR_GH overrides it", () => {
  const state = { pullRequest: open(), checkRuns: reviewersPassed() };
  assert.deepEqual(watch([state]).gh, ["gh-personal"]);
  assert.deepEqual(watch([state], { repo: "acme/app" }).gh, ["gh-work"]);
  assert.deepEqual(watch([state], { repo: "acme/app", env: { WATCH_PR_GH: "gh-other" } }).gh, ["gh-other"]);
  assert.deepEqual(watch([state], { config: null }).gh, ["gh"]);
  const reads = watch([state]).calls;
  assert.ok(reads.length > 0 && reads.every(({ argv }) => argv[0] === "api" && !argv.some((arg) => /^(-X|--method|--input)$/.test(arg))),
    "every GitHub call is a read");
});

test("a reviewer signs off only on the head commit", () => {
  const greptile = (score, sha) => ({
    user: { login: "greptile-apps[bot]" }, updated_at: "2026-11-10T16:30:56Z",
    body: `<h2>Confidence Score: ${score}</h2>\n<sub>Last reviewed commit: ["fix"](https://github.com/acme/app/commit/${sha})</sub>`,
  });
  const run = (state) => watch([{ pullRequest: open(), ...state }], { repo: "acme/app" });
  const bot = [check("Review bot", "success")];

  const stale = run({ checkRuns: bot, comments: [greptile("5/5", OLD)] });
  assert.equal(stale.code, 5);
  assert.equal(stale.lines[0], "BLOCKED: not ready; waiting for: Greptile: 5/5 on 11a9aa0, not on this commit");

  const low = run({ checkRuns: bot, comments: [greptile("3/5", HEAD)] });
  assert.equal(low.code, 8);
  assert.equal(low.lines[0], "BLOCKED: Greptile did not sign off: 3/5 on abe04d4 (needs 5/5)");

  const notStarted = run({ checkRuns: [check("build", "success")], comments: [greptile("5/5", HEAD)] });
  assert.equal(notStarted.code, 5);
  assert.equal(notStarted.lines[0], "BLOCKED: not ready; waiting for: Review bot: not started on abe04d4");

  // A rule that cannot be evaluated is not a sign-off.
  const noCommit = run({ checkRuns: bot, comments: [{ ...greptile("5/5", HEAD), body: "Confidence Score: 5/5" }] });
  assert.equal(noCommit.code, 9);
  assert.equal(noCommit.lines[0], "UNKNOWN: Greptile: 5/5, but its text does not name a commit");

  // The score can also be the body of a review, which GitHub ties to a commit.
  const review = run({ checkRuns: bot, reviews: [{ user: { login: "greptile-apps[bot]" }, submitted_at: "2026-11-10T16:30:56Z", commit_id: HEAD, body: "Confidence Score: 5/5" }] });
  assert.equal(review.code, 0);
  assert.ok(review.lines.includes("  Greptile: 5/5 on abe04d4"));

  const misspelled = watch([{ pullRequest: open() }], { config: { acme: { reviewer: [] } }, repo: "acme/app" });
  assert.equal(misspelled.code, 64);
  assert.match(misspelled.err, /"acme" has the unknown key "reviewer"/);
});

test("blockers keep the packaged watcher's exit codes", () => {
  const ok = reviewersPassed();
  const exit = (state) => {
    const result = watch([{ checkRuns: ok, ...state }]);
    return [result.code, result.lines[0]];
  };
  assert.deepEqual(exit({ pullRequest: open({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }) }),
    [2, "BLOCKED: merge conflicts with main"]);
  assert.deepEqual(exit({ pullRequest: open(), threads: [thread("a.ts", 3, "Fix this")] }),
    [3, "BLOCKED: 1 unresolved review thread"]);
  assert.deepEqual(exit({ pullRequest: open(), checkRuns: [...ok, check("build", "failure")] }), [4, "BLOCKED: 1 check failed"]);
  assert.deepEqual(exit({ pullRequest: open({ isDraft: true }) }), [6, "BLOCKED: pull request is a draft"]);
  assert.deepEqual(exit({ pullRequest: open({ reviewDecision: "CHANGES_REQUESTED" }) }), [6, "BLOCKED: a reviewer requested changes"]);
  assert.deepEqual(exit({ pullRequest: open({ state: "CLOSED" }) }), [6, "BLOCKED: pull request is closed without a merge"]);
  assert.deepEqual(exit({ pullRequest: open({ mergeStateStatus: "BEHIND" }) }), [6, "BLOCKED: head branch is behind main"]);
  assert.deepEqual(exit({ pullRequest: open({ mergeStateStatus: "BLOCKED" }) }),
    [9, "UNKNOWN: GitHub blocks the merge and the watcher found no cause"]);
  // A watch that is still waiting at its time limit ends and says what it waited for.
  const slow = watch([{ pullRequest: open(), checkRuns: [check(DURABLE, null), check(CURSOR, "success")] }],
    { args: ["--timeout", "0.3", "--interval", "0.05"] });
  assert.equal(slow.code, 5);
  assert.equal(verdict(slow)[0],
    `BLOCKED: timed out after 0.3 s; waiting for: 1 check pending; ${DURABLE}: running on abe04d4`);
  assert.deepEqual(watch([{ pullRequest: open({ state: "MERGED", mergedAt: "2026-11-10T17:16:21Z", mergeCommit: { oid: "96ab2f855" } }) }]).lines, [
    "MERGED",
    "pr: https://github.com/fitchmultz/pi/pull/418",
    `commit: ${HEAD} merged at 2026-11-10T17:16:21Z as 96ab2f8`,
  ]);

  // A failed read is retried five times; the packaged watcher has the same budget.
  const failed = watch([{ pullRequest: open() }], { args: ["--interval", "0.05"], fail: { stderr: "gh: HTTP 502: Bad Gateway" } });
  assert.equal(failed.code, 7);
  assert.equal(failed.calls.length, 5);
  assert.deepEqual(verdict(failed).slice(0, 2), [
    "BLOCKED: GitHub query failed 5 times in a row: gh-personal api graphql exited 1: gh: HTTP 502: Bad Gateway",
    "pr: https://github.com/fitchmultz/pi/pull/418",
  ]);
  assert.match(verdict(failed)[2], /^github cli: gh-personal \(.*watch-pr\.json\)$/);

  // The wrong account cannot see the repository. Repeating that read cannot help.
  const stderr = "gh: Could not resolve to a Repository with the name 'fitchmultz/pi'.";
  const hidden = watch([{ pullRequest: open() }], { args: ["--interval", "0.05"], fail: {
    stderr, body: { data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: stderr.slice(4) }] },
  } });
  assert.equal(hidden.code, 7);
  assert.equal(hidden.calls.length, 1);
  assert.equal(hidden.lines[0], `BLOCKED: GitHub query failed: gh-personal api graphql exited 1: ${stderr}`);
  assert.equal(watch([{ pullRequest: open() }], { args: ["--interval", "0"] }).code, 64);
});

function primaryLimitOnLaterPage(state, reset) {
  const message = "API rate limit exceeded for user ID 1234.";
  return {
    ...state,
    fail: {
      endpoint: "/check-runs?", firstPage: { check_runs: state.checkRuns },
      firstHeaders: { "X-Ratelimit-Remaining": "1" },
      status: 403, body: { message }, stderr: `gh: ${message} (HTTP 403)`,
      headers: { "X-Ratelimit-Resource": "core", "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": reset },
    },
  };
}

test("a reset inside the watch timeout resumes before the next ordinary poll", () => {
  const done = { pullRequest: open(), checkRuns: reviewersPassed() };
  const reset = Math.floor(Date.now() / 1000) + 2;
  const result = watch([primaryLimitOnLaterPage(done, reset), done], { args: ["--timeout", "4"] });
  assert.equal(result.code, 0, result.out);
  assert.match(verdict(result)[0], /^READY/);
  const reads = result.calls.filter(({ argv }) => argv[1].includes("/check-runs?"));
  assert.equal(reads.length, 2);
  assert.ok(reads[0].at < reset * 1000 && reads[1].at >= reset * 1000, "the retry waited for the reset");
});

test("a REST primary rate limit on a later page waits without spending query retries", () => {
  const done = { pullRequest: open(), checkRuns: reviewersPassed() };
  const limited = (reset) => primaryLimitOnLaterPage(done, reset);
  const reset = Math.floor(Date.now() / 1000) + 60;
  const timed = watch([limited(reset)], { args: ["--timeout", "0.6", "--interval", "0.05"] });
  assert.equal(timed.code, 5);
  assert.match(verdict(timed)[0], /^BLOCKED: timed out after 0.6 s; GitHub primary rate limit/);
  assert.ok(timed.out.includes(new Date(reset * 1000).toISOString()));
  assert.equal(timed.calls.filter(({ argv }) => argv[1].includes("/check-runs?")).length, 1);

  const once = watch([limited(reset)]);
  assert.equal(once.code, 7);
  assert.match(once.lines[0], /^BLOCKED: GitHub query failed: GitHub primary rate limit/);
  assert.equal(once.calls.filter(({ argv }) => argv[1].includes("/check-runs?")).length, 1);

  const expired = limited(Math.floor(Date.now() / 1000) - 1);
  const stale = watch([expired, done], { args: ["--timeout", "0.6"] });
  assert.equal(stale.code, 5);
  assert.equal(stale.calls.filter(({ argv }) => argv[1].includes("/check-runs?")).length, 1);

  const recovered = watch([...Array(5).fill(expired), done], { args: ["--timeout", "0", "--interval", "0.05"] });
  assert.equal(recovered.code, 0);
  assert.match(verdict(recovered)[0], /^READY/);
  assert.doesNotMatch(recovered.out, /retry \d\/5/);
  assert.equal(recovered.calls.filter(({ argv }) => argv[1].includes("/check-runs?")).length, 6);
});

test("GraphQL rate reports use their own reset or Retry-After, not a failed CI verdict", () => {
  const deadline = Math.floor(Date.now() / 1000) + 90;
  for (const [kind, message, headers] of [
    ["primary", "API rate limit exceeded", { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": deadline }],
    ["secondary", "You have exceeded a secondary rate limit.", {
      "Retry-After": "30", "X-Ratelimit-Remaining": "43", "X-Ratelimit-Reset": deadline,
    }],
  ]) {
    const result = watch([], {
      args: ["--timeout", "0.3", "--interval", "0.05"],
      fail: { status: 200, headers, stderr: `gh: ${message}`, body: { errors: [{ type: "RATE_LIMITED", message }] } },
    });
    assert.equal(result.code, 5);
    assert.match(verdict(result)[0], new RegExp(`^BLOCKED: timed out after 0.3 s; GitHub ${kind} rate limit`));
    assert.equal(result.calls.length, 1);
    if (kind === "secondary") assert.ok(!result.out.includes(new Date(deadline * 1000).toISOString()));
  }

  const done = { pullRequest: open(), checkRuns: reviewersPassed() };
  const message = "You have exceeded a secondary rate limit.";
  const restricted = { fail: {
    endpoint: "graphql", status: 200, headers: { "Retry-After": "1" },
    stderr: `gh: ${message}`, body: { errors: [{ type: "RATE_LIMITED", message }] },
  } };
  const resumed = watch([restricted, done], { args: ["--timeout", "4"] });
  assert.equal(resumed.code, 0, resumed.out);
  const reads = resumed.calls.filter(({ argv }) => argv.some((arg) => arg.includes("reviewThreads")));
  assert.equal(reads.length, 2);
  assert.ok(reads[1].at - reads[0].at >= 1000, "the retry waited for Retry-After");

  const forbidden = watch([], { args: ["--interval", "0.05"], fail: {
    status: 403, headers: { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": deadline },
    stderr: "gh: Resource not accessible by personal access token (HTTP 403)",
    body: { message: "Resource not accessible by personal access token" },
  } });
  assert.equal(forbidden.code, 7);
  assert.match(verdict(forbidden)[0], /Resource not accessible by personal access token/);
  assert.doesNotMatch(forbidden.out, /GitHub (primary|secondary) rate limit/);
});

// Seen on a real pull request: one cancelled and one successful run of verify.yml on the same commit.
test("a workflow that ran again on the commit counts once for each job name", () => {
  const runs = [
    { id: 42853700001, path: ".github/workflows/verify.yml", event: "pull_request", check_suite_id: 116058344570, status: "completed", conclusion: "cancelled" },
    { id: 42853900002, path: ".github/workflows/verify.yml", event: "pull_request", check_suite_id: 116058673261, status: "completed", conclusion: "success" },
  ];
  const result = watch([{
    pullRequest: open(), runs,
    checkRuns: [...reviewersPassed(), check("verify", "cancelled", 116058344570), check("verify", "success", 116058673261)],
  }]);
  assert.equal(result.code, 0);
  assert.ok(result.lines.includes("checks on abe04d4: 3 passed, 0 failed, 0 pending, 0 skipped"));

  // The cancelled run's check does not count as a failure while the new run has no job yet.
  const restarted = watch([{
    pullRequest: open(), runs: [runs[0], { ...runs[1], status: "queued", conclusion: null }],
    checkRuns: [...reviewersPassed(), check("verify", "cancelled", 116058344570)],
  }]);
  assert.equal(restarted.code, 5);
  assert.equal(restarted.lines[0], "BLOCKED: not ready; waiting for: 1 check pending");
  assert.ok(restarted.lines.includes("  pending: workflow verify.yml"));

  // Seen on a real pull request: a later run of the same workflow and event held a different job. Both jobs count.
  const relabeled = watch([{
    pullRequest: open(), runs: [{ ...runs[0], conclusion: "failure" }, runs[1]],
    checkRuns: [...reviewersPassed(), check("Verification task", "failure", 116058344570), check("Verification unchanged", "success", 116058673261)],
  }]);
  assert.equal(relabeled.code, 4);
  assert.ok(relabeled.lines.includes("checks on abe04d4: 3 passed, 1 failed, 0 pending, 0 skipped"));
});

test("the verdict names the commit it is about when the head moves", () => {
  const before = { pullRequest: open({ headRefOid: OLD }), checkRuns: [check(DURABLE, null), check(CURSOR, "success")] };
  const after = { pullRequest: open(), checkRuns: reviewersPassed() };
  const moved = watch([before, after], { args: ["--interval", "0.05"] });
  assert.equal(moved.code, 0);
  assert.deepEqual(verdict(moved).slice(0, 3), [
    "READY",
    "pr: https://github.com/fitchmultz/pi/pull/418",
    `commit: ${HEAD} (head moved during this watch; it started on 11a9aa0)`,
  ]);

  // A push that lands while the watcher reads is found before READY is printed.
  const racing = watch([{ ...before, checkRuns: reviewersPassed(), confirmHead: HEAD }, after], { args: ["--interval", "0.05"] });
  assert.equal(racing.code, 0);
  assert.equal(verdict(racing)[2], `commit: ${HEAD} (head moved during this watch; it started on 11a9aa0)`);
});

// A failed job's completion notice carries the last 20 lines and 2048 bytes of its output.
test("the verdict block fits a background_command completion notice", () => {
  const long = "Résumé: this finding is long. ".repeat(40);
  const result = watch([{
    pullRequest: open(),
    threads: Array.from({ length: 30 }, (_, index) => thread(`packages/coding-agent/src/file-${index}.ts`, index + 1, `<b>P1</b> ${long}`)),
    checkRuns: [...reviewersPassed(), ...Array.from({ length: 40 }, (_, index) => check(`test (${index})`, "failure"))],
  }]);
  assert.equal(result.code, 3);
  assert.ok(result.lines.length <= 20, `${result.lines.length} lines`);
  assert.ok(Buffer.byteLength(result.out) <= 2048, `${Buffer.byteLength(result.out)} bytes`);
  assert.equal(result.lines[0], "BLOCKED: 30 unresolved review threads");
  assert.equal(result.lines.at(-1), "merge: MERGEABLE; GitHub merge state CLEAN; review decision none");
  assert.ok(result.lines.includes("checks on abe04d4: 2 passed, 40 failed, 0 pending, 0 skipped"));
  assert.ok(result.lines.includes("  failed: test (0) (failure) https://example.test/test%20(0)"));
  const firstThread = result.lines.find((line) => line.startsWith("  packages/coding-agent/src/file-0.ts:1 @cursor: "));
  assert.equal(firstThread.split("@cursor: ")[1], `P1 ${long}`.slice(0, 199) + "\u2026");
  const shown = (prefix) => result.lines.filter((line) => line.startsWith(prefix)).length;
  assert.ok(result.lines.includes(`  ... ${40 - shown("  failed: ")} more failed checks`));
  assert.ok(result.lines.includes(`  ... ${30 - shown("  packages/")} more threads`));
});

test("workflow triggers decide whether a push must start a run", () => {
  const kinds = (base) => Object.fromEntries(Object.entries(PI_WORKFLOWS).map(([name, text]) => [name, classifyWorkflow(text, base).kind]));
  assert.deepEqual(kinds("main"), { "ci.yml": "always", "nix.yml": "filtered", "env.yml": "filtered", "pr-gate.yml": "never", "npm-audit.yml": "never" });
  // A stacked pull request targets a feature branch, which `branches: [main]` excludes.
  assert.deepEqual(kinds("feature"), { "ci.yml": "never", "nix.yml": "never", "env.yml": "never", "pr-gate.yml": "never", "npm-audit.yml": "never" });
  for (const [text, kind] of [
    ["on: pull_request\n", "always"],
    ["'on': [push, pull_request_target] # every change\n", "always"],
    ["on:\n- push\n- pull_request\njobs: {}\n", "always"],
    ["on:\n  pull_request:\n    types: [opened, reopened, synchronize, edited]\n", "always"],
    ["on:\n  pull_request:\n    branches:\n    - main\n    paths-ignore:\n    - 'docs/**'\n", "filtered"],
    ["on:\n  pull_request:\n    branches: ['release/**']\n", "filtered"],
    ["on: {pull_request: {types: [labeled]}, push: {branches: [main]}}\n", "never"],
    ["on:\n  workflow_dispatch:\n    inputs:\n      pr:\n        description: |\n          Number: of the pull_request\n", "never"],
    ["on:\n  pull_request: &filters\n    branches: [main]\n", "unreadable"],
    ["name: no triggers\njobs: {}\n", "unreadable"],
    // A tab counts only inside the `on:` section, not in a job's script.
    ["on:\n\tpull_request:\n", "unreadable"],
    ["on:\n  schedule:\n  - cron: '0 3 * * *'\njobs:\n  build:\n    steps:\n    - run: |\n        cat > Makefile <<'EOF'\n        all:\n        \tmake it\n        EOF\n", "never"],
    ["on: pull_request\njobs:\n  build:\n    steps:\n    - run: |\n        \techo tab\n", "always"],
  ]) assert.equal(classifyWorkflow(text, "main").kind, kind, text);

  const unreadable = watch([{ pullRequest: open(), checkRuns: reviewersPassed(), workflows: { "ci.yml": "on:\n  pull_request: &filters\n    branches: [main]\n" } }]);
  assert.equal(unreadable.code, 9);
  assert.equal(unreadable.lines[0], "UNKNOWN: cannot read the triggers of ci.yml");
});

// A watcher started right after a push can read GitHub before the pull request
// reports the new head, and would judge the previous commit's checks.
test("--sha waits for the pushed commit before evaluating anything", () => {
  const stale = {
    pullRequest: open({ headRefOid: OLD }),
    checkRuns: [check(DURABLE, "failure"), check(CURSOR, "success")],
  };
  const landed = { pullRequest: open(), checkRuns: reviewersPassed() };

  // The previous head's failed check is never judged; the verdict is about the requested commit.
  const waited = watch([stale, landed], { args: ["--sha", HEAD.slice(0, 7), "--interval", "0.05"] });
  assert.equal(waited.code, 0);
  assert.deepEqual(waited.lines.slice(0, 1).map((line) => line.replace(/^\S+ /, "")), [
    `waiting for the head to reach ${HEAD.slice(0, 7)}: now ${OLD.slice(0, 7)}`,
  ]);
  assert.deepEqual(verdict(waited).slice(0, 3), [
    "READY",
    "pr: https://github.com/fitchmultz/pi/pull/418",
    `commit: ${HEAD} (head did not move during this watch)`,
  ]);

  // A head that does not reach the commit is waited for under the watch's own timeout.
  const stuck = watch([stale], { args: ["--sha", HEAD, "--interval", "0.05", "--timeout", "0.3"] });
  assert.equal(stuck.code, 5);
  assert.equal(verdict(stuck)[0], `BLOCKED: timed out after 0.3 s; waiting for: the head to reach ${HEAD.slice(0, 7)}`);

  // --once takes one look: the head simply has not reached the commit yet.
  const glance = watch([stale], { args: ["--sha", HEAD, "--once"] });
  assert.equal(glance.code, 5);
  assert.equal(glance.lines[0], `BLOCKED: not ready; waiting for: the head to reach ${HEAD.slice(0, 7)}`);

  // A successful wait between failed reads resets the retry budget, so the failures are not "in a row".
  const fail502 = { fail: { stderr: "gh: HTTP 502: Bad Gateway" } };
  const recovered = watch([fail502, fail502, fail502, fail502, stale, fail502, landed], {
    args: ["--sha", HEAD.slice(0, 7), "--interval", "0.05"],
  });
  assert.equal(recovered.code, 0);
  assert.deepEqual(recovered.lines.map((line) => line.replace(/^\S+ /, "")).slice(0, 6), [
    "retry 1/5: gh-personal api graphql exited 1: gh: HTTP 502: Bad Gateway",
    "retry 2/5: gh-personal api graphql exited 1: gh: HTTP 502: Bad Gateway",
    "retry 3/5: gh-personal api graphql exited 1: gh: HTTP 502: Bad Gateway",
    "retry 4/5: gh-personal api graphql exited 1: gh: HTTP 502: Bad Gateway",
    `waiting for the head to reach ${HEAD.slice(0, 7)}: now ${OLD.slice(0, 7)}`,
    "retry 1/5: gh-personal api graphql exited 1: gh: HTTP 502: Bad Gateway",
  ]);

  assert.equal(watch([{ pullRequest: open() }], { args: ["--sha", "zzzzzzz"] }).code, 64);
});

test("GH_TOKEN and GITHUB_TOKEN are stripped before invoking the configured GitHub CLI", () => {
  const state = { pullRequest: open(), checkRuns: reviewersPassed() };
  const result = watch([state], {
    repo: "acme/app",
    config: { "*": { gh: "gh-personal" }, acme: { gh: "gh-work" } },
    env: { GH_TOKEN: "ghp_should_be_stripped", GITHUB_TOKEN: "ghp_also_stripped" },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.gh, ["gh-work"]);
  assert.ok(result.calls.length > 0);
  assert.ok(result.calls.every((call) => call.env.hasGhToken === false && call.env.hasGithubToken === false));
});

test("--required-checks-only settles non-required pending/cancelled checks and fails closed without required checks", () => {
  const rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "Depot CI / verify" }] } }];
  const greptilePass = {
    user: { login: "greptile-apps[bot]" }, updated_at: "2026-11-10T16:30:56Z",
    body: `Confidence Score: 5/5 (https://github.com/acme/app/commit/${HEAD})`,
  };
  const state = {
    pullRequest: open({ mergeStateStatus: "CLEAN" }),
    rules,
    workflows: PI_WORKFLOWS,
    checkRuns: [
      check("Review bot", "success"),
      check("Depot CI / verify", "success"),
      check("Optional Deploy", null, 9100, "waiting"),
      check("Cancelled Bench", "cancelled", 9101),
    ],
    comments: [greptilePass],
  };
  const ready = watch([state], { repo: "acme/app", args: ["--once", "--required-checks-only"] });
  assert.equal(ready.code, 0, ready.out);
  assert.equal(ready.lines[0], "READY");
  assert.ok(ready.lines.includes(`checks on ${HEAD.slice(0, 7)}: 2 passed, 0 failed, 0 pending, 0 skipped, 2 optional`));
  assert.ok(ready.lines.includes("  optional (ignored): Optional Deploy (waiting), Cancelled Bench (cancelled)"));
  assert.ok(ready.lines.includes("expected checks: all required present (1 required check; --required-checks-only)"));

  // Settles on poll transition as soon as the required check passes, while a manual-approval deploy job stays waiting.
  const poll1 = {
    ...state,
    checkRuns: [
      check("Review bot", "success"),
      check("Depot CI / verify", null, 9105, "in_progress"),
      check("Optional Deploy", null, 9100, "waiting"),
    ],
  };
  const settled = watch([poll1, state], {
    repo: "acme/app",
    args: ["--required-checks-only", "--interval", "0.05"],
  });
  assert.equal(settled.code, 0, settled.out);
  assert.match(settled.lines[0], /waiting on abe04d4: 1 check pending$/);
  assert.equal(verdict(settled)[0], "READY");

  // Non-required explicit failure or timed_out STILL blocks even with --required-checks-only.
  for (const conclusion of ["failure", "timed_out"]) {
    const failedOptional = watch([{
      ...state,
      checkRuns: [...state.checkRuns, check("Optional Lint", conclusion, 9102)],
    }], { repo: "acme/app", args: ["--once", "--required-checks-only"] });
    assert.equal(failedOptional.code, 4, `expected exit 4 for ${conclusion}: ${failedOptional.out}`);
    assert.equal(failedOptional.lines[0], "BLOCKED: 1 check failed");
  }

  // Fail-closed: required checks declared by branch protection/rulesets are NEVER ignored.
  const reqPending = watch([{
    ...state,
    checkRuns: [check("Review bot", "success"), check("Depot CI / verify", null, 9103, "in_progress")],
  }], { repo: "acme/app", args: ["--once", "--required-checks-only"] });
  assert.equal(reqPending.code, 5, reqPending.out);
  assert.equal(reqPending.lines[0], "BLOCKED: not ready; waiting for: 1 check pending");

  const reqCancelled = watch([{
    ...state,
    checkRuns: [check("Review bot", "success"), check("Depot CI / verify", "cancelled", 9104)],
  }], { repo: "acme/app", args: ["--once", "--required-checks-only"] });
  assert.equal(reqCancelled.code, 4, reqCancelled.out);
  assert.equal(reqCancelled.lines[0], "BLOCKED: 1 check failed");

  // Fail-closed: configured reviewer checks are NEVER ignored even if not listed in GitHub rules.
  const revPending = watch([{
    ...state,
    checkRuns: [check("Review bot", null, 9106, "in_progress"), check("Depot CI / verify", "success")],
  }], { repo: "acme/app", args: ["--once", "--required-checks-only"] });
  assert.equal(revPending.code, 5, revPending.out);
  assert.match(revPending.lines[0], /Review bot: running/);

  const revCancelled = watch([{
    ...state,
    checkRuns: [check("Review bot", "cancelled", 9107), check("Depot CI / verify", "success")],
  }], { repo: "acme/app", args: ["--once", "--required-checks-only"] });
  assert.equal(revCancelled.code, 4, revCancelled.out);
  assert.equal(revCancelled.lines[0], "BLOCKED: 1 check failed");

  // Missing required check STILL waits under --required-checks-only.
  const missingReq = watch([{
    ...state,
    checkRuns: [check("Review bot", "success"), check("Optional Deploy", null, 9100, "waiting")],
  }], { repo: "acme/app", args: ["--once", "--required-checks-only"] });
  assert.equal(missingReq.code, 5, missingReq.out);
  assert.equal(missingReq.lines[0], "BLOCKED: not ready; waiting for: 1 required check not reported (Depot CI / verify)");

  // Fail-closed: if GitHub declares no required status checks, --required-checks-only returns UNKNOWN (exit 9).
  const noRules = watch([{
    pullRequest: open(),
    checkRuns: [...reviewersPassed(), check("build", "success")],
  }], { args: ["--once", "--required-checks-only"] });
  assert.equal(noRules.code, 9, noRules.out);
  assert.equal(noRules.lines[0], "UNKNOWN: --required-checks-only requested, but GitHub declares no required status checks for main");

  // Must fail closed immediately even when pending checks or an always-on workflow are still waiting.
  const noRulesPending = watch([{
    pullRequest: open(),
    workflows: PI_WORKFLOWS,
    checkRuns: [...reviewersPassed(), check("build", null)],
  }], { args: ["--once", "--required-checks-only"] });
  assert.equal(noRulesPending.code, 9, noRulesPending.out);
  assert.equal(noRulesPending.lines[0], "UNKNOWN: --required-checks-only requested, but GitHub declares no required status checks for main");
  assert.ok(noRulesPending.lines.includes("expected checks: none declared (required by --required-checks-only)"));
});

test("unresolved review threads show commit SHA (head vs older) and parsed severity in watch-pr without extra API calls", () => {
  const headThread = richThread({
    id: "PRRT_head",
    path: "app/auth.ts",
    line: 88,
    comments: [{
      id: "PRRC_1",
      fullDatabaseId: "1001",
      commit: { oid: HEAD },
      originalCommit: { oid: HEAD },
      author: { login: "tars-reviewer" },
      body: "[blocks] Missing tenant check before lookup",
      url: "https://github.com/fitchmultz/pi/pull/418#discussion_r1001",
      createdAt: "2026-11-20T01:00:00Z",
      outdated: false,
    }],
  });
  const olderThread = richThread({
    id: "PRRT_older",
    isOutdated: true,
    path: "app/rate.ts",
    line: null,
    originalLine: 210,
    comments: [{
      id: "PRRC_2",
      fullDatabaseId: "1002",
      // Even if GitHub slid commit.oid to HEAD, originalCommit reflects where it was authored.
      commit: { oid: HEAD },
      originalCommit: { oid: OLD },
      author: { login: "cursor" },
      body: "<!-- CURSOR_AUTOMATION_ID: abc -->\n**Medium: Rate-limit wait floors on interval**",
      url: "https://github.com/fitchmultz/pi/pull/418#discussion_r1002",
      createdAt: "2026-11-19T23:00:00Z",
      outdated: true,
    }],
  });
  const result = watch([{
    pullRequest: open(),
    checkRuns: reviewersPassed(),
    threads: [headThread, olderThread],
  }]);
  assert.equal(result.code, 3, result.out);
  assert.ok(result.lines.length <= 20);
  assert.ok(Buffer.byteLength(result.out) <= 2048);
  assert.ok(result.lines.includes(
    `  app/auth.ts:88 @tars-reviewer [${HEAD.slice(0, 7)} head, blocks]: [blocks] Missing tenant check before lookup`,
  ), result.out);
  assert.ok(result.lines.includes(
    `  app/rate.ts:210 @cursor [${OLD.slice(0, 7)} older, medium]: **Medium: Rate-limit wait floors on interval**`,
  ), result.out);
  // Verify only ONE reviewThreads GraphQL query was made (no extra API call).
  const threadQueries = result.calls.filter(({ argv }) => argv.some((arg) => arg.includes("reviewThreads")));
  assert.equal(threadQueries.length, 1);
  const queryArg = threadQueries[0].argv.find((arg) => arg.startsWith("query="));
  assert.match(queryArg, /comments\(first:20\)/);
  assert.match(queryArg, /originalCommit\{oid\}/);
  assert.match(queryArg, /isOutdated/);
});

test("pr-threads.mjs lists, replies to, and resolves threads using shared repo routing and env sanitization", () => {
  const threads = [
    richThread({
      id: "PRRT_open_1",
      path: "src/server.ts",
      line: 54,
      comments: [
        {
          id: "PRRC_10",
          fullDatabaseId: "2010",
          commit: { oid: HEAD },
          originalCommit: { oid: HEAD },
          author: { login: "tars-reviewer" },
          body: "`fix-if-cheap`: extract repeated header parser",
          url: "https://github.com/acme/app/pull/418#discussion_r2010",
          createdAt: "2026-11-20T02:00:00Z",
          outdated: false,
        },
        {
          id: "PRRC_11",
          fullDatabaseId: "2011",
          commit: { oid: HEAD },
          originalCommit: { oid: HEAD },
          author: { login: "dev" },
          body: "Will clean up in next push.",
          url: "https://github.com/acme/app/pull/418#discussion_r2011",
          createdAt: "2026-11-20T02:05:00Z",
          outdated: false,
        },
      ],
    }),
    richThread({
      id: "PRRT_resolved_1",
      isResolved: true,
      isOutdated: true,
      path: "src/old.ts",
      line: 12,
      comments: [{
        id: "PRRC_12",
        fullDatabaseId: "2012",
        commit: { oid: OLD },
        originalCommit: { oid: OLD },
        author: { login: "cursor" },
        body: "Nit: typo in log message",
        url: "https://github.com/acme/app/pull/418#discussion_r2012",
        createdAt: "2026-11-19T22:00:00Z",
        outdated: true,
      }],
    }),
  ];
  const pollState = {
    pullRequest: open({ url: "https://github.com/acme/app/pull/418" }),
    threads,
  };

  // --list routes acme/app through gh-work, strips GH_TOKEN/GITHUB_TOKEN, and omits resolved threads.
  const listed = runThreads([pollState], {
    args: ["https://github.com/acme/app/pull/418", "--list"],
    env: { GH_TOKEN: "leaked", GITHUB_TOKEN: "leaked2" },
  });
  assert.equal(listed.code, 0, listed.err);
  assert.deepEqual(listed.gh, ["gh-work"]);
  assert.ok(listed.calls.every((call) => !call.env.hasGhToken && !call.env.hasGithubToken));
  assert.match(listed.out, /^pr: https:\/\/github\.com\/acme\/app\/pull\/418$/m);
  assert.match(listed.out, /^unresolved threads: 1$/m);
  assert.match(listed.out, /PRRT_open_1\s+src\/server\.ts:54\s+@tars-reviewer\s+abe04d4 \(head\)\s+\[fix-if-cheap\]\s+\(2 comments\)/);
  assert.match(listed.out, /url: https:\/\/github\.com\/acme\/app\/pull\/418#discussion_r2010/);
  assert.doesNotMatch(listed.out, /PRRT_resolved_1/);

  // --list --all --json includes resolved threads and structured metadata.
  const listedJson = runThreads([pollState], {
    args: ["418", "--repo", "acme/app", "--list", "--all", "--json"],
  });
  assert.equal(listedJson.code, 0, listedJson.err);
  const payload = JSON.parse(listedJson.out);
  assert.equal(payload.unresolvedCount, 1);
  assert.equal(payload.threads.length, 2);
  assert.equal(payload.threads[0].id, "PRRT_open_1");
  assert.equal(payload.threads[0].severity, "fix-if-cheap");
  assert.equal(payload.threads[0].databaseId, "2010");
  assert.equal(payload.threads[1].isResolved, true);
  assert.equal(payload.threads[1].severity, "nit");

  // --reply + --resolve works without a PR number, preserves special shell characters in body-file,
  // and routes through gh-work.
  const replyText = "Fixed in `abc1234` — safe against $(whoami) and \"$HOME\".\n\nSecond line.";
  const replied = runThreads([pollState], {
    args: ["--repo", "acme/app", "--reply", "PRRT_open_1", "--body-file", "$BODY_FILE", "--resolve", "PRRT_open_1"],
    bodyFileContent: replyText,
    env: { GH_TOKEN: "leaked", GITHUB_TOKEN: "leaked2" },
  });
  assert.equal(replied.code, 0, replied.err);
  assert.deepEqual(replied.gh, ["gh-work"]);
  assert.ok(replied.calls.every((call) => !call.env.hasGhToken && !call.env.hasGithubToken));
  assert.equal(replied.calls.length, 2);
  assert.ok(replied.calls[0].argv.includes("threadId=PRRT_open_1"));
  assert.ok(replied.calls[0].argv.includes(`body=${replyText}`));
  assert.ok(replied.calls[1].argv.some((arg) => arg.includes("resolveReviewThread")));
  assert.match(replied.out, /^replied: PRRT_open_1 -> https:\/\/github\.com\/example\/repo\/pull\/418#discussion_r999001$/m);
  assert.match(replied.out, /^resolved: PRRT_open_1$/m);

  // If --resolve returns isResolved: false, exit 7.
  const unconfirmed = runThreads([{ ...pollState, resolveConfirmed: false }], {
    args: ["--repo", "acme/app", "--resolve", "PRRT_open_1"],
  });
  assert.equal(unconfirmed.code, 7);
  assert.match(unconfirmed.err, /did not confirm resolution/);

  // Usage validation exits 64 without calling GitHub.
  assert.equal(runThreads([], { args: ["--repo", "acme/app", "--reply", "PRRT_open_1"] }).code, 64);
  assert.equal(runThreads([], { args: ["--repo", "acme/app", "--body-file", "$BODY_FILE"], bodyFileContent: "hi" }).code, 64);
  assert.equal(runThreads([], { args: ["--repo", "acme/app", "--reply", "PRRT_open_1", "--body-file", "$BODY_FILE"], bodyFileContent: "   \n" }).code, 64);
  assert.equal(runThreads([], { args: ["--repo", "acme/app", "--list"] }).code, 64);
});

test("unaddressed PR conversation comments (Grok Bot flags and human reviewers) block watch-pr until replied to", () => {
  const baseState = {
    pullRequest: open({ author: { login: "fitchmultz" } }),
    checkRuns: [...ciJobs("success"), ...reviewersPassed()],
    runs: [ciRun("pull_request")],
    workflows: { "ci.yml": PI_WORKFLOWS["ci.yml"] },
  };

  // 1. Grok Bot review flag posted under the PR author's own login blocks READY with exit 3.
  const grokComment = {
    id: "IC_grok_1",
    fullDatabaseId: "7055945936",
    author: { login: "fitchmultz" },
    body: `Review flag on head ${HEAD.slice(0, 8)} (branch feat/agy): use mise instead.\n\n— Attributed to Grok Bot (PR Review)\n`,
    url: "https://github.com/fitchmultz/pi/pull/418#issuecomment-7055945936",
    createdAt: "2026-11-21T02:29:47Z",
    updatedAt: "2026-11-21T02:29:47Z",
    isMinimized: false,
  };
  const blockedGrok = watch([{ ...baseState, issueComments: [grokComment] }]);
  assert.equal(blockedGrok.code, 3, blockedGrok.out);
  assert.equal(blockedGrok.lines[0], "BLOCKED: 1 unaddressed PR comment");
  assert.match(blockedGrok.out, /unaddressed PR comments: 1/);
  assert.match(blockedGrok.out, new RegExp(`PR comment @fitchmultz \\(Grok Bot \\(PR Review\\)\\) \\[${HEAD.slice(0, 7)} head\\]: Review flag on head`));

  // pr-threads.mjs --list surfaces the unaddressed PR comment in text and JSON.
  const listed = runThreads([{ ...baseState, issueComments: [grokComment] }], {
    args: ["418", "--repo", "fitchmultz/pi", "--list"],
  });
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /unaddressed PR comments: 1/);
  assert.match(listed.out, /IC_grok_1\s+PR comment\s+@fitchmultz \(Grok Bot \(PR Review\)\)/);
  assert.match(listed.out, /url: https:\/\/github\.com\/fitchmultz\/pi\/pull\/418#issuecomment-7055945936/);

  const listedJson = runThreads([{ ...baseState, issueComments: [grokComment] }], {
    args: ["418", "--repo", "fitchmultz/pi", "--list", "--json"],
  });
  assert.equal(listedJson.code, 0, listedJson.err);
  const jsonPayload = JSON.parse(listedJson.out);
  assert.equal(jsonPayload.unaddressedCommentCount, 1);
  assert.equal(jsonPayload.comments[0].attribution, "Grok Bot (PR Review)");

  // 2. An unrelated author reply (even quoting the flag) does NOT clear an attributed review flag
  //    or become a second flag itself; minimizing the flag (`pr-threads.mjs --resolve IC_...`) clears it.
  const quotedReply = {
    id: "IC_reply_1",
    fullDatabaseId: "7055946000",
    author: { __typename: "User", login: "fitchmultz" },
    body: `> Review flag on head ${HEAD.slice(0, 8)} (branch feat/agy): use mise instead.\n> — Attributed to Grok Bot (PR Review)\n\nAddressed the Grok Bot review flag: switched to mise \`antigravity-cli = "latest"\`.`,
    url: "https://github.com/fitchmultz/pi/pull/418#issuecomment-7055946000",
    createdAt: "2026-11-21T02:32:00Z",
    updatedAt: "2026-11-21T02:32:00Z",
    isMinimized: false,
  };
  const stillBlockedByFlag = watch([{ ...baseState, issueComments: [grokComment, quotedReply] }]);
  assert.equal(stillBlockedByFlag.code, 3, stillBlockedByFlag.out);
  assert.equal(stillBlockedByFlag.lines[0], "BLOCKED: 1 unaddressed PR comment");

  const resolvedFlag = runThreads([baseState], {
    args: ["--repo", "fitchmultz/pi", "--resolve", "IC_grok_1"],
  });
  assert.equal(resolvedFlag.code, 0, resolvedFlag.err);
  assert.match(resolvedFlag.out, /^resolved: IC_grok_1$/m);
  assert.ok(resolvedFlag.calls[0].argv.some((arg) => arg.includes("minimizeComment")));

  const cleared = watch([{ ...baseState, issueComments: [{ ...grokComment, isMinimized: true }, quotedReply] }]);
  assert.equal(cleared.code, 0, cleared.out);
  assert.equal(cleared.lines[0], "READY");

  // 3. A human reviewer comment (different author) blocks until PR author replies (or minimizes it);
  //    minimized comments and GraphQL Bot deploy comments (without `[bot]` suffix) do not block.
  const humanComment = {
    id: "IC_human_1",
    fullDatabaseId: "7055946100",
    author: { __typename: "User", login: "teammate" },
    body: "Please also update the README before merging.",
    url: "https://github.com/fitchmultz/pi/pull/418#issuecomment-7055946100",
    createdAt: "2026-11-21T02:33:00Z",
    updatedAt: "2026-11-21T02:33:00Z",
    isMinimized: false,
  };
  const blockedHuman = watch([{ ...baseState, issueComments: [{ ...grokComment, isMinimized: true }, humanComment] }]);
  assert.equal(blockedHuman.code, 3, blockedHuman.out);
  assert.equal(blockedHuman.lines[0], "BLOCKED: 1 unaddressed PR comment");
  assert.match(blockedHuman.out, /PR comment @teammate: Please also update the README/);

  const clearedHuman = watch([{
    ...baseState,
    issueComments: [humanComment, { ...quotedReply, createdAt: "2026-11-21T02:34:00Z" }],
  }]);
  assert.equal(clearedHuman.code, 0, clearedHuman.out);
  assert.equal(clearedHuman.lines[0], "READY");

  const deployBot = {
    id: "IC_deploy_1",
    fullDatabaseId: "7055946200",
    author: { __typename: "Bot", login: "cloudflare-workers-and-pages" },
    body: "Preview deployed to https://preview.example.com",
    url: "https://github.com/fitchmultz/pi/pull/418#issuecomment-7055946200",
    createdAt: "2026-11-21T02:34:00Z",
    updatedAt: "2026-11-21T02:34:00Z",
    isMinimized: false,
  };
  const ignored = watch([{ ...baseState, issueComments: [{ ...grokComment, isMinimized: true }, deployBot] }]);
  assert.equal(ignored.code, 0, ignored.out);
  assert.equal(ignored.lines[0], "READY");

  // 4. Configured text reviewer verdicts in GraphQL (no `[bot]` suffix) are handled by reviewerStates,
  //    not flagged as unaddressed comments.
  const greptileState = {
    pullRequest: open({ author: { __typename: "User", login: "fitchmultz" }, reviewDecision: "REVIEW_REQUIRED" }),
    checkRuns: [check("Review bot", "success")],
    comments: [{
      user: { login: "greptile-apps[bot]" },
      updated_at: "2026-11-10T16:30:56Z",
      body: `Confidence Score: 5/5 (https://github.com/acme/app/commit/${HEAD})`,
    }],
    issueComments: [{
      id: "IC_greptile_1",
      fullDatabaseId: "7055946300",
      author: { __typename: "Bot", login: "greptile-apps" },
      body: `Confidence Score: 5/5 (https://github.com/acme/app/commit/${HEAD})`,
      url: "https://github.com/acme/app/pull/418#issuecomment-7055946300",
      createdAt: "2026-11-10T16:30:56Z",
      updatedAt: "2026-11-10T16:30:56Z",
      isMinimized: false,
    }],
    rules: [],
  };
  const greptileReady = watch([greptileState], { repo: "acme/app" });
  assert.equal(greptileReady.code, 0, greptileReady.out);
  assert.equal(greptileReady.lines[0], "READY");

  // 5. When a PR has >100 conversation comments (`hasPreviousPage: true`), watch-pr paginates all comments
  //    so an older unaddressed comment is still caught.
  const paginated = watch([{
    ...baseState,
    issueCommentsHasPreviousPage: true,
    issueComments: [deployBot],
    allIssueComments: [grokComment, deployBot],
  }]);
  assert.equal(paginated.code, 3, paginated.out);
  assert.equal(paginated.lines[0], "BLOCKED: 1 unaddressed PR comment");
  assert.match(paginated.out, /Grok Bot \(PR Review\)/);
});
