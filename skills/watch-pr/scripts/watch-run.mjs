#!/usr/bin/env node
// Waits for a GitHub Actions workflow run to pass, settle at a target job or
// deployment-approval gate, or fail, then prints a bounded verdict as the last
// output. See ../SKILL.md for flags and exit codes.

import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  MAX_QUERY_FAILURES,
  QueryError,
  createGhClient,
  createRateLimitBackoff,
  waitUntilElapsed,
} from "./gh-client.mjs";
import {
  ConfigError,
  configPath,
  loadConfig,
  resolveGitHubCli,
  resolveRepo,
  settingsFor,
} from "./repo-config.mjs";
import { clip, formatBoundedBlock, plural, some } from "./verdict.mjs";

const EXIT = {
  passed: 0,
  failed: 4,
  queryFailed: 7,
  unknown: 7,
  timeout: 8,
  usage: 64,
};

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);

const USAGE = `Usage: watch-run.mjs <run-id|url> [--repo OWNER/NAME] [--interval SECONDS] [--timeout SECONDS] [--until-job NAME]... [--stop-at-waiting] [--once]

Waits for a GitHub Actions workflow run to finish or settle, then prints a concise verdict.

  <run-id|url>       workflow run ID or URL (also --run ID|URL)
  --repo             OWNER/NAME; default: the origin remote (also --owner OWNER --repo NAME)
  --interval         seconds between ordinary polls; default 60
  --timeout          give up after this many seconds; default 3600, 0 waits without limit
  --until-job        repeatable job name (or "Workflow / Job") to wait for; settles with exit 0
                     once all named jobs succeed, even if downstream jobs are still waiting/running
  --stop-at-waiting  settle with exit 0 once all active non-waiting jobs succeed and only
                     waiting deployment-gate job(s) remain (fails closed if any job failed)
  --once             evaluate the current run state and exit without polling

Exit: 0 passed or settled, 4 failed or cancelled, 7 unknown or GitHub query failed,
8 timeout (or still running with --once), 64 usage or configuration error.
`;

class UsageError extends Error {}

function seconds(name, value, { zero }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (parsed === 0 && !zero)) {
    throw new UsageError(`--${name} must be a number ${zero ? "of at least 0" : "greater than 0"}`);
  }
  return parsed;
}

/** Parses a workflow run URL or numeric ID into `{ owner, repo, runId }`. */
async function parseRunTarget(target, { owner, repo, cwd = process.cwd() } = {}) {
  let parsedOwner = owner;
  let parsedRepo = repo;
  let runId = String(target).trim();
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9]\d*)(?:[/?#].*)?$/.exec(runId);
  if (url) [, parsedOwner, parsedRepo, runId] = url;
  if (!/^[1-9]\d*$/.test(runId)) return { error: `not a workflow run ID or URL: ${target}` };
  const resolved = await resolveRepo({ owner: parsedOwner, repo: parsedRepo, cwd });
  if (!resolved) return { error: "name the repository: --repo OWNER/NAME" };
  return { target: { owner: resolved.owner, repo: resolved.repo, runId } };
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
        run: { type: "string" },
        interval: { type: "string", default: "60" },
        timeout: { type: "string", default: "3600" },
        "until-job": { type: "string", multiple: true, default: [] },
        "stop-at-waiting": { type: "boolean", default: false },
        once: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help) return null;
  if (positionals.length > 1) throw new UsageError("name one workflow run");
  if (positionals.length && values.run !== undefined) throw new UsageError("name the workflow run once");
  const rawTarget = positionals[0] ?? values.run;
  if (rawTarget === undefined) throw new UsageError("name the workflow run: an ID or URL");
  const resolved = await parseRunTarget(rawTarget, { owner: values.owner, repo: values.repo });
  if (resolved.error) throw new UsageError(resolved.error);
  const untilJobs = [...new Set(values["until-job"].map((name) => {
    const trimmed = name.trim();
    if (!trimmed) throw new UsageError("--until-job must be a non-empty job name");
    return trimmed;
  }))];
  return {
    target: resolved.target,
    interval: seconds("interval", values.interval, { zero: false }),
    timeout: seconds("timeout", values.timeout, { zero: true }),
    untilJobs,
    stopAtWaiting: values["stop-at-waiting"],
    once: values.once,
  };
}

