// Turns one observation of a pull request into the merge-readiness verdict:
// what the watcher decides, and the short block it prints last.

import { basename } from "node:path";
import { login } from "./gh-client.mjs";
import { actionableThreads, formatVerdictComment, formatVerdictThread, unaddressedIssueComments } from "./threads.mjs";
import { classifyWorkflow } from "./triggers.mjs";

/**
 * The block must arrive whole in a background_command completion notice,
 * which carries the last 20 lines and 2048 bytes of a failed job's output
 * (pi packages/coding-agent/src/extensions/background-command/index.ts).
 */
export const BLOCK_LINES = 20;
export const BLOCK_BYTES = 2048;
/** Characters of a review thread's first comment shown in the block. */
const THREAD_EXCERPT = 200;

export const EXIT = {
  ready: 0,
  conflicts: 2,
  threads: 3,
  failingChecks: 4,
  timeout: 5,
  mergeGate: 6,
  queryFailed: 7,
  reviewerRejected: 8,
  unknown: 9,
  usage: 64,
};

const short = (sha) => sha.slice(0, 7);
export const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
export const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export function some(names, max = 3) {
  return names.length > max ? `${names.slice(0, max).join(", ")} (+${names.length - max} more)` : names.join(", ");
}

function matchesCheckName(check, set) {
  if (set.has(check.name)) return true;
  if (check.workflow && set.has(`${check.workflow} / ${check.name}`)) return true;
  return false;
}

/**
 * Partitions checks into active buckets and `ignored` (non-required checks that
 * are `pending` or `cancelled` when `--required-checks-only` is active).
 *
 * Fail-closed rules:
 * - Required status checks from branch protection/rulesets and configured
 *   reviewer checks are NEVER ignored.
 * - A non-required check that explicitly fails (`failure`, `timed_out`,
 *   `action_required`, etc.) STILL counts as `failed`.
 * - `--required-checks-only` only classifies non-required checks as optional
 *   when GitHub actually declares at least one required status check.
 */
export function partitionChecks(checks, {
  required = [],
  reviewerChecks = [],
  requiredChecksOnly = false,
} = {}) {
  const protectedSet = new Set([...required, ...reviewerChecks]);
  const allowOptional = requiredChecksOnly && required.length > 0;
  const buckets = { passed: [], failed: [], pending: [], skipped: [], ignored: [] };
  for (const check of checks) {
    const isProtected = matchesCheckName(check, protectedSet);
    const isOptional = allowOptional && !isProtected;
    const isIgnorableState = check.state === "pending" || (check.state === "failed" && check.detail === "cancelled");
    if (isOptional && isIgnorableState) {
      buckets.ignored.push(check);
    } else if (check.state === "passed") {
      buckets.passed.push(check);
    } else if (check.state === "skipped") {
      buckets.skipped.push(check);
    } else if (check.state === "pending") {
      buckets.pending.push(check);
    } else {
      buckets.failed.push(check);
    }
  }
  return buckets;
}

/**
 * Which checks GitHub still owes this commit.
 *
 * - `workflows`: workflows that every push to this pull request starts.
 * - `required`: status checks that GitHub requires before a merge.
 * - `missingWorkflows`, `missingRequired`: those with no run or result on the commit.
 * - `undetermined`: workflows with branch or path filters and no run. They count
 *   as skipped only when another run of the same event exists on the commit,
 *   because GitHub creates the runs of one event together.
 * - `unreadable`: workflows whose triggers the watcher cannot read and that have no run.
 */
export function expectedChecks({ files, baseRef, runs, required, checks }) {
  const expected = { workflows: [], required, missingWorkflows: [], missingRequired: [], undetermined: [], unreadable: [] };
  for (const file of files) {
    const name = basename(file.path);
    const ran = runs.some((run) => run.path === file.path);
    const { kind, events } = file.text === null ? { kind: "unreadable", events: [] } : classifyWorkflow(file.text, baseRef);
    if (kind === "always") expected.workflows.push(name);
    if (ran || kind === "never") continue;
    if (kind === "always") expected.missingWorkflows.push(name);
    else if (kind === "unreadable") expected.unreadable.push(name);
    else if (!runs.some((run) => events.includes(run.event))) expected.undetermined.push(name);
  }
  expected.missingRequired = required.filter((name) => !checks.some((check) => check.name === name));
  return expected;
}

