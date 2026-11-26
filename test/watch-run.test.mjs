// End-to-end tests for skills/watch-pr/scripts/watch-run.mjs against an offline
// GitHub CLI fixture on PATH, exercising real CLI argument parsing, watch-pr.json
// routing, env sanitization, polling, --until-job, --stop-at-waiting, rate-limit
// backoff, error exits, and bounded verdict rendering.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../skills/watch-pr/scripts/watch-run.mjs", import.meta.url));
const fastClock = new URL("./fixtures/fast-clock.mjs", import.meta.url).href;
const fixture = readFileSync(new URL("./fixtures/watch-run-gh.mjs", import.meta.url), "utf8");

const HEAD = "abe04d463cbda8f7f34b2237de00fcea57cb4c45";
const RUN_ID = "42858443183";
const RUN_URL = `https://github.com/workos/tars/actions/runs/${RUN_ID}`;

const CONFIG = {
  "*": { gh: "gh-personal" },
  workos: { gh: "gh-work" },
};

let nextJobId = 1000;
function makeJob(name, status, conclusion = null, repo = "workos/tars") {
  const id = nextJobId++;
  return {
    id,
    run_id: Number(RUN_ID),
    name,
    status,
    conclusion,
    html_url: `https://github.com/${repo}/actions/runs/${RUN_ID}/job/${id}`,
  };
}

function makeRun(overrides = {}) {
  const repo = overrides.repo ?? "workos/tars";
  const id = overrides.id ?? Number(RUN_ID);
  return {
    id,
    name: "Build & Deploy",
    path: ".github/workflows/deploy.yml",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD,
    html_url: `https://github.com/${repo}/actions/runs/${id}`,
    ...overrides,
  };
}

