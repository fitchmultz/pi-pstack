import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  QueryError,
  createRateLimitBackoff,
  rateLimitOf,
  readTogether,
  sanitizedEnv,
} from "../skills/watch-pr/scripts/gh-client.mjs";
import {
  ConfigError,
  loadConfig,
  resolveGitHubCli,
  settingsFor,
} from "../skills/watch-pr/scripts/repo-config.mjs";
import {
  SEVERITY_TAGS,
  normalizeThread,
  parseSeverity,
} from "../skills/watch-pr/scripts/threads.mjs";
import { partitionChecks } from "../skills/watch-pr/scripts/verdict.mjs";

const exampleConfig = fileURLToPath(new URL("../skills/watch-pr/config.example.json", import.meta.url));

test("repo-config resolves gh/approval precedence, merges reviewers, and rejects unknown keys", () => {
  const temp = mkdtempSync(join(tmpdir(), "repo-config-test-"));
  try {
    const file = join(temp, "watch-pr.json");
    writeFileSync(file, JSON.stringify({
      "*": { gh: "gh-personal", reviewers: [{ name: "Global Bot", check: "Global Bot" }] },
      workos: { gh: "gh-work", reviewers: [{ name: "Org Bot", check: "Org Bot" }] },
      "workos/tars": { mergeWithoutApproval: true, reviewers: [{ name: "TARS review", check: "TARS review" }] },
    }));
    const scopes = loadConfig(file);
    const tars = settingsFor(scopes, "workos", "tars");
    assert.equal(tars.gh, "gh-work");
    assert.equal(tars.mergeWithoutApproval, true);
    assert.deepEqual(tars.reviewers.map((rule) => rule.name), [
      "Global Bot",
      "Org Bot",
      "TARS review",
    ]);

    // Missing config file produces empty defaults.
    const empty = loadConfig(join(temp, "missing.json"));
    assert.deepEqual(settingsFor(empty, "workos", "tars"), {
      gh: null,
      mergeWithoutApproval: false,
      reviewers: [],
    });

    // WATCH_PR_GH overrides configured gh executable.
    assert.equal(resolveGitHubCli(tars, { env: {}, settingsPath: file }).executable, "gh-work");
    assert.equal(resolveGitHubCli(tars, { env: { WATCH_PR_GH: "gh-custom" }, settingsPath: file }).executable, "gh-custom");
    assert.equal(resolveGitHubCli(settingsFor(empty, "owner", "repo"), { env: {}, settingsPath: file }).executable, "gh");

    // Bundled example config parses cleanly; unknown keys fail fast.
    assert.equal(settingsFor(loadConfig(exampleConfig), "my-company", "admin-repo").mergeWithoutApproval, true);
    const unknownKey = join(temp, "unknown-key.json");
    writeFileSync(unknownKey, JSON.stringify({ workos: { unknownOption: true } }));
    assert.throws(() => loadConfig(unknownKey), ConfigError);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("gh-client strips GH_TOKEN/GITHUB_TOKEN and computes primary/secondary rate-limit backoff", async () => {
  const clean = sanitizedEnv({ PATH: "/usr/bin", GH_TOKEN: "a", GITHUB_TOKEN: "b", KEEP: "yes" });
  assert.equal("GH_TOKEN" in clean, false);
  assert.equal("GITHUB_TOKEN" in clean, false);
  assert.equal(clean.NO_COLOR, "1");
  assert.equal(clean.KEEP, "yes");

  // Secondary rate limit without Retry-After defaults to +60s and doubles on repeats before aborting at maxFailures.
  const now = 1_700_000_000_000;
  const secondary = rateLimitOf({
    status: 403,
    headers: new Map(),
    body: { message: "You have exceeded a secondary rate limit." },
  }, [], now);
  assert.deepEqual(secondary, { kind: "secondary", notBefore: now + 60_000 });

  const backoff = createRateLimitBackoff({ interval: 60, maxFailures: 3, now: () => now });
  const first = backoff.onRateLimit({ kind: "secondary", notBefore: now + 30_000 });
  assert.equal(first.action, "wait");
  assert.equal(first.waitSeconds, 30);
  const second = backoff.onRateLimit({ kind: "secondary", notBefore: now + 30_000 });
  assert.equal(second.action, "wait");
  assert.equal(second.waitSeconds, 60);
  const third = backoff.onRateLimit({ kind: "secondary", notBefore: now + 30_000 });
  assert.equal(third.action, "abort");
  assert.equal(third.kind, "queryFailed");
  assert.match(third.message, /hit 3 secondary limits/);

  // Reset restores the budget after a successful read.
  backoff.reset();
  const afterReset = backoff.onRateLimit({ kind: "secondary", notBefore: now + 15_000 });
  assert.equal(afterReset.action, "wait");
  assert.equal(afterReset.waitSeconds, 15);

  // readTogether prefers terminal errors over retryable rate limits, and longest notBefore among rate limits.
  const shorter = new QueryError("rate 1", { retryable: true, rateLimit: { kind: "primary", notBefore: now + 10_000 } });
  const longer = new QueryError("rate 2", { retryable: true, rateLimit: { kind: "primary", notBefore: now + 90_000 } });
  await assert.rejects(readTogether([Promise.reject(shorter), Promise.reject(longer)]), (error) => error === longer);

  const terminal = new QueryError("not found", { retryable: false });
  await assert.rejects(readTogether([Promise.reject(longer), Promise.reject(terminal)]), (error) => error === terminal);
});

test("threads.mjs parses TARS, Greptile, and Cursor severity tags without matching ordinary prose", () => {
  const samples = [
    ["[blocks] Missing authorization guard", "blocks"],
    ["**blocks** — Missing authorization guard", "blocks"],
    ["`fix-if-cheap`: simplify map lookup", "fix-if-cheap"],
    ["### [next-action] Track follow-up in issue", "next-action"],
    ["**Severity:** Critical\nDetails here", "critical"],
    ["**Severity**: High", "high"],
    ["<!-- CURSOR_AUTOMATION_ID: 123 -->\n**Medium: Rate-limit wait floors on interval**", "medium"],
    ["🟡 **Low:** unused helper", "low"],
    ["Nit: prefer const over let", "nit"],
    ["<sub><b>[fix-if-cheap]</b></sub> Optional cleanup", "fix-if-cheap"],
  ];
  for (const [body, expected] of samples) {
    assert.equal(parseSeverity(body), expected, body);
  }
  assert.equal(new Set(samples.map(([, tag]) => tag)).size, SEVERITY_TAGS.length);

  // Ordinary prose mentioning severity words must not false-positive.
  for (const prose of [
    "This blocks the event loop under load.",
    "High throughput paths should avoid allocation.",
    "Use the existing indexed predicate.",
    "<b>P1</b> Résumé: this finding is long.",
  ]) {
    assert.equal(parseSeverity(prose), null, prose);
  }

  // Fallback to reply comments when root comment lacks a severity tag, and prefer originalCommit for head check.
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const normalized = normalizeThread({
    id: "PRRT_1",
    isResolved: false,
    isOutdated: true,
    path: "src/foo.ts",
    line: null,
    originalLine: 19,
    comments: {
      nodes: [
        {
          id: "PRRC_1",
          fullDatabaseId: "42",
          commit: { oid: head },
          originalCommit: { oid: old },
          author: { login: "reviewer" },
          body: "Please check error handling here.",
          url: "https://github.com/o/r/pull/1#discussion_r42",
          createdAt: "2026-11-20T00:00:00Z",
          outdated: true,
        },
        {
          id: "PRRC_2",
          fullDatabaseId: "43",
          commit: { oid: head },
          originalCommit: { oid: head },
          author: { login: "tars" },
          body: "Severity: blocks",
          url: "https://github.com/o/r/pull/1#discussion_r43",
          createdAt: "2026-11-20T00:05:00Z",
          outdated: false,
        },
      ],
    },
  }, head);
  assert.equal(normalized.shortCommit, "bbbbbbb");
  assert.equal(normalized.onHead, false);
  assert.equal(normalized.severity, "blocks");
  assert.equal(normalized.commentCount, 2);
  assert.equal(normalized.line, 19);
});

test("partitionChecks protects required and reviewer checks under --required-checks-only and fails closed otherwise", () => {
  const checks = [
    { name: "CI / required", workflow: null, state: "pending", detail: "in_progress" },
    { name: "TARS review", workflow: null, state: "failed", detail: "cancelled" },
    { name: "Deploy to Production", workflow: "Build & Deploy", state: "pending", detail: "waiting" },
    { name: "Canary", workflow: null, state: "failed", detail: "cancelled" },
    { name: "Staging", workflow: null, state: "failed", detail: "timed_out" },
  ];
  const buckets = partitionChecks(checks, {
    required: ["CI / required"],
    reviewerChecks: ["TARS review"],
    requiredChecksOnly: true,
  });
  assert.deepEqual(buckets.pending.map((c) => c.name), ["CI / required"]);
  assert.deepEqual(buckets.failed.map((c) => c.name), ["TARS review", "Staging"]);
  assert.deepEqual(buckets.ignored.map((c) => c.name), ["Deploy to Production", "Canary"]);

  // Fail-closed: without declared required checks or without --required-checks-only, nothing is ignored.
  const noRequired = partitionChecks(checks, {
    required: [],
    reviewerChecks: ["TARS review"],
    requiredChecksOnly: true,
  });
  assert.deepEqual(noRequired.ignored, []);
  assert.deepEqual(noRequired.pending.map((c) => c.name), ["CI / required", "Deploy to Production"]);

  const defaultMode = partitionChecks(checks, {
    required: ["CI / required"],
    reviewerChecks: ["TARS review"],
  });
  assert.deepEqual(defaultMode.ignored, []);
});
