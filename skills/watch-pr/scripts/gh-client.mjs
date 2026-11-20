// Shared zero-dependency GitHub CLI client, environment sanitizer, and
// rate-limit backoff helpers for watch-pr tools (`watch-pr.mjs`, `pr-threads.mjs`,
// and future `watch-run.mjs`).

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Consecutive failed polls before a watcher gives up. */
export const MAX_QUERY_FAILURES = 5;

/** A GitHub CLI request that failed. `retryable` is false when repeating it cannot help. */
export class QueryError extends Error {
  constructor(message, { retryable = true, rateLimit } = {}) {
    super(message);
    this.name = "QueryError";
    this.retryable = retryable;
    this.rateLimit = rateLimit;
  }
}

/** URL-encodes each slash-separated segment of a GitHub ref or path parameter. */
export const segment = (value) => value.split("/").map(encodeURIComponent).join("/");

/** Bot logins end in `[bot]` in REST and not in GraphQL; compare without it. */
export const login = (value) => (value ?? "").replace(/\[bot\]$/, "").toLowerCase();

/**
 * Builds the child environment for invoking a GitHub CLI executable.
 * Strips ambient `GH_TOKEN` and `GITHUB_TOKEN` so account-routing wrappers
 * (`gh-work`, `gh-personal`) always authenticate with their own selected account.
 */