function watchRun(polls, {
  args = [RUN_URL, "--once"],
  config = CONFIG,
  env = {},
  fail,
  cwd,
  fastClock: useFastClock = true,
} = {}) {
  const temp = mkdtempSync(join(tmpdir(), "watch-run-test-"));
  try {
    for (const name of ["gh", "gh-personal", "gh-work", "gh-custom"]) {
      writeFileSync(join(temp, name), `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
    }
    const scenario = join(temp, "scenario.json");
    const log = join(temp, "calls.ndjson");
    const sleepLog = join(temp, "sleeps.txt");
    const configFile = join(temp, "watch-pr.json");
    writeFileSync(scenario, JSON.stringify({ polls, fail }));
    writeFileSync(log, "");
    writeFileSync(sleepLog, "");
    if (config !== null) {
      writeFileSync(configFile, typeof config === "string" ? config : JSON.stringify(config));
    }
    const nodeArgs = useFastClock ? ["--import", fastClock, script, ...args] : [script, ...args];
    const result = spawnSync(process.execPath, nodeArgs, {
      cwd,
      encoding: "utf8",
      env: {
        PATH: `${temp}:${process.env.PATH}`,
        WATCH_PR_CONFIG: configFile,
        WATCH_RUN_ID: RUN_ID,
        WATCH_RUN_SCENARIO: scenario,
        WATCH_RUN_FIXTURE_LOG: log,
        ...(useFastClock ? { WATCH_PR_SLEEP_LOG: sleepLog } : {}),
        ...env,
      },
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const sleeps = readFileSync(sleepLog, "utf8").trim().split("\n").filter(Boolean).map(Number);
    const lines = result.stdout ? result.stdout.trimEnd().split("\n") : [];
    return {
      code: result.status,
      out: result.stdout,
      err: result.stderr,
      lines,
      verdict: lines.filter((line) => !/^\d{4}-\d\d-\d\dT/.test(line)),
      gh: [...new Set(calls.map((call) => basename(call.program)))],
      calls,
      sleeps,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test("parses run URLs, --repo + ID, and git origin remote, routing gh-work/gh-personal and stripping tokens", () => {
  const okPoll = {
    run: makeRun(),
    jobs: [makeJob("Build", "completed", "success")],
  };

  // Run URL (including /job/<id> suffix) routes workos/tars through gh-work and strips ambient tokens.
  const viaUrl = watchRun([okPoll], {
    args: [`${RUN_URL}/job/9999`, "--once"],
    env: { GH_TOKEN: "ambient-1", GITHUB_TOKEN: "ambient-2" },
  });
  assert.equal(viaUrl.code, 0, viaUrl.err + viaUrl.out);
  assert.deepEqual(viaUrl.gh, ["gh-work"]);
  assert.ok(viaUrl.calls.every((call) => !call.env.hasGhToken && !call.env.hasGithubToken));
  assert.equal(viaUrl.calls[0].argv[1], `repos/workos/tars/actions/runs/${RUN_ID}`);
  assert.equal(viaUrl.calls[1].argv[1], `repos/workos/tars/actions/runs/${RUN_ID}/jobs?per_page=100`);

  // Numeric ID + --repo routes fitchmultz/pi through gh-personal via "*" scope.
  const viaRepo = watchRun([{
    run: makeRun({ repo: "fitchmultz/pi" }),
    jobs: [makeJob("Test", "completed", "success", "fitchmultz/pi")],
  }], {
    args: [RUN_ID, "--repo", "fitchmultz/pi", "--once"],
  });
  assert.equal(viaRepo.code, 0, viaRepo.err + viaRepo.out);
  assert.deepEqual(viaRepo.gh, ["gh-personal"]);
  assert.equal(viaRepo.calls[0].argv[1], `repos/fitchmultz/pi/actions/runs/${RUN_ID}`);

  // WATCH_PR_GH overrides watch-pr.json.
  const viaEnv = watchRun([okPoll], {
    args: [RUN_URL, "--once"],
    env: { WATCH_PR_GH: "gh-custom" },
  });
  assert.equal(viaEnv.code, 0, viaEnv.err + viaEnv.out);
  assert.deepEqual(viaEnv.gh, ["gh-custom"]);

  // Numeric ID without --repo infers owner/repo from the git origin remote.
  const repoDir = mkdtempSync(join(tmpdir(), "watch-run-origin-"));
  try {
    execFileSync("git", ["init", "--quiet", repoDir]);
    execFileSync("git", ["-C", repoDir, "remote", "add", "origin", "git@github.com:workos/tars.git"]);
    const viaOrigin = watchRun([okPoll], {
      args: [RUN_ID, "--once"],
      cwd: repoDir,
    });
    assert.equal(viaOrigin.code, 0, viaOrigin.err + viaOrigin.out);
    assert.deepEqual(viaOrigin.gh, ["gh-work"]);
    assert.equal(viaOrigin.calls[0].argv[1], `repos/workos/tars/actions/runs/${RUN_ID}`);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }

  // Usage and configuration errors exit 64.
  const badUrl = watchRun([], { args: ["https://github.com/workos/tars/pull/123"] });
  assert.equal(badUrl.code, 64);
  assert.match(badUrl.err, /not a workflow run ID or URL/);

  const badInterval = watchRun([], { args: [RUN_URL, "--interval", "0"] });
  assert.equal(badInterval.code, 64);
  assert.match(badInterval.err, /--interval must be a number greater than 0/);

  const badConfig = watchRun([], { args: [RUN_URL, "--once"], config: { workos: { unknownKey: true } } });
  assert.equal(badConfig.code, 64);
  assert.match(badConfig.err, /unknown key "unknownKey"/);
});

test("handles normal run completion, paginated jobs, failure, cancellation, fail-fast, and skipped runs", () => {
  // Multi-poll run transitioning queued -> in_progress -> completed/success with paginated jobs.
  const watched = watchRun([
    {
      run: makeRun({ status: "queued", conclusion: null }),
      jobs: [],
    },
    {
      run: makeRun({ status: "in_progress", conclusion: null }),
      jobs: [
        makeJob("Lint", "completed", "success"),
        makeJob("Test", "in_progress", null),
      ],
    },
    {
      run: makeRun({ status: "completed", conclusion: "success" }),
      jobPages: [
        { total_count: 3, jobs: [makeJob("Lint", "completed", "success"), makeJob("Test", "completed", "success")] },
        { total_count: 3, jobs: [makeJob("Optional", "completed", "skipped")] },
      ],
    },
  ], { args: [RUN_URL, "--interval", "0.02"] });

  assert.equal(watched.code, 0, watched.out + watched.err);
  assert.deepEqual(watched.verdict, [
    "PASSED",
    `run: ${RUN_URL}`,
    "workflow: Build & Deploy (completed/success)",
    `commit: ${HEAD}`,
    "jobs: 2 passed, 0 failed, 0 waiting, 0 active, 0 pending, 1 skipped",
  ]);
  assert.ok(watched.lines.some((line) => line.includes(`waiting on ${HEAD.slice(0, 7)}: workflow run is queued`)));
  assert.ok(watched.lines.some((line) => line.includes("1 job active (Test)")));

  // Completed failure exits 4 and includes failed job name and URL.
  const failedJob = makeJob("Test Suite", "completed", "failure");
  const failed = watchRun([{
    run: makeRun({ status: "completed", conclusion: "failure" }),
    jobs: [makeJob("Lint", "completed", "success"), failedJob],
  }]);
  assert.equal(failed.code, 4, failed.out);
  assert.equal(failed.verdict[0], "FAILED: workflow run completed as failure");
  assert.ok(failed.verdict.includes("jobs: 1 passed, 1 failed, 0 waiting, 0 active, 0 pending, 0 skipped"));
  assert.ok(failed.verdict.includes(`  failed: Test Suite (failure) ${failedJob.html_url}`));

  // Completed cancelled run exits 4 with CANCELLED headline.
  const cancelledJob = makeJob("Deploy", "completed", "cancelled");
  const cancelled = watchRun([{
    run: makeRun({ status: "completed", conclusion: "cancelled" }),
    jobs: [cancelledJob],
  }]);
  assert.equal(cancelled.code, 4, cancelled.out);
  assert.equal(cancelled.verdict[0], "CANCELLED: workflow run was cancelled");
  assert.ok(cancelled.verdict.includes(`  failed: Deploy (cancelled) ${cancelledJob.html_url}`));

  // In-progress run with a failed job fails fast on the first poll without waiting for slower jobs.
  const earlyFail = makeJob("Unit Tests", "completed", "failure");
  const failFast = watchRun([
    {
      run: makeRun({ status: "in_progress", conclusion: null }),
      jobs: [earlyFail, makeJob("Slow E2E", "in_progress", null)],
    },
    {
      run: makeRun({ status: "completed", conclusion: "failure" }),
      jobs: [earlyFail, makeJob("Slow E2E", "completed", "success")],
    },
  ], { args: [RUN_URL, "--interval", "0.02"] });
  assert.equal(failFast.code, 4, failFast.out);
  assert.equal(failFast.verdict[0], "FAILED: 1 job failed");
  assert.equal(failFast.calls.filter(({ argv }) => /\/actions\/runs\/\d+$/.test(argv[1])).length, 1);

  // Completed skipped run fails closed with UNKNOWN (exit 7).
  const skippedRun = watchRun([{
    run: makeRun({ status: "completed", conclusion: "skipped" }),
    jobs: [makeJob("Build", "completed", "skipped")],
  }]);
  assert.equal(skippedRun.code, 7, skippedRun.out);
  assert.equal(skippedRun.verdict[0], "UNKNOWN: workflow run completed as skipped");
});

test("--until-job settles when target jobs succeed while downstream deploy waits, and fails if a target fails/skips/missing", () => {
  const prodWaiting = makeJob("Deploy to Production", "waiting", null);

  // Settles cleanly once both repeatable target jobs (bare name + "Workflow / Job") succeed.
  const settled = watchRun([
    {
      run: makeRun({ status: "in_progress", conclusion: null }),
      jobs: [
        makeJob("Build", "completed", "success"),
        makeJob("Deploy Staging", "in_progress", null),
      ],
    },
    {
      run: makeRun({ status: "waiting", conclusion: null }),
      jobs: [
        makeJob("Build", "completed", "success"),
        makeJob("Deploy Staging", "completed", "success"),
        prodWaiting,
      ],
    },
  ], {
    args: [RUN_URL, "--interval", "0.02", "--until-job", "Build", "--until-job", "Build & Deploy / Deploy Staging"],
  });
  assert.equal(settled.code, 0, settled.out + settled.err);
  assert.equal(settled.verdict[0], "SETTLED: 2 target jobs passed (Build, Build & Deploy / Deploy Staging)");
  assert.ok(settled.verdict.includes("jobs: 2 passed, 0 failed, 1 waiting, 0 active, 0 pending, 0 skipped"));
  assert.ok(settled.verdict.includes(`  waiting: Deploy to Production ${prodWaiting.html_url}`));
  assert.ok(!settled.calls.some(({ argv }) => argv[1].includes("pending_deployments")));

  // Target job failure exits 4 immediately even while other jobs are still running.
  const failedStaging = makeJob("Deploy Staging", "completed", "timed_out");
  const targetFailed = watchRun([{
    run: makeRun({ status: "in_progress", conclusion: null }),
    jobs: [
      makeJob("Build", "completed", "success"),
      failedStaging,
      makeJob("Other Job", "in_progress", null),
    ],
  }], { args: [RUN_URL, "--interval", "0.02", "--until-job", "Deploy Staging"] });
  assert.equal(targetFailed.code, 4, targetFailed.out);
  assert.equal(targetFailed.verdict[0], "FAILED: 1 target job failed (Deploy Staging)");
  assert.ok(targetFailed.verdict.includes(`  failed: Deploy Staging (timed_out) ${failedStaging.html_url}`));

  // Target job cancelled exits 4 with CANCELLED.
  const cancelledStaging = makeJob("Deploy Staging", "completed", "cancelled");
  const targetCancelled = watchRun([{
    run: makeRun({ status: "in_progress", conclusion: null }),
    jobs: [cancelledStaging],
  }], { args: [RUN_URL, "--interval", "0.02", "--until-job", "Deploy Staging"] });
  assert.equal(targetCancelled.code, 4, targetCancelled.out);
  assert.equal(targetCancelled.verdict[0], "CANCELLED: 1 target job cancelled (Deploy Staging)");

  // Target job skipped (e.g. upstream build failed) fails closed immediately with exit 4.
  const buildFailed = makeJob("Build", "completed", "failure");
  const targetSkipped = watchRun([{
    run: makeRun({ status: "completed", conclusion: "failure" }),
    jobs: [buildFailed, makeJob("Deploy Staging", "completed", "skipped")],
  }], { args: [RUN_URL, "--until-job", "Deploy Staging"] });
  assert.equal(targetSkipped.code, 4, targetSkipped.out);
  assert.equal(targetSkipped.verdict[0], "FAILED: 1 target job skipped (Deploy Staging)");
  assert.ok(targetSkipped.verdict.includes(`  failed: Build (failure) ${buildFailed.html_url}`));

  // Missing target job on a completed success run returns UNKNOWN (exit 7).
  const missingTarget = watchRun([{
    run: makeRun({ status: "completed", conclusion: "success" }),
    jobs: [makeJob("Build", "completed", "success")],
  }], { args: [RUN_URL, "--until-job", "Nonexistent Job"] });
  assert.equal(missingTarget.code, 7, missingTarget.out);
  assert.equal(missingTarget.verdict[0], "UNKNOWN: 1 target job not found in completed run (Nonexistent Job)");
});

const DEPLOYMENTS = `runs/${RUN_ID}/pending_deployments`;
const PRODUCTION_GATE = {
  environment: { name: "production" },
  reviewers: [{ type: "Team", reviewer: { slug: "release-reviewers" } }],
  wait_timer: 0,
  wait_timer_started_at: null,
  current_user_can_approve: false,
};

function waitingPoll(deployment = PRODUCTION_GATE) {
  return {
    run: makeRun({ status: "waiting", conclusion: null }),
    jobs: [makeJob("Build", "completed", "success"), makeJob("Deploy to Production", "waiting")],
    diagnostics: { [DEPLOYMENTS]: [deployment] },
  };
}

function finishedPoll() {
  return {
    run: makeRun(),
    jobs: [makeJob("Build", "completed", "success"), makeJob("Deploy to Production", "completed", "success")],
  };
}

test("reports the run's manual deployment approval before sleeping, including for a waiting target", () => {
  const alongsideActive = waitingPoll();
  alongsideActive.run.status = "in_progress";
  alongsideActive.jobs.push(makeJob("Other Job", "in_progress"));
  for (const [waiting, flags] of [
    [waitingPoll({ ...PRODUCTION_GATE, reviewers: [] }), []],
    [waitingPoll({ ...PRODUCTION_GATE, wait_timer: 30, wait_timer_started_at: new Date().toISOString() }),
      ["--until-job", "Deploy to Production"]],
    [alongsideActive, ["--until-job", "Deploy to Production", "--stop-at-waiting"]],
  ]) {
    const blocked = watchRun([waiting, finishedPoll()], { args: [RUN_URL, ...flags] });
    assert.equal(blocked.code, 6, blocked.out + blocked.err);
    assert.deepEqual(blocked.sleeps, []);
    assert.equal(blocked.verdict[0], "BLOCKED: deployment approval required");
    assert.ok(blocked.verdict.includes("  environment: production (current_user_can_approve: false)"));
    assert.ok(blocked.verdict.includes(`  waiting: Deploy to Production ${waiting.jobs[1].html_url}`));
  }
});

test("keeps polling across a timer-only gate or an explicitly opted-in manual gate", () => {
  const timer = waitingPoll({
    ...PRODUCTION_GATE, reviewers: [], wait_timer: 30, wait_timer_started_at: new Date().toISOString(),
  });
  for (const [waiting, flags] of [[timer, []], [timer, ["--stop-at-waiting"]], [waitingPoll(), ["--wait-for-approval"]]]) {
    const result = watchRun([waiting, finishedPoll()], { args: [RUN_URL, ...flags] });
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(result.verdict[0], "PASSED");
    assert.equal(result.sleeps.length, 1);
  }
});

function concurrencyPoll(holderJobStatus, { workflowLevel = false } = {}) {
  const holder = makeRun({ id: Number(RUN_ID) - 1, status: holderJobStatus, conclusion: null, head_sha: "c".repeat(40) });
  const holderJob = { ...makeJob("Deploy to Production", holderJobStatus), run_id: holder.id };
  const pending = makeJob("Deploy to Production", "pending");
  const member = { status: "pending", run_id: Number(RUN_ID), job_id: workflowLevel ? null : pending.id };
  const group = "release/production";
  const filter = workflowLevel ? `ahead_of_run=${RUN_ID}` : `ahead_of_job=${pending.id}`;
  return {
    run: makeRun({ status: "pending", conclusion: null }),
    jobs: workflowLevel ? [] : [makeJob("Build", "completed", "success"), pending],
    diagnostics: {
      [DEPLOYMENTS]: [],
      [`runs/${RUN_ID}/concurrency_groups?per_page=100`]: {
        concurrency_groups: [{ group_name: group, group_members: [{ ...member, position: 1 }] }],
      },
      [`concurrency_groups/release%2Fproduction?${filter}`]: {
        group_members: [{ status: "in_progress", run_id: holder.id, job_id: workflowLevel ? null : holderJob.id }, member],
      },
      [`jobs/${holderJob.id}`]: holderJob,
      [`runs/${holder.id}`]: holder,
      [`runs/${holder.id}/pending_deployments`]: [{ ...PRODUCTION_GATE, current_user_can_approve: true }],
    },
    holder,
  };
}

test("reports the exact concurrency holder awaiting approval in default, settle, and target modes", () => {
  for (const [pending, flags] of [
    [concurrencyPoll("waiting"), []],
    [concurrencyPoll("waiting"), ["--stop-at-waiting"]],
    [concurrencyPoll("waiting"), ["--until-job", "Deploy to Production"]],
    [concurrencyPoll("waiting", { workflowLevel: true }), ["--until-job", "Deploy to Production"]],
  ]) {
    const blocked = watchRun([pending, finishedPoll()], { args: [RUN_URL, ...flags] });
    assert.equal(blocked.code, 6, blocked.out + blocked.err);
    assert.deepEqual(blocked.sleeps, []);
    assert.equal(blocked.verdict[0], "BLOCKED: concurrency is held by a run awaiting deployment approval");
    assert.ok(blocked.verdict.includes(`  blocking run: ${pending.holder.html_url} (commit ${pending.holder.head_sha}); environment: production (current_user_can_approve: true)`));
    assert.ok(blocked.verdict.length <= 20);
    assert.ok(Buffer.byteLength(blocked.out) <= 2048);
  }
});

test("keeps polling while the exact concurrency holder's job runs, even if its run has a separate approval", () => {
  const pending = concurrencyPoll("in_progress");
  const active = {
    run: makeRun({ status: "in_progress", conclusion: null }),
    jobs: [makeJob("Deploy to Production", "in_progress"), makeJob("Another deploy", "pending")],
  };
  const result = watchRun([pending, active, finishedPoll()], { args: [RUN_URL] });
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(result.verdict[0], "PASSED");
  assert.equal(result.sleeps.length, 2);
  assert.equal(result.calls.filter(({ argv }) => argv[1].endsWith(DEPLOYMENTS)).length, 1);
});

test("keeps polling when concurrency groups or holder job details cannot be read", () => {
  for (const endpoint of [`runs/${RUN_ID}/concurrency_groups`, "/actions/jobs/"]) {
    for (const status of [403, 404]) {
      const pending = concurrencyPoll("waiting");
      pending.fail = { endpoint, status, body: { message: "Resource not available" } };
      const result = watchRun([pending, finishedPoll()], { args: [RUN_URL] });
      assert.equal(result.code, 0, result.out + result.err);
      assert.equal(result.verdict[0], "PASSED");
      assert.equal(result.sleeps.length, 1);
      assert.ok(result.calls.some(({ argv }) => argv[1].includes(endpoint)));
    }
  }
});

test("uses waiting job status when the pending deployments endpoint denies access", () => {
  const waiting = waitingPoll();
  waiting.run.status = "in_progress";
  waiting.fail = {
    endpoint: DEPLOYMENTS,
    status: 403,
    body: { message: "Resource not accessible by integration" },
    stderr: "gh: Resource not accessible by integration (HTTP 403)",
  };
  const result = watchRun([waiting, finishedPoll()], { args: [RUN_URL] });
  assert.equal(result.code, 6, result.out + result.err);
  assert.deepEqual(result.sleeps, []);
  assert.equal(result.verdict[0], "BLOCKED: waiting at deployment gate (approval details unavailable)");
  assert.ok(result.verdict.includes(`  waiting: Deploy to Production ${waiting.jobs[1].html_url}`));
});

test("keeps polling when waiting status lags after GitHub clears the pending deployment", () => {
  const waiting = waitingPoll();
  waiting.diagnostics[DEPLOYMENTS] = [];
  for (const flags of [[], ["--stop-at-waiting"]]) {
    const result = watchRun([waiting, finishedPoll()], { args: [RUN_URL, ...flags] });
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(result.verdict[0], "PASSED");
    assert.equal(result.sleeps.length, 1);
  }
});

test("checks the pending target's concurrency queue and ignores unrelated queues", () => {
  const pending = concurrencyPoll("waiting");
  pending.run.status = "in_progress";
  pending.jobs.push(makeJob("Other Job", "in_progress"));
  const target = ["--until-job", "Deploy to Production"];
  const blocked = watchRun([pending, finishedPoll()], { args: [RUN_URL, ...target] });
  assert.equal(blocked.code, 6, blocked.out + blocked.err);
  assert.deepEqual(blocked.sleeps, []);
  assert.ok(blocked.verdict.some((line) => line.includes(`blocking run: ${pending.holder.html_url}`)));

  for (const otherJobStatus of ["in_progress", "pending"]) {
    const unrelated = concurrencyPoll("waiting");
    unrelated.run.status = "in_progress";
    unrelated.jobs[1].name = "Unrelated Deploy";
    unrelated.jobs.push(makeJob("Deploy to Production", "pending"), makeJob("Other Job", otherJobStatus));
    const result = watchRun([unrelated, finishedPoll()], { args: [RUN_URL, ...target] });
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(result.verdict[0], "PASSED");
    assert.equal(result.sleeps.length, 1);
    assert.ok(!result.calls.some(({ argv }) => argv[1].includes("ahead_of_job=")));
  }
});

test("--stop-at-waiting settles only when all non-waiting jobs passed and fails closed on any failure", () => {
  const prodWaiting = makeJob("Deploy to Production", "waiting", null);

  // Does not settle while another non-waiting job is still pending; settles once only waiting remains.
  const settled = watchRun([
    {
      run: makeRun({ status: "in_progress", conclusion: null }),
      jobs: [
        makeJob("Build", "completed", "success"),
        makeJob("Deploy Staging", "in_progress", null),
        prodWaiting,
      ],
    },
    {
      run: makeRun({ status: "waiting", conclusion: null }),
      jobs: [
        makeJob("Build", "completed", "success"),
        makeJob("Deploy Staging", "completed", "success"),
        prodWaiting,
      ],
    },
  ].map((poll) => ({ ...poll, diagnostics: { [DEPLOYMENTS]: [PRODUCTION_GATE] } })), {
    args: [RUN_URL, "--interval", "0.02", "--stop-at-waiting"],
  });
  assert.equal(settled.code, 0, settled.out + settled.err);
  assert.equal(settled.verdict[0], "SETTLED: waiting at deployment gate (1 waiting job)");
  assert.ok(settled.verdict.includes("jobs: 2 passed, 0 failed, 1 waiting, 0 active, 0 pending, 0 skipped"));
  assert.ok(settled.verdict.includes(`  waiting: Deploy to Production ${prodWaiting.html_url}`));
  assert.ok(settled.verdict.includes("  environment: production (current_user_can_approve: false)"));
  assert.equal(settled.calls.filter(({ argv }) => /\/actions\/runs\/\d+$/.test(argv[1])).length, 2);

  // Fails closed immediately if any job failed before/alongside the waiting gate.
  const brokenSmoke = makeJob("Smoke Test", "completed", "failure");
  const failedBeforeGate = watchRun([{
    run: makeRun({ status: "waiting", conclusion: null }),
    jobs: [
      makeJob("Build", "completed", "success"),
      brokenSmoke,
      prodWaiting,
    ],
  }], { args: [RUN_URL, "--interval", "0.02", "--stop-at-waiting"] });
  assert.equal(failedBeforeGate.code, 4, failedBeforeGate.out);
  assert.equal(failedBeforeGate.verdict[0], "FAILED: 1 job failed");
  assert.ok(failedBeforeGate.verdict.includes(`  failed: Smoke Test (failure) ${brokenSmoke.html_url}`));
  assert.ok(failedBeforeGate.verdict.includes(`  waiting: Deploy to Production ${prodWaiting.html_url}`));

  // Combining --until-job with --stop-at-waiting still fails closed when another job failed even if the target passed.
  const combinedFailed = watchRun([{
    run: makeRun({ status: "in_progress", conclusion: null }),
    jobs: [
      makeJob("Deploy Staging", "completed", "success"),
      brokenSmoke,
      prodWaiting,
    ],
  }], { args: [RUN_URL, "--once", "--until-job", "Deploy Staging", "--stop-at-waiting"] });
  assert.equal(combinedFailed.code, 4, combinedFailed.out);
  assert.equal(combinedFailed.verdict[0], "FAILED: 1 job failed");
  assert.ok(combinedFailed.verdict.includes(`  failed: Smoke Test (failure) ${brokenSmoke.html_url}`));
});

test("reuses GitHub rate-limit backoff for primary and secondary limits", () => {
  const futureReset = Math.floor(Date.now() / 1000) + 90;
  const primaryLimited = {
    fail: {
      status: 403,
      headers: { "X-Ratelimit-Remaining": "0", "X-Ratelimit-Reset": String(futureReset) },
      stderr: "gh: API rate limit exceeded (HTTP 403)",
      body: { message: "API rate limit exceeded" },
    },
  };

  // Primary rate limit past timeout waits for timeout without polling again, exiting 8.
  const timedOut = watchRun([primaryLimited], {
    args: [RUN_URL, "--timeout", "0.3", "--interval", "0.02"],
  });
  assert.equal(timedOut.code, 8, timedOut.out + timedOut.err);
  assert.match(timedOut.verdict[0], /^TIMEOUT: timed out after 0.3 s; GitHub primary rate limit/);
  assert.ok(timedOut.out.includes(new Date(futureReset * 1000).toISOString()));
  assert.equal(timedOut.calls.filter(({ argv }) => /\/actions\/runs\/\d+$/.test(argv[1])).length, 1);

  // With --once, a rate limit aborts immediately with exit 7.
  const onceLimited = watchRun([primaryLimited], { args: [RUN_URL, "--once"] });
  assert.equal(onceLimited.code, 7, onceLimited.out);
  assert.match(onceLimited.verdict[0], /^UNKNOWN: GitHub query failed: GitHub primary rate limit/);

  // Secondary rate limit with Retry-After waits >= 1s and recovers cleanly on next poll.
  const secondaryLimited = {
    fail: {
      status: 403,
      headers: { "Retry-After": "1" },
      stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)",
      body: { message: "You have exceeded a secondary rate limit." },
    },
  };
  const recovered = watchRun([
    secondaryLimited,
    { run: makeRun(), jobs: [makeJob("Build", "completed", "success")] },
  ], { args: [RUN_URL, "--timeout", "5", "--interval", "30"], fastClock: false });
  assert.equal(recovered.code, 0, recovered.out + recovered.err);
  assert.equal(recovered.verdict[0], "PASSED");
  const runCalls = recovered.calls.filter(({ argv }) => /\/actions\/runs\/\d+$/.test(argv[1]));
  assert.equal(runCalls.length, 2);
  assert.ok(runCalls[1].at - runCalls[0].at >= 950, `expected Retry-After wait, got ${runCalls[1].at - runCalls[0].at}ms`);
});

test("handles non-200 query errors, transient recovery, timeouts, --once, and bounded output", () => {
  // 5 consecutive HTTP 502 responses exhaust retries and exit 7.
  const fail502 = {
    fail: {
      status: 502,
      stderr: "gh: HTTP 502: Bad Gateway",
      body: { message: "Bad Gateway" },
    },
  };
  const queryFailed = watchRun([fail502], { args: [RUN_URL, "--interval", "0.02"] });
  assert.equal(queryFailed.code, 7, queryFailed.out);
  assert.match(queryFailed.verdict[0], /^UNKNOWN: GitHub query failed 5 times in a row:/);
  assert.ok(queryFailed.verdict.includes(`run: ${RUN_URL}`));
  assert.ok(queryFailed.verdict.some((line) => line.startsWith("github cli: gh-work (")));
  assert.equal(queryFailed.calls.filter(({ argv }) => /\/actions\/runs\/\d+$/.test(argv[1])).length, 5);

  // Non-retryable HTTP 401 aborts on the first attempt with exit 7.
  const unauth = watchRun([{
    fail: {
      status: 401,
      stderr: "gh: Bad credentials (HTTP 401)",
      body: { message: "Bad credentials" },
    },
  }], { args: [RUN_URL, "--interval", "0.02"] });
  assert.equal(unauth.code, 7, unauth.out);
  assert.match(unauth.verdict[0], /^UNKNOWN: GitHub query failed:/);
  assert.equal(unauth.calls.filter(({ argv }) => /\/actions\/runs\/\d+$/.test(argv[1])).length, 1);

  // Transient error followed by success recovers cleanly.
  const transient = watchRun([
    fail502,
    { run: makeRun(), jobs: [makeJob("Build", "completed", "success")] },
  ], { args: [RUN_URL, "--interval", "0.02"] });
  assert.equal(transient.code, 0, transient.out);
  assert.equal(transient.verdict[0], "PASSED");

  // --timeout while run stays in progress exits 8.
  const timed = watchRun([{
    run: makeRun({ status: "in_progress", conclusion: null }),
    jobs: [makeJob("Long Job", "in_progress", null)],
  }], { args: [RUN_URL, "--timeout", "0.15", "--interval", "0.03"] });
  assert.equal(timed.code, 8, timed.out);
  assert.match(timed.verdict[0], /^TIMEOUT: timed out after 0\.15 s; waiting for: 1 job active \(Long Job\)/);
  assert.ok(timed.verdict.includes("  active: Long Job"));

  // --once while run is in progress exits 8 without polling again.
  const glance = watchRun([{
    run: makeRun({ status: "in_progress", conclusion: null }),
    jobs: [makeJob("Long Job", "in_progress", null)],
  }], { args: [RUN_URL, "--once"] });
  assert.equal(glance.code, 8, glance.out);
  assert.match(glance.verdict[0], /^PENDING: not finished; waiting for: 1 job active \(Long Job\)/);

  // Large failure + waiting set still fits <= 20 lines and <= 2048 bytes.
  const manyFailed = Array.from({ length: 30 }, (_, i) =>
    makeJob(`matrix-job-with-a-very-long-name-${i}-${"x".repeat(40)}`, "completed", "failure"));
  const manyWaiting = Array.from({ length: 12 }, (_, i) =>
    makeJob(`deploy-env-${i}`, "waiting", null));
  const bounded = watchRun([{
    run: makeRun({ status: "completed", conclusion: "failure" }),
    jobs: [...manyFailed, ...manyWaiting],
  }]);
  assert.equal(bounded.code, 4, bounded.out);
  assert.ok(bounded.verdict.length <= 20, `expected <= 20 lines, got ${bounded.verdict.length}`);
  assert.ok(Buffer.byteLength(bounded.out) <= 2048, `expected <= 2048 bytes, got ${Buffer.byteLength(bounded.out)}`);
  assert.ok(bounded.verdict.some((line) => /^\s+\.\.\. \d+ more failed jobs$/.test(line)), bounded.out);
  assert.ok(bounded.verdict.some((line) => /^\s+\.\.\. \d+ more waiting jobs$/.test(line)), bounded.out);

  // Positive intervals below 30s silently clamp to 30s without error; default is 60s.
  const inProgress = { run: makeRun({ status: "in_progress", conclusion: null }), jobs: [makeJob("Build", "in_progress", null)] };
  const finished = { run: makeRun(), jobs: [makeJob("Build", "completed", "success")] };
  const clamped = watchRun([inProgress, finished], { args: [RUN_URL, "--interval", "5"] });
  assert.equal(clamped.code, 0, clamped.out + clamped.err);
  assert.equal(clamped.err, "");
  assert.equal(clamped.sleeps.length, 1);
  assert.ok(clamped.sleeps[0] >= 29_900 && clamped.sleeps[0] <= 30_000, `expected 30s clamped sleep, got ${clamped.sleeps[0]}ms`);

  const defaultWait = watchRun([inProgress, finished], { args: [RUN_URL] });
  assert.equal(defaultWait.code, 0, defaultWait.out + defaultWait.err);
  assert.equal(defaultWait.sleeps.length, 1);
  assert.ok(defaultWait.sleeps[0] >= 59_900 && defaultWait.sleeps[0] <= 60_000, `expected 60s default sleep, got ${defaultWait.sleeps[0]}ms`);
});