function classifyJob(job) {
  const status = job.status ?? "unknown";
  const conclusion = job.conclusion ?? null;
  const link = job.html_url || "";
  if (status === "waiting") {
    return { name: job.name, bucket: "waiting", status, conclusion, detail: "waiting", link };
  }
  if (status !== "completed") {
    return { name: job.name, bucket: "pending", status, conclusion, detail: status, link };
  }
  if (conclusion === "success") {
    return { name: job.name, bucket: "passed", status, conclusion, detail: "success", link };
  }
  if (conclusion === "skipped" || conclusion === "neutral") {
    return { name: job.name, bucket: "skipped", status, conclusion, detail: conclusion, link };
  }
  return {
    name: job.name,
    bucket: "failed",
    status,
    conclusion,
    detail: conclusion ?? "unknown",
    link,
  };
}

function partitionJobs(jobs) {
  const buckets = { passed: [], failed: [], waiting: [], pending: [], skipped: [] };
  for (const raw of jobs) {
    const item = classifyJob(raw);
    buckets[item.bucket].push(item);
  }
  return buckets;
}

function matchesJobTarget(job, workflowName, target) {
  return job.name === target || (workflowName ? `${workflowName} / ${job.name}` === target : false);
}

function failureOutcome(failedJobs, prefix = "") {
  const cancelled = failedJobs.filter((job) => job.detail === "cancelled").length;
  const nonCancelled = failedJobs.length - cancelled;
  const noun = prefix ? `${prefix} job` : "job";
  const names = prefix ? ` (${some(failedJobs.map((job) => job.name))})` : "";
  if (nonCancelled === 0) {
    return {
      kind: "cancelled",
      exitCode: EXIT.failed,
      reason: `${plural(cancelled, noun)} cancelled${names}`,
    };
  }
  const detail = cancelled
    ? `${plural(nonCancelled, noun)} failed, ${cancelled} cancelled`
    : `${plural(nonCancelled, noun)} failed`;
  return { kind: "failed", exitCode: EXIT.failed, reason: `${detail}${names}` };
}

function completedRunOutcome(run) {
  if (run.conclusion === "success") {
    return { kind: "passed", exitCode: EXIT.passed };
  }
  if (run.conclusion === "cancelled") {
    return { kind: "cancelled", exitCode: EXIT.failed, reason: "workflow run was cancelled" };
  }
  if (FAILED_CONCLUSIONS.has(run.conclusion)) {
    return { kind: "failed", exitCode: EXIT.failed, reason: `workflow run completed as ${run.conclusion}` };
  }
  return {
    kind: "unknown",
    exitCode: EXIT.unknown,
    reason: `workflow run completed as ${run.conclusion ?? "unknown"}`,
  };
}

function waitingSummary(buckets, run, pendingTargets = []) {
  const parts = [];
  if (pendingTargets.length) {
    parts.push(`${plural(pendingTargets.length, "target job")} not passed (${some(pendingTargets)})`);
  }
  if (buckets.pending.length) {
    parts.push(`${plural(buckets.pending.length, "job")} pending (${some(buckets.pending.map((j) => j.name))})`);
  }
  if (buckets.waiting.length) {
    parts.push(`${plural(buckets.waiting.length, "job")} waiting (${some(buckets.waiting.map((j) => j.name))})`);
  }
  if (!parts.length) {
    parts.push(`workflow run is ${run.status}`);
  }
  return parts;
}