function missingText({ missingWorkflows, missingRequired }, { requiredChecksOnly = false } = {}) {
  const parts = [];
  if (!requiredChecksOnly && missingWorkflows.length) {
    parts.push(`no run of ${plural(missingWorkflows.length, "workflow")} (${some(missingWorkflows)})`);
  }
  if (missingRequired.length) parts.push(`${plural(missingRequired.length, "required check")} not reported (${some(missingRequired)})`);
  return parts.join("; ");
}

/**
 * State of each required reviewer on the head commit.
 *
 * `passed` is a sign-off on this commit. `pending` can still change without a
 * new push. `rejected` cannot. `unknown` means the rule could not be evaluated.
 *
 * @returns {{ name: string, state: "passed" | "pending" | "rejected" | "unknown", text: string, link?: string | null }[]}
 */
export function reviewerStates(rules, { head, checks, texts }) {
  return rules.map((rule) => {
    if (rule.check !== undefined) {
      const matching = checks.filter((check) => check.name === rule.check);
      const on = `on ${short(head)}`;
      if (matching.length === 0) return { name: rule.name, state: "pending", text: `not started ${on}` };
      const failed = matching.find((check) => check.state === "failed");
      if (failed) return { name: rule.name, state: "rejected", text: `${failed.detail} ${on}`, link: failed.link || null };
      if (matching.some((check) => check.state === "pending")) return { name: rule.name, state: "pending", text: `running ${on}` };
      const skipped = matching.find((check) => check.state === "skipped");
      if (skipped) return { name: rule.name, state: "rejected", text: `${skipped.detail} ${on}, not a sign-off`, link: skipped.link || null };
      return { name: rule.name, state: "passed", text: `passed ${on}` };
    }
    for (const text of texts) {
      if (text.author !== login(rule.author)) continue;
      const verdict = rule.verdict.exec(text.body)?.[1];
      if (verdict === undefined) continue;
      const commit = rule.commit.exec(text.body)?.[1] ?? text.commit;
      if (!commit) return { name: rule.name, state: "unknown", text: `${verdict}, but its text does not name a commit` };
      if (commit.length < 7 || !head.startsWith(commit)) {
        return { name: rule.name, state: "pending", text: `${verdict} on ${short(commit)}, not on this commit` };
      }
      return verdict === rule.pass
        ? { name: rule.name, state: "passed", text: `${verdict} on ${short(head)}` }
        : { name: rule.name, state: "rejected", text: `${verdict} on ${short(head)} (needs ${rule.pass})`, link: text.link || null };
    }
    return { name: rule.name, state: "pending", text: "no review found" };
  });
}

const blocked = (exitCode, reason) => ({ kind: "blocked", exitCode, reason });

/**
 * Decides what one observation means.
 *
 * Blockers the author must act on end the watch at once, in the order merge
 * conflicts, review threads, failed checks, requested changes, reviewer
 * rejection. Otherwise the watch continues while anything can still change.
 * READY needs every rule evaluated: what cannot be evaluated is `unknown`.
 *
 * `mergeWithoutApproval` is the user's statement that they may merge although
 * GitHub still requires an approving review. Without it that state blocks.
 *
 * `firstLook` is true the first time the watcher sees this commit. Missing
 * evidence then means "too early", not "unknown": GitHub creates workflow runs
 * a few seconds after a push.
 *
 * @returns {{ kind: "merged" | "ready" | "blocked" | "unknown" | "waiting", exitCode?: number, reason?: string, waiting?: string[] }}
 */
