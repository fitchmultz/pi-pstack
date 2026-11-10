#!/usr/bin/env node
// Waits until one pull request is ready to merge or blocked, then prints a
// short verdict as the last output. See ../SKILL.md for the verdict and exit codes.

import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { ConfigError, configPath, loadConfig, settingsFor } from "./config.mjs";
import { QueryError, createGitHub } from "./github.mjs";
import { EXIT, assess, expectedChecks, render, reviewerStates, stillWaiting } from "./verdict.mjs";

const USAGE = `Usage: watch-pr.mjs <number|url> [--repo OWNER/NAME] [--timeout SECONDS] [--interval SECONDS] [--once]

Waits until the pull request is ready to merge or blocked. The last output is the verdict.

  <number|url>   pull request number or URL (also --pr NUMBER)
  --repo         OWNER/NAME; default: the origin remote (also --owner OWNER --repo NAME)
  --timeout      give up after this many seconds; default 3600, 0 waits without limit
  --interval     seconds between polls; default 60
  --once         print the verdict for the current state and exit

Exit: 0 ready or merged, 2 merge conflicts, 3 unresolved review threads, 4 failed checks,
5 still waiting (timeout or --once), 6 draft, closed, changes requested, approval required or behind base,
7 GitHub query failed, 8 a required reviewer did not sign off, 9 unknown, 64 usage.
`;

// Consecutive failed polls before the watch gives up; the packaged poteto-mode watcher uses the same budget.
const MAX_QUERY_FAILURES = 5;

class UsageError extends Error {}

function seconds(name, value, { zero }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (parsed === 0 && !zero)) {
    throw new UsageError(`--${name} must be a number ${zero ? "of at least 0" : "greater than 0"}`);
  }
  return parsed;
}

function originRemote() {
  return new Promise((resolve) => {
    execFile("git", ["remote", "get-url", "origin"], (error, stdout) => resolve(error ? "" : stdout.trim()));
  });
}

async function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        owner: { type: "string" },
        pr: { type: "string" },
        timeout: { type: "string", default: "3600" },
        interval: { type: "string", default: "60" },
        once: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help) return null;
  if (positionals.length > 1) throw new UsageError("name one pull request");
  const target = positionals[0] ?? values.pr;
  if (target === undefined) throw new UsageError("name the pull request: a number or a URL");
  if (positionals.length && values.pr !== undefined) throw new UsageError("name the pull request once");
  let owner = values.owner;
  let repo = values.repo;
  let number = target.replace(/^#/, "");
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(target);
  if (url) [, owner, repo, number] = url;
  else if (repo?.includes("/")) [owner, repo] = repo.split("/");
  if (!/^[1-9]\d*$/.test(number)) throw new UsageError(`not a pull request number or URL: ${target}`);
  if (!owner || !repo) {
    const origin = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(await originRemote());
    owner ??= origin?.[1];
    repo ??= origin?.[2];
  }
  if (!owner || !repo) throw new UsageError("name the repository: --repo OWNER/NAME");
  return {
    pr: { owner, repo, number: Number(number) },
    timeout: seconds("timeout", values.timeout, { zero: true }),
    interval: seconds("interval", values.interval, { zero: false }),
    once: values.once,
  };
}

async function main(argv, env) {
  const options = await parse(argv);
  if (options === null) {
    process.stdout.write(USAGE);
    return 0;
  }
  const { pr, timeout, interval, once } = options;
  const settingsPath = configPath(env);
  const settings = settingsFor(loadConfig(settingsPath), pr.owner, pr.repo);
  const executable = env.WATCH_PR_GH || settings.gh || "gh";
  const source = env.WATCH_PR_GH ? "WATCH_PR_GH" : settings.gh ? settingsPath : "the default; none is set in WATCH_PR_GH or " + settingsPath;
  const github = createGitHub(executable);
  const needsTexts = settings.reviewers.some((rule) => rule.check === undefined);
  const empty = { workflows: [], required: [], missingWorkflows: [], missingRequired: [], undetermined: [], unreadable: [] };
  const workflowFiles = new Map();
  const requiredChecks = new Map();
  const cached = (cache, key, read) => {
    if (!cache.has(key)) cache.set(key, read().catch((error) => { cache.delete(key); throw error; }));
    return cache.get(key);
  };
  let startHead = null;

  async function observe() {
    const facts = await github.pullRequest(pr);
    const view = {
      pr, startHead, configPath: settingsPath, mergeWithoutApproval: settings.mergeWithoutApproval,
      facts, checks: [], expected: empty, reviewers: [],
    };
    if (facts.state !== "OPEN") return view;
    view.startHead = startHead ??= facts.head;
    const [{ checks, runs }, files, required, texts] = await Promise.all([
      github.commitChecks(pr, facts.head),
      cached(workflowFiles, facts.head, () => github.workflowFiles(pr, facts.head)),
      cached(requiredChecks, facts.baseRef, () => github.requiredChecks(pr, facts.baseRef)),
      needsTexts ? github.reviewTexts(pr) : [],
    ]);
    view.checks = checks;
    view.expected = expectedChecks({ files, baseRef: facts.baseRef, runs, required, checks });
    view.reviewers = reviewerStates(settings.reviewers, { head: facts.head, checks, texts });
    return view;
  }

  const started = performance.now() / 1000;
  const elapsed = () => performance.now() / 1000 - started;
  const timedOut = () => timeout > 0 && elapsed() >= timeout;
  const sleep = () => delay(1000 * (timeout > 0 ? Math.min(interval, Math.max(0, timeout - elapsed())) : interval));
  const log = (text) => process.stdout.write(`${new Date().toISOString()} ${text}\n`);
  const seen = new Set();
  let failures = 0;
  let progress = null;
  for (;;) {
    let view;
    let outcome;
    try {
      view = await observe();
      outcome = assess(view, { firstLook: !once && !seen.has(view.facts.head) });
      // A push during the reads would make READY describe a commit that is no longer the head.
      if (outcome.kind === "ready" && (await github.head(pr)) !== view.facts.head) continue;
      seen.add(view.facts.head);
      failures = 0;
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      failures++;
      const gaveUp = !error.retryable || once || failures >= MAX_QUERY_FAILURES;
      if (gaveUp || timedOut()) {
        process.stdout.write([
          `BLOCKED: ${gaveUp ? `GitHub query failed${failures > 1 ? ` ${failures} times in a row` : ""}` : `timed out after ${timeout} s; GitHub query failed`}: ${error.message}`,
          `pr: https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
          `github cli: ${executable} (${source})`,
        ].join("\n").concat("\n"));
        return gaveUp ? EXIT.queryFailed : EXIT.timeout;
      }
      log(`retry ${failures}/${MAX_QUERY_FAILURES}: ${error.message}`);
      await sleep();
      continue;
    }
    if (outcome.kind === "waiting" && (once || timedOut())) {
      outcome = stillWaiting(outcome.waiting, once ? "not ready" : `timed out after ${timeout} s`);
    }
    if (outcome.kind !== "waiting") {
      process.stdout.write(render(view, outcome));
      return outcome.exitCode;
    }
    const line = `waiting on ${view.facts.head.slice(0, 7)}: ${outcome.waiting.join("; ")}`;
    if (line !== progress) log(line);
    progress = line;
    await sleep();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2), process.env);
} catch (error) {
  if (!(error instanceof UsageError) && !(error instanceof ConfigError)) throw error;
  process.stderr.write(`watch-pr: ${error.message}\n${error instanceof UsageError ? USAGE : ""}`);
  process.exitCode = EXIT.usage;
}