function assessRun({ run, buckets }, { untilJobs, stopAtWaiting }) {
  const workflowName = run.name || (run.path ? basename(run.path) : "");
  const allJobs = [
    ...buckets.passed,
    ...buckets.failed,
    ...buckets.waiting,
    ...buckets.pending,
    ...buckets.skipped,
  ];

  if (untilJobs.length > 0) {
    const failedTargetJobs = [];
    const skippedTargets = [];
    const pendingTargets = [];
    const missingTargets = [];
    let passedTargets = 0;

    for (const target of untilJobs) {
      const matching = allJobs.filter((job) => matchesJobTarget(job, workflowName, target));
      const failed = matching.filter((job) => job.bucket === "failed");
      const skipped = matching.filter((job) => job.bucket === "skipped");
      if (failed.length) {
        failedTargetJobs.push(...failed);
      } else if (skipped.length) {
        skippedTargets.push(target);
      } else if (matching.length && matching.every((job) => job.bucket === "passed")) {
        passedTargets++;
      } else {
        pendingTargets.push(target);
        if (!matching.length) missingTargets.push(target);
      }
    }

    if (failedTargetJobs.length) {
      return failureOutcome(failedTargetJobs, "target");
    }
    if (stopAtWaiting && buckets.failed.length) {
      return failureOutcome(buckets.failed);
    }
    if (skippedTargets.length) {
      const allCancelled = buckets.failed.length > 0 && buckets.failed.every((job) => job.detail === "cancelled");
      return {
        kind: allCancelled ? "cancelled" : "failed",
        exitCode: EXIT.failed,
        reason: `${plural(skippedTargets.length, "target job")} skipped (${some(skippedTargets)})`,
      };
    }
    if (passedTargets === untilJobs.length) {
      if (run.status === "completed" && run.conclusion === "success" && buckets.failed.length === 0) {
        return { kind: "passed", exitCode: EXIT.passed };
      }
      return {
        kind: "settled",
        exitCode: EXIT.passed,
        reason: `${plural(untilJobs.length, "target job")} passed (${some(untilJobs)})`,
      };
    }
    if (run.status === "completed") {
      if (run.conclusion === "cancelled" || FAILED_CONCLUSIONS.has(run.conclusion)) {
        return completedRunOutcome(run);
      }
      const missing = missingTargets.length ? missingTargets : pendingTargets;
      return {
        kind: "unknown",
        exitCode: EXIT.unknown,
        reason: `${plural(missing.length, "target job")} not found in completed run (${some(missing)})`,
      };
    }
    return { kind: "waiting", waiting: waitingSummary(buckets, run, pendingTargets) };
  }

  if (run.status === "completed") {
    return completedRunOutcome(run);
  }
  if (buckets.failed.length) {
    return failureOutcome(buckets.failed);
  }
  if (stopAtWaiting && buckets.waiting.length > 0 && buckets.pending.length === 0) {
    return {
      kind: "settled",
      exitCode: EXIT.passed,
      reason: `waiting at deployment gate (${plural(buckets.waiting.length, "waiting job")})`,
    };
  }
  return { kind: "waiting", waiting: waitingSummary(buckets, run) };
}

function headline(outcome) {
  if (outcome.kind === "passed") return "PASSED";
  const prefix = {
    settled: "SETTLED",
    failed: "FAILED",
    cancelled: "CANCELLED",
    unknown: "UNKNOWN",
    timeout: "TIMEOUT",
    pending: "PENDING",
  }[outcome.kind] ?? "UNKNOWN";
  return clip(outcome.reason ? `${prefix}: ${outcome.reason}` : prefix, 400);
}

function renderRun({ target, run, buckets }, outcome) {
  const runUrl = run.html_url || `https://github.com/${target.owner}/${target.repo}/actions/runs/${target.runId}`;
  const workflowName = run.name || (run.path ? basename(run.path) : `run ${target.runId}`);
  const runState = run.status === "completed" && run.conclusion
    ? `${run.status}/${run.conclusion}`
    : run.status;
  const headSha = run.head_sha || "unknown";
  const counts = [
    `${buckets.passed.length} passed`,
    `${buckets.failed.length} failed`,
    `${buckets.waiting.length} waiting`,
    `${buckets.pending.length} pending`,
    `${buckets.skipped.length} skipped`,
  ].join(", ");

  const top = [
    headline(outcome),
    `run: ${runUrl}`,
    `workflow: ${clip(workflowName, 120)} (${runState})`,
    `commit: ${headSha}`,
    `jobs: ${counts}`,
  ];

  const parts = [
    {
      items: buckets.failed.map((job) =>
        `  failed: ${clip(job.name, 80)} (${job.detail})${job.link ? ` ${job.link}` : ""}`),
      before: [],
      more: "failed jobs",
    },
    {
      items: buckets.waiting.map((job) =>
        `  waiting: ${clip(job.name, 80)}${job.link ? ` ${job.link}` : ""}`),
      before: [],
      more: "waiting jobs",
    },
    {
      items: [],
      before: buckets.pending.length
        ? [clip(`  pending: ${some(buckets.pending.map((job) => job.name))}`, 300)]
        : [],
      more: "pending jobs",
    },
  ];
  return formatBoundedBlock(top, parts);
}

function renderQueryError(target, executable, source, prefix, reason) {
  const runUrl = `https://github.com/${target.owner}/${target.repo}/actions/runs/${target.runId}`;
  return formatBoundedBlock([
    clip(`${prefix}: ${reason}`, 400),
    `run: ${runUrl}`,
    clip(`github cli: ${executable} (${source})`, 300),
  ], []);
}