export function assess({
  facts,
  checks,
  expected,
  reviewers,
  mergeWithoutApproval,
  reviewerChecks = [],
  textReviewerRules = [],
  requiredChecksOnly = false,
}, { firstLook }) {
  if (facts.state === "MERGED") return { kind: "merged", exitCode: EXIT.ready };
  if (facts.state === "CLOSED") return blocked(EXIT.mergeGate, "pull request is closed without a merge");
  if (facts.mergeable === "CONFLICTING" || facts.mergeState === "DIRTY") {
    return blocked(EXIT.conflicts, `merge conflicts with ${facts.baseRef}`);
  }
  const threadState = actionableThreads(
    facts.allThreads ?? [...(facts.threads ?? []), ...(facts.resurfacedThreads ?? [])],
    { prAuthor: facts.author ?? null },
  );
  const unaddressedComments = unaddressedIssueComments(facts.issueComments ?? [], {
    prAuthor: facts.author ?? null,
    textReviewerRules,
  });
  if (threadState.all.length || unaddressedComments.length) {
    const reasons = [];
    if (threadState.unresolved.length) {
      reasons.push(plural(threadState.unresolved.length, "unresolved review thread"));
    }
    if (threadState.resurfaced.length) {
      reasons.push(
        threadState.resurfaced.length === 1
          ? "1 resolved review thread with a new reply"
          : `${threadState.resurfaced.length} resolved review threads with new replies`,
      );
    }
    if (unaddressedComments.length) {
      reasons.push(plural(unaddressedComments.length, "unaddressed PR comment"));
    }
    const reason = reasons.length === 1
      ? reasons[0]
      : `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}`;
    return blocked(EXIT.threads, reason);
  }

  const enforceRequiredOnly = requiredChecksOnly && expected.required.length > 0;
  const buckets = partitionChecks(checks, {
    required: expected.required,
    reviewerChecks,
    requiredChecksOnly,
  });

  if (buckets.failed.length) return blocked(EXIT.failingChecks, `${plural(buckets.failed.length, "check")} failed`);
  if (facts.reviewDecision === "CHANGES_REQUESTED") return blocked(EXIT.mergeGate, "a reviewer requested changes");
  const rejected = reviewers.find((reviewer) => reviewer.state === "rejected");
  if (rejected) return blocked(EXIT.reviewerRejected, `${rejected.name} did not sign off: ${rejected.text}`);
  if (requiredChecksOnly && expected.required.length === 0) {
    return {
      kind: "unknown",
      exitCode: EXIT.unknown,
      reason: `--required-checks-only requested, but GitHub declares no required status checks for ${facts.baseRef}`,
    };
  }

  const absent = [];
  if (!enforceRequiredOnly && expected.undetermined.length) {
    absent.push(`cannot tell whether ${some(expected.undetermined)} ${expected.undetermined.length === 1 ? "was" : "were"} skipped by filters or ${expected.undetermined.length === 1 ? "has" : "have"} not started`);
  }
  if (checks.length === 0 && expected.workflows.length + expected.required.length === 0) {
    absent.push("no checks on this commit, and nothing says whether any are expected");
  }

  const waiting = [];
  if (buckets.pending.length) waiting.push(`${plural(buckets.pending.length, "check")} pending`);
  const missing = missingText(expected, { requiredChecksOnly: enforceRequiredOnly });
  if (missing) waiting.push(missing);
  if (facts.mergeable === "UNKNOWN" || facts.mergeState === "UNKNOWN") waiting.push("GitHub is still computing mergeability");
  if (!facts.isDraft) {
    for (const reviewer of reviewers) if (reviewer.state === "pending") waiting.push(`${reviewer.name}: ${reviewer.text}`);
  }
  if (waiting.length) return { kind: "waiting", waiting };
  if (firstLook && absent.length) return { kind: "waiting", waiting: ["checks may not have registered yet"] };

  if (facts.isDraft) return blocked(EXIT.mergeGate, "pull request is a draft");
  if (facts.mergeState === "BEHIND") return blocked(EXIT.mergeGate, `head branch is behind ${facts.baseRef}`);
  if (facts.reviewDecision === "REVIEW_REQUIRED" && !mergeWithoutApproval) {
    return blocked(EXIT.mergeGate, "GitHub requires an approving review");
  }
  const unknown = [
    ...(!enforceRequiredOnly ? expected.unreadable.map((name) => `cannot read the triggers of ${name}`) : []),
    ...absent,
    ...reviewers.filter((reviewer) => reviewer.state === "unknown").map((reviewer) => `${reviewer.name}: ${reviewer.text}`),
  ];
  if (facts.mergeState === "BLOCKED" && facts.reviewDecision !== "REVIEW_REQUIRED") {
    unknown.push("GitHub blocks the merge and the watcher found no cause");
  }
  if (unknown.length) return { kind: "unknown", exitCode: EXIT.unknown, reason: unknown.join("; ") };
  return { kind: "ready", exitCode: EXIT.ready };
}

