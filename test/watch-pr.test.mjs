import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GhGitHubReader, PR_CHECK_ROLLUP_QUERY, PR_COMMIT_STATUS_QUERY,
  REVIEW_THREADS_QUERY, WatcherQueryError, orderStack,
} from "../skills/poteto-mode/scripts/watch-pr/github.ts";
import { classifyPr, runSimple } from "../skills/poteto-mode/scripts/watch-pr/policy.ts";

const context = { owner: "owner", repo: "repo", number: 42 };
const fixture = readFileSync(new URL("./fixtures/watch-pr-gh.mjs", import.meta.url), "utf8");
const graphql = (query, after) => [
  "api", "graphql", "-f", `query=${query}`, "-f", "owner=owner", "-f", "repo=repo", "-F", "pr=42",
  ...(after ? ["-f", `after=${after}`] : []),
];
const factsArgv = [
  "pr", "view", "42", "--repo", "owner/repo", "--json",
  "mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,baseRefName,state,mergedAt,isDraft",
];
const checksArgv = ["pr", "checks", "42", "--repo", "owner/repo", "--json", "name,state,description,link,workflow,bucket"];

async function withRouter(run) {
  const temp = mkdtempSync(join(tmpdir(), "watch-pr-router-"));
  const keys = ["PATH", "WATCH_PR_GH", "WATCH_PR_FIXTURE_LOG"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const name of ["gh", "gh-personal", "gh-work", "wrapper with spaces"]) {
      writeFileSync(join(temp, name), `#!${process.execPath}\n${fixture}`, { mode: 0o755 });
    }
    process.env.PATH = `${temp}:${process.env.PATH}`;
    delete process.env.WATCH_PR_GH;
    process.env.WATCH_PR_FIXTURE_LOG = join(temp, "calls.ndjson");
    writeFileSync(process.env.WATCH_PR_FIXTURE_LOG, "");
    const calls = () => readFileSync(process.env.WATCH_PR_FIXTURE_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    await run({ temp, calls });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

function watch(reader, statusOnly) {
  const progress = [];
  const sleeps = [];
  let now = 0;
  return {
    progress, sleeps,
    verdict: runSimple({
      dependencies: {
        reader, emit: (value) => progress.push(value),
        clock: {
          now: () => now, observedAt: () => "2026-01-01T00:00:00Z",
          sleep: async (seconds) => { sleeps.push(seconds); now += seconds; },
        },
      },
      contexts: [context], mode: "single", statusOnly,
      options: { interval: 60, sweepInterval: 300, timeout: 60, maxQueryErrors: 5, allowDraft: false },
    }),
  };
}

// https://github.com/fitchmultz/pi-pstack/issues/11: use real executable fixtures,
// not a fake GitHubReader, so a missed hardcoded `gh` remains observable.
test("bare gh routing refusal reaches the watcher as the existing retryable exit 2", async (t) => {
  await withRouter(async ({ temp, calls }) => {
    for (const selection of [undefined, ""]) {
      if (selection === undefined) delete process.env.WATCH_PR_GH;
      else process.env.WATCH_PR_GH = selection;
      await assert.rejects(new GhGitHubReader().reviewThreadPage(context, null), (error) => {
        assert.ok(error instanceof WatcherQueryError);
        assert.equal(error.failure.kind, "command-exit");
        assert.equal(error.failure.code, 2);
        assert.equal(error.failure.retryable, true);
        return true;
      });
    }
    const watched = watch(new GhGitHubReader(), true);
    const result = await watched.verdict;
    assert.equal(result.kind, "TIMEOUT");
    assert.equal(result.exitCode, 5);
    assert.deepEqual(watched.sleeps, [60]);
    assert.equal(watched.progress[0].kind, "RETRY");
    assert.equal(watched.progress[0].failure.code, 2);
    assert.equal(watched.progress[0].retryInSeconds, 60);
    assert.ok(calls().every((call) => call.program === join(temp, "gh")));
    assert.deepEqual(calls()[0].argv, graphql(REVIEW_THREADS_QUERY));
    t.diagnostic("Default/empty selection: real GraphQL exit=2; status-only RETRY=60s; fake-clock TIMEOUT=5; no network or real sleep");
  });
});

test("selected wrapper handles every GitHub read and preserves pagination, review and merge gates", async (t) => {
  await withRouter(async ({ temp, calls }) => {
    process.env.WATCH_PR_GH = "gh-personal";
    const reader = new GhGitHubReader();
    assert.deepEqual(await reader.currentPr(null), context);
    assert.deepEqual(await reader.currentPr(42), context);
    // https://github.com/fitchmultz/pi-pstack/issues/13: preserve fork identity
    // across the executable GitHub boundary and the native stack policy.
    const open = await reader.openPullRequests(context);
    assert.deepEqual(open, [
      { number: 41, headRefName: "base-feature", baseRefName: "main", isCrossRepository: false },
      { number: 42, headRefName: "feature", baseRefName: "base-feature", isCrossRepository: false },
      { number: 43, headRefName: "upstack", baseRefName: "feature", isCrossRepository: false },
      { number: 44, headRefName: "base-feature", baseRefName: "main", isCrossRepository: true },
    ]);
    assert.deepEqual(orderStack(context, open).map(({ number }) => number), [41, 42, 43]);
    assert.deepEqual(orderStack({ ...context, number: 44 }, open).map(({ number }) => number), [44]);
    const watched = watch(reader, true);
    const result = await watched.verdict;
    assert.equal(result.kind, "STATUS");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(watched.progress, []);
    assert.deepEqual(watched.sleeps, []);
    const [row] = result.rows;
    assert.equal(row.kind, "open");
    assert.deepEqual(row.threads.map((thread) => thread.id), ["unresolved-later-page"]);
    assert.equal(classifyPr(row).blocker.kind, "review-threads");
    assert.equal(row.ci.source, "graphql-rollup");
    assert.deepEqual(row.ci.all.map(({ name, kind }) => ({ name, kind })), [
      { name: "ci", kind: "passed" }, { name: "legacy-ci", kind: "passed" },
    ]);
    assert.equal(row.ci.kind, "ci-github-rejected");
    assert.equal(row.ci.hadPreviousPassingCi, true);
    assert.equal(row.ci.github.headRollupState, "FAILURE");
    const withoutThreads = { ...row, threads: [] };
    assert.equal(classifyPr(withoutThreads).blocker.kind, "failing-checks");
    assert.deepEqual(calls(), [
      ["pr", "view", "--json", "number,url"],
      ["pr", "view", "42", "--json", "number,url"],
      ["pr", "list", "--repo", "owner/repo", "--state", "open", "--limit", "300", "--json", "number,headRefName,baseRefName,isCrossRepository"],
      factsArgv,
      graphql(REVIEW_THREADS_QUERY), graphql(REVIEW_THREADS_QUERY, "threads-next"),
      checksArgv,
      graphql(PR_CHECK_ROLLUP_QUERY), graphql(PR_CHECK_ROLLUP_QUERY, "checks-next"),
      graphql(PR_COMMIT_STATUS_QUERY),
    ].map((argv) => ({ program: join(temp, "gh-personal"), argv })));
    t.diagnostic("gh-personal: all 7 GitHub reader operations; exact program/argv; two-page threads/rollups; STATUS=0; no retry/sleep; review and GitHub CI refusal preserved");
  });
});

test("work wrapper and executable paths are single programs; origin discovery still uses git", async () => {
  await withRouter(async ({ temp, calls }) => {
    for (const selection of ["gh-work", join(temp, "wrapper with spaces")]) {
      process.env.WATCH_PR_GH = selection;
      assert.equal((await new GhGitHubReader().reviewThreadPage(context, "threads-next")).threads[0].id, "unresolved-later-page");
      assert.deepEqual(calls().at(-1), {
        program: selection === "gh-work" ? join(temp, selection) : selection,
        argv: graphql(REVIEW_THREADS_QUERY, "threads-next"),
      });
    }
    const cwd = process.cwd();
    const before = calls();
    try {
      execFileSync("git", ["init", "--quiet", temp]);
      execFileSync("git", ["-C", temp, "remote", "add", "origin", "https://github.com/local/checkout.git"]);
      process.chdir(temp);
      assert.deepEqual(await new GhGitHubReader().originRepo(), { owner: "local", repo: "checkout" });
      assert.deepEqual(calls(), before, "git discovery must not invoke the selected GitHub CLI");
    } finally { process.chdir(cwd); }
  });
});