async function fetchRunState(client, target) {
  const base = `repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/actions/runs/${target.runId}`;
  const run = await client.rest(base, { paginate: false });
  if (!run || typeof run !== "object" || typeof run.status !== "string") {
    throw new QueryError(`GitHub returned no workflow run for ${target.owner}/${target.repo} run ${target.runId}`);
  }
  const jobPages = await client.rest(`${base}/jobs?per_page=100`, { paginate: true });
  const jobs = [];
  for (const page of jobPages) {
    if (!Array.isArray(page?.jobs)) {
      throw new QueryError(`GitHub returned invalid jobs payload for ${target.owner}/${target.repo} run ${target.runId}`);
    }
    jobs.push(...page.jobs);
  }
  return { target, run, jobs, buckets: partitionJobs(jobs) };
}

async function main(argv, env) {
  const options = await parse(argv);
  if (options === null) {
    process.stdout.write(USAGE);
    return 0;
  }
  const { target, interval, timeout, untilJobs, stopAtWaiting, once } = options;
  const settingsPath = configPath(env);
  const settings = settingsFor(loadConfig(settingsPath), target.owner, target.repo);
  const { executable, source } = resolveGitHubCli(settings, { env, settingsPath });
  const client = createGhClient(executable, { env });

  const started = performance.now() / 1000;
  const elapsed = () => performance.now() / 1000 - started;
  const remaining = () => timeout > 0 ? Math.max(0, timeout - elapsed()) : Infinity;
  const timedOut = () => remaining() === 0;
  const sleep = () => waitUntilElapsed(elapsed() + interval, { elapsed, remaining });
  const log = (text) => process.stdout.write(`${new Date().toISOString()} ${text}\n`);
  const backoff = createRateLimitBackoff({ interval, maxFailures: MAX_QUERY_FAILURES });
  let progress = null;

  for (;;) {
    let view;
    let outcome;
    try {
      view = await fetchRunState(client, target);
      outcome = assessRun(view, { untilJobs, stopAtWaiting });
      backoff.reset();
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      if (error.rateLimit) {
        const decision = backoff.onRateLimit(error.rateLimit, { once, timedOut: timedOut(), timeout });
        if (decision.action === "abort") {
          const prefix = decision.kind === "timeout" ? "TIMEOUT" : "UNKNOWN";
          process.stdout.write(renderQueryError(target, executable, source, prefix, decision.message));
          return EXIT[decision.kind];
        }
        const wake = elapsed() + decision.waitSeconds;
        log(`${decision.description}; ${decision.waitSeconds >= remaining() ? "waiting for the watch timeout" : `next poll in ${Math.ceil(decision.waitSeconds)} s`}`);
        await waitUntilElapsed(wake, { elapsed, remaining });
        if (timedOut()) {
          process.stdout.write(renderQueryError(
            target,
            executable,
            source,
            "TIMEOUT",
            `timed out after ${timeout} s; ${decision.description}`,
          ));
          return EXIT.timeout;
        }
        continue;
      }
      const decision = backoff.onFailure(error, { once, timedOut: timedOut(), timeout });
      if (decision.action === "abort") {
        const prefix = decision.kind === "timeout" ? "TIMEOUT" : "UNKNOWN";
        process.stdout.write(renderQueryError(target, executable, source, prefix, decision.message));
        return EXIT[decision.kind];
      }
      log(`retry ${decision.failures}/${decision.maxFailures}: ${error.message}`);
      await sleep();
      continue;
    }

    if (outcome.kind === "waiting" && (once || timedOut())) {
      outcome = {
        kind: once ? "pending" : "timeout",
        exitCode: EXIT.timeout,
        reason: `${once ? "not finished" : `timed out after ${timeout} s`}; waiting for: ${outcome.waiting.join("; ")}`,
      };
    }
    if (outcome.kind !== "waiting") {
      process.stdout.write(renderRun(view, outcome));
      return outcome.exitCode;
    }

    const shortSha = (view.run.head_sha || "unknown").slice(0, 7);
    const line = `waiting on ${shortSha}: ${outcome.waiting.join("; ")}`;
    if (line !== progress) log(line);
    progress = line;
    await sleep();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof UsageError) && !(error instanceof ConfigError)) throw error;
    process.stderr.write(`watch-run: ${error.message}\n${error instanceof UsageError ? USAGE : ""}`);
    process.exitCode = EXIT.usage;
  }
}
