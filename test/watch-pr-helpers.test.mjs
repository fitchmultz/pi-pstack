import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  QueryError,
  createGhClient,
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
  actionableThreads,
  formatVerdictThread,
  hasResurfacedReply,
  normalizeIssueComment,
  normalizeThread,
  parseSeverity,
  unaddressedIssueComments,
} from "../skills/watch-pr/scripts/threads.mjs";
import { partitionChecks, reviewerStates } from "../skills/watch-pr/scripts/verdict.mjs";

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

test("gh-client revalidates single-page REST reads with If-None-Match ETags and skips unsafe multi-page caches", async () => {
  const temp = mkdtempSync(join(tmpdir(), "gh-client-etag-"));
  try {
    const queueFile = join(temp, "responses.json");
    const logFile = join(temp, "calls.ndjson");
    const fakeGh = join(temp, "gh-fake");
    writeFileSync(fakeGh, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(argv) + "\\n");
const queue = JSON.parse(readFileSync(${JSON.stringify(queueFile)}, "utf8"));
const next = queue.shift();
writeFileSync(${JSON.stringify(queueFile)}, JSON.stringify(queue));
if (!next) throw new Error("No queued fake-gh response for " + JSON.stringify(argv));
for (const page of next.pages ?? []) {
  process.stdout.write("HTTP/2.0 " + page.status + " " + (page.status === 200 ? "OK" : page.status === 304 ? "Not Modified" : "Error") + "\\r\\n");
  for (const [k, v] of Object.entries(page.headers ?? {})) {
    process.stdout.write(k + ": " + v + "\\r\\n");
  }
  process.stdout.write("\\r\\n");
  if (page.body !== undefined) process.stdout.write(JSON.stringify(page.body) + "\\n");
}
if (next.stderr) process.stderr.write(next.stderr);
process.exit(next.code ?? 0);
`, { mode: 0o755 });

    const queue = (responses) => {
      writeFileSync(queueFile, JSON.stringify(responses));
      writeFileSync(logFile, "");
    };
    const readCalls = () => readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const headerArg = (argv) => {
      const idx = argv.indexOf("-H");
      return idx === -1 ? null : argv[idx + 1];
    };

    const client = createGhClient(fakeGh);

    // 1. Paginated single-page REST object: 200 caches ETag, 304 with exit 1 or 0 reuses cached body,
    //    refreshes rotated ETag from 304, isolates mutations, and 200 replaces cache.
    const runsPath = "repos/workos/alto/commits/abc/check-runs?per_page=100";
    queue([
      { pages: [{ status: 200, headers: { Etag: 'W/"v1"' }, body: { total_count: 1, check_runs: [{ id: 1, status: "in_progress" }] } }] },
      { code: 1, stderr: "unexpected end of JSON input\n", pages: [{ status: 304, headers: { Etag: '"v1-canonical"' } }] },
      { code: 0, stderr: "unexpected end of JSON input\n", pages: [{ status: 304, headers: {} }] },
      { pages: [{ status: 200, headers: { Etag: 'W/"v2"' }, body: { total_count: 1, check_runs: [{ id: 1, status: "completed" }] } }] },
      { code: 1, stderr: "unexpected end of JSON input\n", pages: [{ status: 304, headers: { Etag: 'W/"v2"' } }] },
    ]);

    const first = await client.rest(runsPath);
    assert.deepEqual(first, [{ total_count: 1, check_runs: [{ id: 1, status: "in_progress" }] }]);
    first[0].check_runs.push({ id: 999, status: "mutated" });

    const second = await client.rest(runsPath);
    assert.deepEqual(second, [{ total_count: 1, check_runs: [{ id: 1, status: "in_progress" }] }]);

    const third = await client.rest(runsPath);
    assert.deepEqual(third, [{ total_count: 1, check_runs: [{ id: 1, status: "in_progress" }] }]);

    const fourth = await client.rest(runsPath);
    assert.deepEqual(fourth, [{ total_count: 1, check_runs: [{ id: 1, status: "completed" }] }]);

    const fifth = await client.rest(runsPath);
    assert.deepEqual(fifth, [{ total_count: 1, check_runs: [{ id: 1, status: "completed" }] }]);

    assert.deepEqual(readCalls().map(headerArg), [
      null,
      'If-None-Match: W/"v1"',
      'If-None-Match: "v1-canonical"',
      'If-None-Match: "v1-canonical"',
      'If-None-Match: W/"v2"',
    ]);

    // 2. Non-paginated single object (watch-run run endpoint) caches ETag, and a 403 rate limit
    //    preserves the cached ETag while surfacing rateLimit metadata.
    const runPath = "repos/workos/tars/actions/runs/42";
    queue([
      { pages: [{ status: 200, headers: { Etag: 'W/"run-1"' }, body: { id: 42, status: "in_progress" } }] },
      {
        code: 1,
        stderr: "gh: API rate limit exceeded\n",
        pages: [{
          status: 403,
          headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1800000000" },
          body: { message: "API rate limit exceeded" },
        }],
      },
      { code: 1, stderr: "unexpected end of JSON input\n", pages: [{ status: 304, headers: { Etag: 'W/"run-1"' } }] },
    ]);

    assert.deepEqual(await client.rest(runPath, { paginate: false }), { id: 42, status: "in_progress" });
    await assert.rejects(
      () => client.rest(runPath, { paginate: false }),
      (error) => error instanceof QueryError && error.rateLimit?.kind === "primary",
    );
    assert.deepEqual(await client.rest(runPath, { paginate: false }), { id: 42, status: "in_progress" });
    assert.deepEqual(readCalls().map(headerArg), [
      null,
      'If-None-Match: W/"run-1"',
      'If-None-Match: W/"run-1"',
    ]);

    // 3. Multi-page responses and full-capacity bare arrays evict/skip ETag caching so page-2 updates are never masked.
    const commentsPath = "repos/workos/alto/issues/1/comments?per_page=2";
    queue([
      { pages: [{ status: 200, headers: { Etag: '"c1"' }, body: [{ id: 1 }] }] },
      // Grows to full page capacity (2 === per_page=2): must evict ETag.
      { pages: [{ status: 200, headers: { Etag: '"c2-full"' }, body: [{ id: 1 }, { id: 2 }] }] },
      // Next call must NOT send If-None-Match; grows to 2 pages -> still uncached.
      {
        pages: [
          { status: 200, headers: { Etag: '"c2-full"', Link: '<https://api.github.com/next>; rel="next"' }, body: [{ id: 1 }, { id: 2 }] },
          { status: 200, headers: { Etag: '"c3"' }, body: [{ id: 3 }] },
        ],
      },
      { pages: [{ status: 200, headers: { Etag: '"c1-again"' }, body: [{ id: 1 }] }] },
    ]);

    assert.deepEqual(await client.rest(commentsPath), [[{ id: 1 }]]);
    assert.deepEqual(await client.rest(commentsPath), [[{ id: 1 }, { id: 2 }]]);
    assert.deepEqual(await client.rest(commentsPath), [[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
    assert.deepEqual(await client.rest(commentsPath), [[{ id: 1 }]]);
    assert.deepEqual(readCalls().map(headerArg), [
      null,
      'If-None-Match: "c1"',
      null,
      null,
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("threads.mjs parses TARS, Greptile, and Cursor severity tags without matching ordinary prose", () => {
  const samples = [
    ["[blocks] Missing authorization guard", "blocks"],
    ["**blocks** — Missing authorization guard", "blocks"],
    ["**blocks · high**\nStill missing tenant check", "blocks"],
    ["blocks · high — Still missing tenant check", "blocks"],
    ["`fix-if-cheap`: simplify map lookup", "fix-if-cheap"],
    ["### [next-action] Track follow-up in issue", "next-action"],
    ["**Severity:** Critical\nDetails here", "critical"],
    ["**Severity**: High", "high"],
    ["<!-- CURSOR_AUTOMATION_ID: 123 -->\n**Medium: Rate-limit wait floors on interval**", "medium"],
    ["🟡 **Low:** unused helper", "low"],
    ["Nit: prefer const over let", "nit"],
    ["<sub><b>[fix-if-cheap]</b></sub> Optional cleanup", "fix-if-cheap"],
    ["<b>High</b> - unchecked cast", "high"],
    ["<strong>Critical</strong> — missing guard", "critical"],
    ['<a href="https://greptile.com"><img alt="P0" src="https://img.shields.io/badge/P0-red" /></a> Auth bypass', "p0"],
    ['<img src="https://img.shields.io/badge/P1-orange" alt="P1" /> Missing null check', "p1"],
    ["**P1** Missing null check on session", "p1"],
    ["<b>P1</b> Résumé: this finding is long.", "p1"],
    ["![P2](https://img.shields.io/badge/P2-yellow) Consider caching lookup", "p2"],
    ["P3: minor naming suggestion", "p3"],
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
    "We prioritize P1 incidents separately from P2 tasks.",
    '<img alt="Greptile logo" src="https://greptile.com/logo.png" /> Looks good now, fixed!',
  ]) {
    assert.equal(parseSeverity(prose), null, prose);
  }

  // Long punctuation dividers/tables must parse in linear time without backtracking hangs.
  const started = performance.now();
  for (const divider of [
    `${"*".repeat(40)} divider`,
    "-".repeat(80),
    `|${"-".repeat(60)}|`,
    `${"### ".repeat(20)}Heading`,
  ]) {
    assert.equal(parseSeverity(divider), null, divider);
  }
  assert.ok(performance.now() - started < 500, "parseSeverity took too long on punctuation dividers");

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

test("normalizeThread merges rootComment + comments(last:20) without dropping root metadata on >20-comment threads", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const root = {
    id: "PRRC_1",
    fullDatabaseId: "1001",
    commit: { oid: head },
    originalCommit: { oid: old },
    author: { __typename: "Bot", login: "greptile-apps" },
    body: '<img alt="P1" src="https://example.test/p1.svg" /> Initial P1 finding.',
    url: "https://github.com/o/r/pull/1#discussion_r1001",
    createdAt: "2026-11-20T00:00:00Z",
    outdated: true,
  };
  // Simulate 25 total comments: rootComment has #1, comments(last:20) has #6..#25.
  const tail = Array.from({ length: 20 }, (_, i) => {
    const idx = i + 6;
    const isLast = idx === 25;
    return {
      id: `PRRC_${idx}`,
      fullDatabaseId: String(1000 + idx),
      commit: { oid: head },
      originalCommit: { oid: head },
      author: isLast
        ? { __typename: "Bot", login: "tars-reviewer" }
        : { __typename: "User", login: "fitchmultz" },
      body: isLast ? "**blocks · high** Still missing tenant check after refactor." : `Follow-up ${idx}`,
      url: `https://github.com/o/r/pull/1#discussion_r${1000 + idx}`,
      createdAt: `2026-11-20T00:${String(idx).padStart(2, "0")}:00Z`,
      outdated: false,
    };
  });
  const longThread = normalizeThread({
    id: "PRRT_long",
    isResolved: true,
    isOutdated: false,
    path: "src/auth.ts",
    line: 88,
    rootComment: { nodes: [root] },
    comments: { totalCount: 25, nodes: tail },
  }, head, { prAuthor: "fitchmultz" });

  // Root metadata is preserved even though root fell out of comments(last:20).
  assert.equal(longThread.author, "greptile-apps");
  assert.equal(longThread.databaseId, "1001");
  assert.equal(longThread.originalCommit, old);
  assert.equal(longThread.url, "https://github.com/o/r/pull/1#discussion_r1001");
  assert.equal(longThread.commentCount, 25);
  assert.equal(longThread.comments.length, 21);
  assert.equal(longThread.latestComment.id, "PRRC_25");
  assert.equal(longThread.latestComment.author, "tars-reviewer");
  assert.equal(longThread.latestComment.severity, "blocks");
  assert.equal(longThread.hasNewReply, true);
  assert.equal(hasResurfacedReply(longThread, "fitchmultz"), true);

  // Verdict formatting shows the latest reply instead of the stale root comment.
  const line = formatVerdictThread(longThread);
  assert.match(line, /^  src\/auth\.ts:88 @tars-reviewer \[resolved, new reply\] \[aaaaaaa head, 2026-11-20T00:25:00Z, blocks\]: \*\*blocks · high\*\* Still missing tenant check/);

  // Short thread deduplicates rootComment when it overlaps with comments(last:20).
  const shortThread = normalizeThread({
    id: "PRRT_short",
    isResolved: true,
    path: "src/auth.ts",
    line: 88,
    rootComment: { nodes: [root] },
    comments: {
      totalCount: 2,
      nodes: [
        { ...root },
        {
          id: "PRRC_2",
          fullDatabaseId: "1002",
          commit: { oid: head },
          originalCommit: { oid: head },
          author: { __typename: "User", login: "fitchmultz" },
          body: "Fixed in latest commit.",
          url: "https://github.com/o/r/pull/1#discussion_r1002",
          createdAt: "2026-11-20T00:05:00Z",
          outdated: false,
        },
      ],
    },
  }, head, { prAuthor: "fitchmultz" });
  assert.equal(shortThread.comments.length, 2);
  assert.equal(shortThread.commentCount, 2);
  assert.equal(shortThread.hasNewReply, false);
  assert.deepEqual(actionableThreads([longThread, shortThread], { prAuthor: "fitchmultz" }).resurfaced.map((t) => t.id), ["PRRT_long"]);
});