/** The outcome when the watch stops while it is still waiting. */
export function stillWaiting(waiting, why) {
  return blocked(EXIT.timeout, `${why}; waiting for: ${waiting.join("; ")}`);
}

function headline(outcome) {
  if (outcome.kind === "ready") return "READY";
  if (outcome.kind === "merged") return "MERGED";
  return clip(`${outcome.kind === "unknown" ? "UNKNOWN" : "BLOCKED"}: ${outcome.reason}`, 400);
}

function expectedLine(expected, { requiredChecksOnly = false } = {}) {
  if (requiredChecksOnly && expected.required.length === 0) {
    return "expected checks: none declared (required by --required-checks-only)";
  }
  const enforceRequiredOnly = requiredChecksOnly && expected.required.length > 0;
  const missing = missingText(expected, { requiredChecksOnly: enforceRequiredOnly });
  if (missing) return `expected checks: not registered: ${missing}`;
  if (enforceRequiredOnly) {
    return `expected checks: all required present (${plural(expected.required.length, "required check")}; --required-checks-only)`;
  }
  const unknown = [...expected.undetermined, ...expected.unreadable];
  if (unknown.length) return `expected checks: unknown for ${some(unknown)} (no run on this commit)`;
  const known = [];
  if (expected.workflows.length) known.push(`${plural(expected.workflows.length, "workflow")} that every push starts`);
  if (expected.required.length) known.push(plural(expected.required.length, "required check"));
  return known.length ? `expected checks: all present (${known.join(", ")})`
    : "expected checks: none known (no required status checks, no workflow that every push starts)";
}

function mergeLine(facts, mergeWithoutApproval) {
  const parts = [facts.mergeable, `GitHub merge state ${facts.mergeState}`];
  parts.push(`review decision ${facts.reviewDecision ?? "none"}${
    facts.reviewDecision === "REVIEW_REQUIRED" && mergeWithoutApproval ? " (configuration allows a merge without approval)" : ""}`);
  if (facts.isDraft) parts.push("draft");
  return `merge: ${parts.join("; ")}`;
}

const bytes = (text) => Buffer.byteLength(text);
function clipBytes(text, max) {
  if (bytes(text) <= max) return text;
  let end = text.length;
  while (bytes(text.slice(0, end)) > max - 3) end--;
  return `${text.slice(0, end)}\u2026`;
}

/** Renders a bounded verdict block fitting within BLOCK_LINES lines and BLOCK_BYTES bytes. */
export function formatBoundedBlock(top, parts, { order = parts, bottom = [] } = {}) {
  const build = (shown) => [
    ...top,
    ...order.flatMap((part) => {
      const visible = shown.get(part);
      return [
        ...part.before,
        ...part.items.slice(0, visible),
        ...(visible < part.items.length ? [`  ... ${part.items.length - visible} more ${part.more}`] : []),
      ];
    }),
    ...bottom,
  ];
  const fits = (lines) => lines.length <= BLOCK_LINES && bytes(lines.join("\n")) < BLOCK_BYTES;
  const shown = new Map(parts.map((part) => [part, 0]));
  for (let grew = true; grew;) {
    grew = false;
    for (const part of parts) {
      if (shown.get(part) === part.items.length) continue;
      shown.set(part, shown.get(part) + 1);
      if (fits(build(shown))) grew = true;
      else shown.set(part, shown.get(part) - 1);
    }
  }
  let lines = build(shown);
  // Without any item the block has at most 12 lines; 100 bytes each always fit.
  for (let width = 400; !fits(lines) && width >= 60; width -= 100) {
    lines = lines.map((line) => clipBytes(line, width));
  }
  if (lines.length > BLOCK_LINES) lines = lines.slice(0, BLOCK_LINES);
  return `${lines.join("\n")}\n`;
}