export function sanitizedEnv(baseEnv = process.env) {
  const env = { ...baseEnv, NO_COLOR: "1" };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

/** Finish in-flight reads together before deciding whether and when to poll again. */
export async function readTogether(reads) {
  const results = await Promise.allSettled(reads);
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) {
    const terminal = errors.find((error) => !(error instanceof QueryError) || !error.retryable);
    const limits = errors.filter((error) => error.rateLimit);
    // Preserve the longest reported pause when more than one request was limited.
    const latest = limits.reduce((last, error) => !last ||
      error.rateLimit.notBefore > last.rateLimit.notBefore ? error : last, null);
    throw terminal ?? latest ?? errors[0];
  }
  return results.map((result) => result.value);
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function responsePages(stdout) {
  // `gh api --include --paginate --jq .` prints each response's status and
  // headers, then one JSON value and a newline for each successful page.
  const blocks = stdout.split(/^(?=HTTP\/[\d.]+ \d{3}\b)/m);
  return blocks.filter(Boolean).map((block) => {
    const [head, ...body] = block.split(/\r?\n\r?\n/);
    const [line, ...fields] = head.split(/\r?\n/);
    const headers = new Map(fields.map((field) => {
      const colon = field.indexOf(":");
      return [field.slice(0, colon).toLowerCase(), field.slice(colon + 1).trim()];
    }));
    return { status: Number(/^HTTP\/[\d.]+ (\d{3})\b/.exec(line)?.[1]), headers, body: parseJSON(body.join("\n\n")) };
  });
}

function headerTime(value, from = 0) {
  if (!/^\d+$/.test(value ?? "")) return;
  const time = from + Number(value) * 1000;
  if (Number.isFinite(new Date(time).getTime())) return time;
}

export function rateLimitOf({ status, headers, body }, graphqlErrors = [], now = Date.now()) {
  if (status !== 403 && status !== 429 && !(status === 200 && graphqlErrors.length)) return;
  const reset = headers.get("x-ratelimit-remaining") === "0"
    ? headerTime(headers.get("x-ratelimit-reset")) : undefined;
  const after = headerTime(headers.get("retry-after"), now);
  const messages = [body?.message, ...graphqlErrors.map((error) => error.message)];
  const secondary = messages.some((message) => /\bsecondary rate limit\b/i.test(message ?? ""));
  // A plain 403 can also mean insufficient permissions, even when quota is low.
  const quotaError = graphqlErrors.some((error) => error.type === "RATE_LIMITED") ||
    /^API rate limit exceeded\b/i.test(body?.message ?? "") || status === 429;
  if (!secondary && !quotaError) return;
  if (!secondary && reset === undefined && after === undefined) return;
  const kind = secondary ? "secondary" : reset !== undefined ? "primary" : null;
  // GitHub asks for at least one minute when a secondary limit has no deadline.
  const notBefore = Math.max(reset ?? -Infinity, after ?? -Infinity);
  return { kind, notBefore: notBefore === -Infinity ? now + 60_000 : notBefore };
}

/** Human-readable description of a rate-limit deadline. */
export function formatRateLimit({ kind, notBefore }) {
  return `GitHub ${kind ? `${kind} ` : ""}rate limit; retry no earlier than ${new Date(notBefore).toISOString()}`;
}

/**
 * Sleeps until `elapsedDeadline` (in seconds from watcher start) or until
 * `remaining()` hits 0. Clamps each `setTimeout` call to Node's signed 32-bit
 * timer limit so long waits never collapse to 1 ms.
 */
export async function waitUntilElapsed(elapsedDeadline, { elapsed, remaining, sleep = delay }) {
  let seconds;
  while ((seconds = Math.min(elapsedDeadline - elapsed(), remaining())) > 0) {
    await sleep(Math.min(Math.ceil(1000 * seconds), 2 ** 31 - 1));
  }
}

/**
 * Shared retry and rate-limit backoff state machine for polling scripts.
 * Tracks ordinary consecutive failures separately from repeated secondary
 * rate-limit exponential backoff.
 */
export function createRateLimitBackoff({ interval, maxFailures = MAX_QUERY_FAILURES, now = () => Date.now() }) {
  let failures = 0;
  let secondaryFailures = 0;
  let previousSecondaryWait = 0;

  return {
    reset() {
      failures = 0;
      secondaryFailures = 0;
      previousSecondaryWait = 0;
    },

    /**
     * Evaluates a rate-limited QueryError and returns either:
     * - `{ action: "abort", kind: "queryFailed" | "timeout", description, message }`
     * - `{ action: "wait", description, waitSeconds }`
     */
    onRateLimit(rateLimit, { once = false, timedOut = false, timeout = 0 } = {}) {
      const description = formatRateLimit(rateLimit);
      if (once) return { action: "abort", kind: "queryFailed", description, message: `GitHub query failed: ${description}` };
      if (timedOut) return { action: "abort", kind: "timeout", description, message: `timed out after ${timeout} s; ${description}` };
      const untilReset = (rateLimit.notBefore - now()) / 1000;
      let waitSeconds = untilReset > 0 ? untilReset : interval;
      if (rateLimit.kind === "secondary") {
        // GitHub asks for exponential backoff and a separate stop on repeated secondary limits.
        if (++secondaryFailures >= maxFailures) {
          return {
            action: "abort",
            kind: "queryFailed",
            description,
            message: `GitHub query failed: ${description}; hit ${secondaryFailures} secondary limits`,
          };
        }
        waitSeconds = previousSecondaryWait = Math.max(waitSeconds, previousSecondaryWait * 2);
      }
      return { action: "wait", description, waitSeconds };
    },

    /**
     * Evaluates a non-rate-limit QueryError and returns either:
     * - `{ action: "abort", kind: "queryFailed" | "timeout", message }`
     * - `{ action: "retry", failures, maxFailures }`
     */
    onFailure(error, { once = false, timedOut = false, timeout = 0 } = {}) {
      failures++;
      const gaveUp = !error.retryable || once || failures >= maxFailures;
      if (gaveUp || timedOut) {
        const reason = gaveUp
          ? `GitHub query failed${failures > 1 ? ` ${failures} times in a row` : ""}`
          : `timed out after ${timeout} s; GitHub query failed`;
        return {
          action: "abort",
          kind: gaveUp ? "queryFailed" : "timeout",
          message: `${reason}: ${error.message}`,
        };
      }
      return { action: "retry", failures, maxFailures };
    },
  };
}

/**
 * Low-level GitHub CLI runner sharing `GH_TOKEN`/`GITHUB_TOKEN` stripping,
 * response page parsing, and rate-limit error classification.
 *
 * @param {string} executable GitHub CLI name on PATH, or a path to it.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function createGhClient(executable, { env = process.env } = {}) {
  function run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedEnv(env),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => reject(new QueryError(
        `cannot run GitHub CLI "${executable}": ${error.message}`, { retryable: false })));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  async function json(args) {
    const { code, stdout, stderr } = await run([...args, "--include", "--jq", "."]);
    const pages = responsePages(stdout);
    const response = pages.at(-1);
    const errors = response?.body?.errors;
    const graphqlErrors = args[1] === "graphql" && Array.isArray(errors) ? errors : [];
    if (code !== 0 || graphqlErrors.length) {
      const rateLimit = response && rateLimitOf(response, graphqlErrors);
      const detail = stderr.trim().split(/\r?\n/, 1)[0].slice(0, 240);
      const retryable = code !== 4 && response?.status !== 401 &&
        !graphqlErrors.some((error) => ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"].includes(error.type));
      throw new QueryError(`${executable} ${args.slice(0, 2).join(" ")} exited ${code}${detail ? `: ${detail}` : ""}`,
        { retryable, rateLimit: retryable ? rateLimit : undefined });
    }
    if (!pages.length || pages.some((page) => page.body === undefined)) {
      throw new QueryError(`${executable} ${args.slice(0, 2).join(" ")} did not return JSON`);
    }
    return args.includes("--paginate") ? pages.map((page) => page.body) : pages[0].body;
  }

  /** REST API call. With `paginate: true` (default), returns an array of page bodies. */
  function rest(path, { paginate = true } = {}) {
    const args = ["api", path];
    if (paginate) args.push("--paginate");
    return json(args);
  }

  /** GraphQL query or mutation. With `paginate: true`, returns an array of page bodies. */
  function graphql(query, variables = {}, { paginate = false } = {}) {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      if (value === undefined) continue;
      args.push(typeof value === "number" || typeof value === "boolean" ? "-F" : "-f", `${name}=${value}`);
    }
    if (paginate) args.push("--paginate");
    return json(args);
  }

  return { executable, run, json, rest, graphql };
}