test("unaddressedIssueComments skips automated Linear linkback and TARS summary bot comments", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const linearLinkback = normalizeIssueComment({
    id: "IC_linear_1",
    fullDatabaseId: "8001",
    author: { __typename: "Bot", login: "linear-code" },
    body: "<!-- linear-linkback -->\n<p>Linked issue description mentioning `fix-if-cheap` follow-up.</p>",
    url: "https://github.com/workos/tars/pull/2560#issuecomment-8001",
    createdAt: "2026-11-21T01:00:00Z",
    isMinimized: false,
  }, head);
  const tarsReviewSummary = normalizeIssueComment({
    id: "IC_tars_summary_1",
    fullDatabaseId: "8002",
    author: { __typename: "Bot", login: "workos-tars" },
    body: "<!-- tars-review:summary -->\n### Review summary\n- **blocks · medium** Check session token rotation",
    url: "https://github.com/workos/tars/pull/2560#issuecomment-8002",
    createdAt: "2026-11-21T01:01:00Z",
    isMinimized: false,
  }, head);
  const piTarsSummary = normalizeIssueComment({
    id: "IC_pi_tars_summary_1",
    fullDatabaseId: "8003",
    author: { __typename: "Bot", login: "workos-tars" },
    body: "<!-- pi-tars:review -->\n**blocks · medium**\nSummary updated for latest push.",
    url: "https://github.com/workos/tars/pull/2560#issuecomment-8003",
    createdAt: "2026-11-21T01:02:00Z",
    isMinimized: false,
  }, head);
  // Regular severity-tagged bot comments without those markers still block.
  const realBotFinding = normalizeIssueComment({
    id: "IC_real_bot_1",
    fullDatabaseId: "8004",
    author: { __typename: "Bot", login: "security-bot" },
    body: "**blocks · medium**\nMissing CSRF check on webhook endpoint.",
    url: "https://github.com/workos/tars/pull/2560#issuecomment-8004",
    createdAt: "2026-11-21T01:03:00Z",
    isMinimized: false,
  }, head);
  // Human comments mentioning a marker are still treated as human review comments.
  const humanMentioningMarker = normalizeIssueComment({
    id: "IC_human_marker_1",
    fullDatabaseId: "8005",
    author: { __typename: "User", login: "teammate" },
    body: "Can we also filter `<!-- linear-linkback -->` comments?",
    url: "https://github.com/workos/tars/pull/2560#issuecomment-8005",
    createdAt: "2026-11-21T01:04:00Z",
    isMinimized: false,
  }, head);

  assert.equal(linearLinkback.severity, "fix-if-cheap");
  assert.equal(tarsReviewSummary.severity, "blocks");
  assert.equal(piTarsSummary.severity, "blocks");
  assert.deepEqual(
    unaddressedIssueComments([linearLinkback, tarsReviewSummary, piTarsSummary], { prAuthor: "fitchmultz" }),
    [],
  );
  assert.deepEqual(
    unaddressedIssueComments(
      [linearLinkback, tarsReviewSummary, piTarsSummary, realBotFinding, humanMentioningMarker],
      { prAuthor: "fitchmultz" },
    ).map((comment) => comment.id),
    ["IC_real_bot_1", "IC_human_marker_1"],
  );
});

test("reviewerStates preserves check run links on failed and skipped reviewer checks", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const rules = [{ name: "TARS review", check: "TARS review" }];
  const failed = reviewerStates(rules, {
    head,
    checks: [{ name: "TARS review", state: "failed", detail: "failure", link: "https://github.com/workos/alto/runs/111" }],
    texts: [],
  });
  assert.deepEqual(failed, [{
    name: "TARS review",
    state: "rejected",
    text: "failure on aaaaaaa",
    link: "https://github.com/workos/alto/runs/111",
  }]);
  const skipped = reviewerStates(rules, {
    head,
    checks: [{ name: "TARS review", state: "skipped", detail: "neutral", link: "https://github.com/workos/alto/runs/222" }],
    texts: [],
  });
  assert.deepEqual(skipped, [{
    name: "TARS review",
    state: "rejected",
    text: "neutral on aaaaaaa, not a sign-off",
    link: "https://github.com/workos/alto/runs/222",
  }]);
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