/**
 * The verdict block: at most BLOCK_LINES lines and BLOCK_BYTES bytes, newline included.
 *
 * Reviewers, failed checks and review threads are listed while they fit; the rest is counted.
 *
 * @param {object} view
 * @param {{ owner: string, repo: string, number: number }} view.pr
 * @param {string | null} view.startHead Head commit when the watch began.
 * @param {string} view.configPath Shown when no reviewer rule applies.
 */
export function render({
  pr,
  startHead,
  configPath,
  facts,
  checks,
  expected,
  reviewers,
  mergeWithoutApproval,
  reviewerChecks = [],
  textReviewerRules = [],
  requiredChecksOnly = false,
}, outcome) {
  const head = facts.head;
  const top = [headline(outcome), `pr: ${facts.url}`];
  if (facts.state !== "OPEN") {
    top.push(facts.state === "MERGED"
      ? `commit: ${head} merged at ${facts.mergedAt}${facts.mergeCommit ? ` as ${short(facts.mergeCommit)}` : ""}`
      : `commit: ${head}`);
    return `${top.join("\n")}\n`;
  }
  top.push(`commit: ${head} (${startHead === head
    ? "head did not move during this watch" : `head moved during this watch; it started on ${short(startHead)}`})`);
  const buckets = partitionChecks(checks, {
    required: expected.required,
    reviewerChecks,
    requiredChecksOnly,
  });
  const countParts = [
    `${buckets.passed.length} passed`,
    `${buckets.failed.length} failed`,
    `${buckets.pending.length} pending`,
    `${buckets.skipped.length} skipped`,
    ...(buckets.ignored.length ? [`${buckets.ignored.length} optional`] : []),
  ];
  top.push(`checks on ${short(head)}: ${countParts.join(", ")}`);
  const pendingNames = buckets.pending.map((check) => check.name);
  const ignoredLabels = buckets.ignored.map((check) => `${check.name} (${check.detail})`);
  const unaddressedComments = unaddressedIssueComments(facts.issueComments ?? [], {
    prAuthor: facts.author ?? null,
    textReviewerRules,
  });
  const threadState = actionableThreads(
    facts.allThreads ?? [...(facts.threads ?? []), ...(facts.resurfacedThreads ?? [])],
    { prAuthor: facts.author ?? null },
  );
  const threadHeading = threadState.resurfaced.length
    ? `unresolved review threads: ${threadState.unresolved.length} (+${threadState.resurfaced.length} resolved with new ${threadState.resurfaced.length === 1 ? "reply" : "replies"})`
    : `unresolved review threads: ${threadState.unresolved.length}`;
  // Each part is a heading, then items that are shown while the block fits.
  const parts = [
    {
      items: reviewers.map((reviewer) => {
        const base = clip(`  ${reviewer.name}: ${reviewer.text}`, 200);
        return reviewer.state === "rejected" && reviewer.link ? `${base} ${reviewer.link}` : base;
      }),
      before: [
        ...(pendingNames.length ? [clip(`  pending: ${some(pendingNames)}`, 300)] : []),
        ...(ignoredLabels.length ? [clip(`  optional (ignored): ${some(ignoredLabels)}`, 300)] : []),
        clip(expectedLine(expected, { requiredChecksOnly }), 400),
        reviewers.length ? "reviewers:" : `reviewers: no rule for ${pr.owner}/${pr.repo} in ${configPath}`,
      ],
      more: "reviewers",
    },
    {
      items: buckets.failed
        .map((check) => `  failed: ${clip(check.name, 80)} (${check.detail}) ${check.link}`),
      before: [],
      more: "failed checks",
    },
    {
      items: threadState.all.map((thread) => formatVerdictThread(thread, THREAD_EXCERPT)),
      before: [threadHeading],
      more: "threads",
    },
    ...(unaddressedComments.length ? [{
      items: unaddressedComments.map((comment) => formatVerdictComment(comment, THREAD_EXCERPT)),
      before: [`unaddressed PR comments: ${unaddressedComments.length}`],
      more: "PR comments",
    }] : []),
  ];
  // Failed checks belong under the checks line, so they are printed first.
  return formatBoundedBlock(top, parts, {
    order: [parts[1], parts[0], parts[2], ...(parts[3] ? [parts[3]] : [])],
    bottom: [mergeLine(facts, mergeWithoutApproval)],
  });
}
