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
const fixture = readFileSync(new URL("./fixtures/watch-pr-verdict-gh.mjs", import.meta.url), "utf8");

const HEAD = "abe04d463cbda8f7f34b2237de00fcea57cb4c45";
const OLD = "11a9aa048330dd5d4ea528e1884db45fcc7054b1";
const DURABLE = "Pi Durable Review";
const CURSOR = "Cursor Automation: PR Bug Review - Maintained Repos";
const CONFIG = {
  "*": { gh: "gh-personal" },
  fitchmultz: { reviewers: [{ name: DURABLE, check: DURABLE }, { name: "Cursor automation", check: CURSOR }] },
  workos: {
    gh: "gh-work",
    reviewers: [{
      name: "Greptile", author: "greptile-apps[bot]", verdict: "Confidence Score: (\\d+/\\d+)",
      pass: "5/5", commit: "/commit/([0-9a-f]{40})",
    }],
  },
  "workos/alto": { mergeWithoutApproval: true, reviewers: [{ name: "TARS review", check: "TARS review" }] },
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
const check = (name, conclusion, suite = nextId) => ({
  id: nextId++, name, status: conclusion === null ? "in_progress" : "completed", conclusion,
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

// workos/alto#1857 on 2026-11-10: 15 checks passed, but none of the nine
// required Depot CI checks had been reported 75 minutes after the push.
test("required status checks that were never reported keep the pull request from READY", () => {
  const rules = [
    { type: "pull_request", parameters: {} },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "Depot CI / verify" }, { context: "Depot CI / checks" }] } },
  ];
  const state = {
    pullRequest: open({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }), rules,
    checkRuns: [check("TARS review", "success")], statuses: [{ context: "alto-verify", state: "success", target_url: "" }],
    comments: [{ user: { login: "greptile-apps[bot]" }, updated_at: "2026-11-10T16:30:56Z", body: `Confidence Score: 5/5 (https://github.com/workos/alto/commit/${HEAD})` }],
  };
  const missing = watch([state], { repo: "workos/alto" });
  assert.equal(missing.code, 5);
  assert.equal(missing.lines[0],
    "BLOCKED: not ready; waiting for: 2 required checks not reported (Depot CI / verify, Depot CI / checks)");

  const reported = watch([{ ...state, checkRuns: [...state.checkRuns, check("Depot CI / verify", "success"), check("Depot CI / checks", "success")] }], { repo: "workos/alto" });
  assert.equal(reported.code, 0);
  assert.deepEqual(reported.lines.slice(3), [
    "checks on abe04d4: 4 passed, 0 failed, 0 pending, 0 skipped",
    "expected checks: all present (2 required checks)",
    "reviewers:",
    "  Greptile: 5/5 on abe04d4",
    "  TARS review: passed on abe04d4",
    "unresolved review threads: 0",
    "merge: MERGEABLE; GitHub merge state BLOCKED; review decision REVIEW_REQUIRED (configuration allows a merge without approval)",
  ]);

  // Without that setting, the review that GitHub requires blocks.
  const comments = [{ ...state.comments[0], body: state.comments[0].body.replace("workos/alto", "workos/authkit") }];
  const unapproved = watch([{ ...state, rules: [], comments }], { repo: "workos/authkit" });
  assert.equal(unapproved.code, 6);
  assert.equal(unapproved.lines[0], "BLOCKED: GitHub requires an approving review");
  assert.equal(unapproved.lines.at(-1), "merge: MERGEABLE; GitHub merge state BLOCKED; review decision REVIEW_REQUIRED");
});

test("the GitHub CLI comes from the owner's configuration, and WATCH_PR_GH overrides it", () => {
  const state = { pullRequest: open(), checkRuns: reviewersPassed() };
  assert.deepEqual(watch([state]).gh, ["gh-personal"]);
  assert.deepEqual(watch([state], { repo: "workos/alto" }).gh, ["gh-work"]);
  assert.deepEqual(watch([state], { repo: "workos/alto", env: { WATCH_PR_GH: "gh-other" } }).gh, ["gh-other"]);
  assert.deepEqual(watch([state], { config: null }).gh, ["gh"]);
  const reads = watch([state]).calls;
  assert.ok(reads.length > 0 && reads.every(({ argv }) => argv[0] === "api" && !argv.some((arg) => /^(-X|--method|--input)$/.test(arg))),
    "every GitHub call is a read");
});

test("a reviewer signs off only on the head commit", () => {
  const greptile = (score, sha) => ({
    user: { login: "greptile-apps[bot]" }, updated_at: "2026-11-10T16:30:56Z",
    body: `<h2>Confidence Score: ${score}</h2>\n<sub>Last reviewed commit: ["fix"](https://github.com/workos/alto/commit/${sha})</sub>`,
  });
  const run = (state) => watch([{ pullRequest: open(), ...state }], { repo: "workos/alto" });
  const tars = [check("TARS review", "success")];

  const stale = run({ checkRuns: tars, comments: [greptile("5/5", OLD)] });
  assert.equal(stale.code, 5);
  assert.equal(stale.lines[0], "BLOCKED: not ready; waiting for: Greptile: 5/5 on 11a9aa0, not on this commit");

  const low = run({ checkRuns: tars, comments: [greptile("3/5", HEAD)] });
  assert.equal(low.code, 8);
  assert.equal(low.lines[0], "BLOCKED: Greptile did not sign off: 3/5 on abe04d4 (needs 5/5)");

  const notStarted = run({ checkRuns: [check("build", "success")], comments: [greptile("5/5", HEAD)] });
  assert.equal(notStarted.code, 5);
  assert.equal(notStarted.lines[0], "BLOCKED: not ready; waiting for: TARS review: not started on abe04d4");

  // A rule that cannot be evaluated is not a sign-off.
  const noCommit = run({ checkRuns: tars, comments: [{ ...greptile("5/5", HEAD), body: "Confidence Score: 5/5" }] });
  assert.equal(noCommit.code, 9);
  assert.equal(noCommit.lines[0], "UNKNOWN: Greptile: 5/5, but its text does not name a commit");

  // The score can also be the body of a review, which GitHub ties to a commit.
  const review = run({ checkRuns: tars, reviews: [{ user: { login: "greptile-apps[bot]" }, submitted_at: "2026-11-10T16:30:56Z", commit_id: HEAD, body: "Confidence Score: 5/5" }] });
  assert.equal(review.code, 0);
  assert.ok(review.lines.includes("  Greptile: 5/5 on abe04d4"));

  const misspelled = watch([{ pullRequest: open() }], { config: { workos: { reviewer: [] } }, repo: "workos/alto" });
  assert.equal(misspelled.code, 64);
  assert.match(misspelled.err, /"workos" has the unknown key "reviewer"/);
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

// workos/rag-slack-bot#565: one cancelled and one successful run of verify.yml on the same commit.
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

  // workos/alto#1854: a later run of the same workflow and event held a different job. Both jobs count.
  const relabeled = watch([{
    pullRequest: open(), runs: [{ ...runs[0], conclusion: "failure" }, runs[1]],
    checkRuns: [...reviewersPassed(), check("TARS verification task", "failure", 116058344570), check("TARS verification unchanged", "success", 116058673261)],
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
  ]) assert.equal(classifyWorkflow(text, "main").kind, kind, text);

  const unreadable = watch([{ pullRequest: open(), checkRuns: reviewersPassed(), workflows: { "ci.yml": "on:\n  pull_request: &filters\n    branches: [main]\n" } }]);
  assert.equal(unreadable.code, 9);
  assert.equal(unreadable.lines[0], "UNKNOWN: cannot read the triggers of ci.yml");
});
