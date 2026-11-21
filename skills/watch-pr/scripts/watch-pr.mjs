#!/usr/bin/env node
// Waits until one pull request is ready to merge or blocked, then prints a
// short verdict as the last output. See ../SKILL.md for the verdict and exit codes.

import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  MAX_QUERY_FAILURES,
  QueryError,
  createGhClient,
  createRateLimitBackoff,
  readTogether,
  waitUntilElapsed,
} from "./gh-client.mjs";
import { createGitHub } from "./github.mjs";
import {
  ConfigError,
  configPath,
  loadConfig,
  parsePrTarget,
  resolveGitHubCli,
  settingsFor,
} from "./repo-config.mjs";
import { EXIT, assess, expectedChecks, render, reviewerStates, stillWaiting } from "./verdict.mjs";

const USAGE = `Usage: watch-pr.mjs <number|url> [--repo OWNER/NAME] [--timeout SECONDS] [--interval SECONDS] [--sha SHA] [--required-checks-only] [--once]

Waits until the pull request is ready to merge or blocked. The last output is the verdict.

  <number|url>            pull request number or URL (also --pr NUMBER)
  --repo                  OWNER/NAME; default: the origin remote (also --owner OWNER --repo NAME)
  --timeout               give up after this many seconds; default 3600, 0 waits without limit
  --interval              seconds between ordinary polls; default 60
  --sha                   evaluate only once the pull request head is this commit, full or short
  --required-checks-only  treat non-required checks as optional when pending or cancelled
                          (requires branch protection or rulesets to declare required checks)
  --once                  print the verdict for the current state and exit

Exit: 0 ready or merged, 2 merge conflicts, 3 unresolved review threads, 4 failed checks,
5 still waiting (timeout, --once, or a head that has not reached --sha), 6 draft, closed,
changes requested, approval required or behind base, 7 GitHub query failed, 8 a required
reviewer did not sign off, 9 unknown, 64 usage.
`;

class UsageError extends Error {}

function seconds(name, value, { zero }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (parsed === 0 && !zero)) {
    throw new UsageError(`--${name} must be a number ${zero ? "of at least 0" : "greater than 0"}`);
  }
  return parsed;
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
        sha: { type: "string" },
        "required-checks-only": { type: "boolean", default: false },
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
  const resolved = await parsePrTarget(target, { owner: values.owner, repo: values.repo });
  if (resolved.error) throw new UsageError(resolved.error);
  const sha = values.sha?.toLowerCase();
  if (sha !== undefined && !/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new UsageError(`--sha must be the 7 to 40 hex digits of a commit, not: ${values.sha}`);
  }
  return {
    pr: resolved.pr,
    timeout: seconds("timeout", values.timeout, { zero: true }),
    interval: seconds("interval", values.interval, { zero: false }),
    sha,
    requiredChecksOnly: values["required-checks-only"],
    once: values.once,
  };
}

async function main(argv, env) {
  const options = await parse(argv);
  if (options === null) {
    process.stdout.write(USAGE);
    return 0;
  }
  const { pr, timeout, interval, sha, requiredChecksOnly, once } = options;
  const settingsPath = configPath(env);
  const settings = settingsFor(loadConfig(settingsPath), pr.owner, pr.repo);
  const { executable, source } = resolveGitHubCli(settings, { env, settingsPath });
  const client = createGhClient(executable, { env });
  const github = createGitHub(client);
  const reviewerChecks = settings.reviewers.map((rule) => rule.check).filter(Boolean);
  const textReviewerRules = settings.reviewers.filter((rule) => rule.check === undefined);
  const needsTexts = textReviewerRules.length > 0;
  const empty = { workflows: [], required: [], missingWorkflows: [], missingRequired: [], undetermined: [], unreadable: [] };
  const workflowFiles = new Map();
  const requiredChecks = new Map();
  const cached = (cache, key, read) => {
    if (!cache.has(key)) cache.set(key, read().catch((error) => { cache.delete(key); throw error; }));
    return cache.get(key);
  };
  let startHead = null;
  // With --sha, GitHub can still report the head before the push for a few
  // seconds; nothing is judged until the requested commit is the head.
  let headReached = sha === undefined;
  const shortSha = sha === undefined ? "" : sha.slice(0, 7);

  async function observe() {
    const facts = await github.pullRequest(pr);
    const view = {
      pr,
      startHead,
      configPath: settingsPath,
      mergeWithoutApproval: settings.mergeWithoutApproval,
      reviewerChecks,
      textReviewerRules,
      requiredChecksOnly,
      facts,
      checks: [],
      expected: empty,
      reviewers: [],
    };
    if (facts.state !== "OPEN") return view;
    if (!headReached) {
      if (facts.head.startsWith(sha)) headReached = true;
      else return { ...view, waitingForHead: true };
    }
    view.startHead = startHead ??= facts.head;
    const [{ checks, runs }, files, required, texts] = await readTogether([
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
  const remaining = () => timeout > 0 ? Math.max(0, timeout - elapsed()) : Infinity;
  const timedOut = () => remaining() === 0;
  const sleep = () => delay(1000 * Math.min(interval, remaining()));
  const log = (text) => process.stdout.write(`${new Date().toISOString()} ${text}\n`);
  function queryBlocked(exitCode, reason) {
    process.stdout.write([
      `BLOCKED: ${reason}`,
      `pr: https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
      `github cli: ${executable} (${source})`,
    ].join("\n").concat("\n"));
    return exitCode;
  }
  const backoff = createRateLimitBackoff({ interval, maxFailures: MAX_QUERY_FAILURES });
  const seen = new Set();
  let progress = null;
  for (;;) {
    let view;
    let outcome;
    try {
      view = await observe();
      if (view.waitingForHead) {
        if (once || timedOut()) {
          process.stdout.write([
            `BLOCKED: ${once ? "not ready" : `timed out after ${timeout} s`}; waiting for: the head to reach ${shortSha}`,
            `pr: ${view.facts.url}`,
          ].join("\n").concat("\n"));
          return EXIT.timeout;
        }
        const line = `waiting for the head to reach ${shortSha}: now ${view.facts.head.slice(0, 7)}`;
        if (line !== progress) log(line);
        progress = line;
        backoff.reset();
        await sleep();
        continue;
      }
      outcome = assess(view, { firstLook: !once && !seen.has(view.facts.head) });
      // A push during the reads would make READY describe a commit that is no longer the head.
      if (outcome.kind === "ready" && (await github.head(pr)) !== view.facts.head) continue;
      seen.add(view.facts.head);
      backoff.reset();
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      if (error.rateLimit) {
        const decision = backoff.onRateLimit(error.rateLimit, { once, timedOut: timedOut(), timeout });
        if (decision.action === "abort") {
          return queryBlocked(EXIT[decision.kind], decision.message);
        }
        const wake = elapsed() + decision.waitSeconds;
        log(`${decision.description}; ${decision.waitSeconds >= remaining() ? "waiting for the watch timeout" : `next poll in ${Math.ceil(decision.waitSeconds)} s`}`);
        await waitUntilElapsed(wake, { elapsed, remaining });
        if (timedOut()) {
          return queryBlocked(EXIT.timeout, `timed out after ${timeout} s; ${decision.description}`);
        }
        continue;
      }
      const decision = backoff.onFailure(error, { once, timedOut: timedOut(), timeout });
      if (decision.action === "abort") {
        return queryBlocked(EXIT[decision.kind], decision.message);
      }
      log(`retry ${decision.failures}/${decision.maxFailures}: ${error.message}`);
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
