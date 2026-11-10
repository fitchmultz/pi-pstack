// Turns one observation of a pull request into the merge-readiness verdict:
// what the watcher decides, and the short block it prints last.

import { basename } from "node:path";
import { login } from "./github.mjs";
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
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
function some(names, max = 3) {
  return names.length > max ? `${names.slice(0, max).join(", ")} (+${names.length - max} more)` : names.join(", ");
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

function missingText({ missingWorkflows, missingRequired }) {
  const parts = [];
  if (missingWorkflows.length) parts.push(`no run of ${plural(missingWorkflows.length, "workflow")} (${some(missingWorkflows)})`);
  if (missingRequired.length) parts.push(`${plural(missingRequired.length, "required check")} not reported (${some(missingRequired)})`);
  return parts.join("; ");
}

/**
 * State of each required reviewer on the head commit.
 *
 * `passed` is a sign-off on this commit. `pending` can still change without a
 * new push. `rejected` cannot. `unknown` means the rule could not be evaluated.
 *
 * @returns {{ name: string, state: "passed" | "pending" | "rejected" | "unknown", text: string }[]}
 */
export function reviewerStates(rules, { head, checks, texts }) {
  return rules.map((rule) => {
    if (rule.check !== undefined) {
      const matching = checks.filter((check) => check.name === rule.check);
      const on = `on ${short(head)}`;
      if (matching.length === 0) return { name: rule.name, state: "pending", text: `not started ${on}` };
      const failed = matching.find((check) => check.state === "failed");
      if (failed) return { name: rule.name, state: "rejected", text: `${failed.detail} ${on}` };
      if (matching.some((check) => check.state === "pending")) return { name: rule.name, state: "pending", text: `running ${on}` };
      const skipped = matching.find((check) => check.state === "skipped");
      if (skipped) return { name: rule.name, state: "rejected", text: `${skipped.detail} ${on}, not a sign-off` };
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
        : { name: rule.name, state: "rejected", text: `${verdict} on ${short(head)} (needs ${rule.pass})` };
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
export function assess({ facts, checks, expected, reviewers, mergeWithoutApproval }, { firstLook }) {
  if (facts.state === "MERGED") return { kind: "merged", exitCode: EXIT.ready };
  if (facts.state === "CLOSED") return blocked(EXIT.mergeGate, "pull request is closed without a merge");
  if (facts.mergeable === "CONFLICTING" || facts.mergeState === "DIRTY") {
    return blocked(EXIT.conflicts, `merge conflicts with ${facts.baseRef}`);
  }
  if (facts.threads.length) return blocked(EXIT.threads, plural(facts.threads.length, "unresolved review thread"));
  const failed = checks.filter((check) => check.state === "failed");
  if (failed.length) return blocked(EXIT.failingChecks, `${plural(failed.length, "check")} failed`);
  if (facts.reviewDecision === "CHANGES_REQUESTED") return blocked(EXIT.mergeGate, "a reviewer requested changes");
  const rejected = reviewers.find((reviewer) => reviewer.state === "rejected");
  if (rejected) return blocked(EXIT.reviewerRejected, `${rejected.name} did not sign off: ${rejected.text}`);

  const absent = [];
  if (expected.undetermined.length) {
    absent.push(`cannot tell whether ${some(expected.undetermined)} ${expected.undetermined.length === 1 ? "was" : "were"} skipped by filters or ${expected.undetermined.length === 1 ? "has" : "have"} not started`);
  }
  if (checks.length === 0 && expected.workflows.length + expected.required.length === 0) {
    absent.push("no checks on this commit, and nothing says whether any are expected");
  }

  const waiting = [];
  const pending = checks.filter((check) => check.state === "pending");
  if (pending.length) waiting.push(`${plural(pending.length, "check")} pending`);
  const missing = missingText(expected);
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
    ...expected.unreadable.map((name) => `cannot read the triggers of ${name}`),
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

function expectedLine(expected) {
  const missing = missingText(expected);
  if (missing) return `expected checks: not registered: ${missing}`;
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
export function render({ pr, startHead, configPath, facts, checks, expected, reviewers, mergeWithoutApproval }, outcome) {
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
  const count = (state) => checks.filter((check) => check.state === state).length;
  top.push(`checks on ${short(head)}: ${count("passed")} passed, ${count("failed")} failed, ${count("pending")} pending, ${count("skipped")} skipped`);
  const pending = checks.filter((check) => check.state === "pending").map((check) => check.name);
  // Each part is a heading, then items that are shown while the block fits.
  const parts = [
    {
      items: reviewers.map((reviewer) => clip(`  ${reviewer.name}: ${reviewer.text}`, 200)),
      before: [
        ...(pending.length ? [clip(`  pending: ${some(pending)}`, 300)] : []),
        clip(expectedLine(expected), 400),
        reviewers.length ? "reviewers:" : `reviewers: no rule for ${pr.owner}/${pr.repo} in ${configPath}`,
      ],
      more: "reviewers",
    },
    {
      items: checks.filter((check) => check.state === "failed")
        .map((check) => `  failed: ${clip(check.name, 80)} (${check.detail}) ${check.link}`),
      before: [],
      more: "failed checks",
    },
    {
      items: facts.threads.map((thread) =>
        `  ${thread.path ?? "(no file)"}:${thread.line ?? "?"} @${thread.author ?? "unknown"}: ${
          clip(thread.body.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(), THREAD_EXCERPT)}`),
      before: [`unresolved review threads: ${facts.threads.length}`],
      more: "threads",
    },
  ];
  // Failed checks belong under the checks line, so they are printed first.
  const order = [parts[1], parts[0], parts[2]];
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
    mergeLine(facts, mergeWithoutApproval),
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
  for (let width = 400; !fits(lines); width -= 100) lines = lines.map((line) => clipBytes(line, width));
  return `${lines.join("\n")}\n`;
}
