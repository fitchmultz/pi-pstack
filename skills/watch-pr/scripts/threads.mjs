// Review thread normalization, severity tag parsing, and formatting shared by
// `github.mjs`, `verdict.mjs`, and `pr-threads.mjs`.

import { login } from "./gh-client.mjs";

export const SEVERITY_TAGS = Object.freeze([
  "blocks",
  "fix-if-cheap",
  "next-action",
  "critical",
  "high",
  "medium",
  "low",
  "nit",
]);

const TAG_ALT = SEVERITY_TAGS.join("|");
const EXPLICIT_LABEL = new RegExp(
  `(?:^|[\\s(\\[*_>])(?:severity|priority|level|class|verdict|category|tag)[*_\`\\s]{0,8}[:=][*_\`\\[\\]()\\s]{0,8}(${TAG_ALT})(?![a-z0-9-])`,
  "i",
);
const BRACKET_TAG = new RegExp(`\\[(${TAG_ALT})\\]`, "i");
const LINE_START_MARKUP = new RegExp(
  `^[^\\w\\n]{0,24}(?:\\*\\*|__|\`)\\s*(${TAG_ALT})(?![a-z0-9-])\\s*(?:[:—–\\-|]|(?:\\*\\*|__|\`)(?:\\s*[:—–\\-|]|\\s|$))`,
  "im",
);
const LINE_START_COLON = new RegExp(
  `^[^\\w\\n]{0,24}(${TAG_ALT})\\s*:`,
  "im",
);
const COMPOUND_TAG = /(?:`|\*\*|__)(fix-if-cheap|next-action)(?:`|\*\*|__)/i;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Strips HTML comments and tags and collapses whitespace for single-line display. */
export function cleanSnippet(body, maxLength = 200) {
  const cleaned = (body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clip(cleaned, maxLength);
}

/**
 * Extracts a TARS, Greptile, or Cursor severity tag from comment markdown/HTML.
 * Matches structured labels/prefixes rather than arbitrary prose words.
 *
 * @param {string} body
 * @returns {string | null}
 */
export function parseSeverity(body) {
  if (!body) return null;
  const plain = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:b|strong)\b[^>]*>/gi, "**")
    .replace(/<[^>]*>/g, "");
  for (const pattern of [EXPLICIT_LABEL, BRACKET_TAG, LINE_START_MARKUP, LINE_START_COLON, COMPOUND_TAG]) {
    const match = pattern.exec(plain);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}

function sameCommit(a, b) {
  if (!a || !b) return false;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Normalizes a GraphQL `PullRequestReviewThread` node into a flat record with
 * commit SHA, head comparison, parsed severity, and comment metadata.
 */
export function normalizeThread(node, headSha = null) {
  const rawComments = node.comments?.nodes ?? [];
  const comments = rawComments.map((comment) => ({
    id: comment.id ?? null,
    databaseId: comment.fullDatabaseId ?? comment.databaseId ?? null,
    commit: comment.commit?.oid ?? null,
    originalCommit: comment.originalCommit?.oid ?? null,
    author: comment.author?.login ?? null,
    body: comment.body ?? "",
    url: comment.url ?? null,
    createdAt: comment.createdAt ?? null,
    isOutdated: Boolean(comment.outdated ?? comment.isOutdated ?? false),
  }));
  const first = comments[0];
  // Prefer originalCommit so an un-rebased comment still shows the commit it
  // was authored on rather than a newer commit the diff hunk slid onto.
  const commitOid = first?.originalCommit ?? first?.commit ?? null;
  let severity = null;
  for (const comment of comments) {
    severity = parseSeverity(comment.body);
    if (severity) break;
  }
  return {
    id: node.id ?? null,
    isResolved: Boolean(node.isResolved),
    isOutdated: Boolean(node.isOutdated ?? first?.isOutdated ?? false),
    path: node.path ?? null,
    line: node.line ?? node.originalLine ?? null,
    author: first?.author ?? null,
    body: first?.body ?? "",
    url: first?.url ?? null,
    createdAt: first?.createdAt ?? null,
    commentId: first?.id ?? null,
    databaseId: first?.databaseId ?? null,
    commit: first?.commit ?? null,
    originalCommit: first?.originalCommit ?? null,
    commitOid,
    shortCommit: commitOid ? commitOid.slice(0, 7) : null,
    onHead: sameCommit(commitOid, headSha),
    severity,
    commentCount: comments.length,
    comments,
  };
}

/**
 * Formats one unresolved thread line for `watch-pr`'s compact 20-line verdict block.
 * Keeps metadata concise: `[<sha> head|older, <severity>]` when present.
 */
export function formatVerdictThread(thread, maxExcerpt = 200) {
  const tags = [];
  if (thread.shortCommit) tags.push(`${thread.shortCommit} ${thread.onHead ? "head" : "older"}`);
  if (thread.severity) tags.push(thread.severity);
  const meta = tags.length ? ` [${tags.join(", ")}]` : "";
  return `  ${thread.path ?? "(no file)"}:${thread.line ?? "?"} @${thread.author ?? "unknown"}${meta}: ${cleanSnippet(thread.body, maxExcerpt)}`;
}

const ATTRIBUTION_LINE = /^\s*(?:—|–|--)\s*Attributed to\s+([^\n]+?)\s*$/m;
const REVIEW_FLAG_LEADING = /^\s*Review flag\b(?:\s+on\s+head\s+([0-9a-f]{7,40}))?/i;

/** Removes Markdown blockquote lines (`> ...`) so quoted text is not misread as a new flag. */
function stripBlockquotes(body) {
  return (body ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}

/** Normalizes a GraphQL PR conversation (`IssueComment`) node. */
export function normalizeIssueComment(node, headSha = null) {
  const body = node.body ?? "";
  const unquoted = stripBlockquotes(body);
  const attribution = ATTRIBUTION_LINE.exec(unquoted)?.[1]?.trim() ?? null;
  const flagMatch = REVIEW_FLAG_LEADING.exec(unquoted);
  const commitOid = flagMatch?.[1]?.toLowerCase() ?? null;
  const isReviewFlag = Boolean(attribution || flagMatch);
  const author = node.author?.login ?? null;
  const authorType = node.author?.__typename ?? null;
  const isBot = authorType === "Bot" || Boolean(author && /\[bot\]$/i.test(author));
  return {
    id: node.id ?? null,
    databaseId: node.fullDatabaseId ?? node.databaseId ?? null,
    author,
    authorType,
    isBot,
    body,
    url: node.url ?? null,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? node.createdAt ?? null,
    isMinimized: Boolean(node.isMinimized),
    attribution,
    isReviewFlag,
    commitOid,
    shortCommit: commitOid ? commitOid.slice(0, 7) : null,
    onHead: sameCommit(commitOid, headSha),
    severity: parseSeverity(unquoted),
  };
}

function isConfiguredTextReviewerComment(comment, textReviewerRules) {
  const author = login(comment.author);
  return textReviewerRules.some(
    (rule) => login(rule.author) === author && rule.verdict.test(comment.body),
  );
}

function isActionableIssueComment(comment, prAuthor, textReviewerRules) {
  if (comment.isMinimized || !comment.body.trim()) return false;
  if (isConfiguredTextReviewerComment(comment, textReviewerRules)) return false;
  if (comment.isReviewFlag) return true;
  if (!comment.author) return false;
  if (comment.isBot) return comment.severity !== null;
  return Boolean(prAuthor) && login(comment.author) !== login(prAuthor);
}

function isReplyComment(comment, prAuthor, textReviewerRules) {
  if (comment.isMinimized || !stripBlockquotes(comment.body)) return false;
  if (comment.isReviewFlag) return false;
  if (isConfiguredTextReviewerComment(comment, textReviewerRules)) return false;
  if (comment.isBot) return false;
  return !prAuthor || login(comment.author) === login(prAuthor);
}

const normalizeMatchText = (text) => (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function blockquoteLines(body) {
  return (body ?? "")
    .split(/\r?\n/)
    .map((line) => /^\s*>\s?(.*)$/.exec(line)?.[1]?.trim() ?? null)
    .filter(Boolean);
}

function replyLinksComment(reply, target) {
  const body = reply.body ?? "";
  if (target.url && body.includes(target.url)) return true;
  if (target.databaseId) {
    const escapedId = String(target.databaseId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`#issuecomment-${escapedId}(?!\\d)`, "i").test(body)) return true;
  }
  return false;
}

function quoteMatchesComment(quotes, target) {
  if (quotes.length === 0) return false;
  const targetText = normalizeMatchText(stripBlockquotes(target.body));
  if (!targetText) return false;
  const minLength = Math.min(targetText.length, 12);
  if (quotes.some((quote) => quote.length >= minLength && targetText.includes(quote))) return true;
  const joined = quotes.join(" ");
  return joined.length >= minLength && targetText.includes(joined);
}

/**
 * Returns true when a later PR-author reply explicitly links to `target`
 * (`#issuecomment-<id>` or its URL) or uniquely quotes substantive text from
 * `target` (an ambiguous quote matching multiple earlier actionable comments
 * clears none of them).
 */
function replyReferencesComment(reply, target, earlierActionable) {
  if (replyLinksComment(reply, target)) return true;
  const quotes = blockquoteLines(reply.body).map(normalizeMatchText).filter(Boolean);
  if (!quoteMatchesComment(quotes, target)) return false;
  return earlierActionable.every((other) => other === target || !quoteMatchesComment(quotes, other));
}

/**
 * Returns PR conversation comments that still need attention:
 * - Attributed review flags (such as Grok Bot) remain unaddressed until
 *   minimized (`isMinimized: true`, e.g. via `pr-threads.mjs --resolve IC_...`),
 *   so an unrelated reply comment cannot silently clear earlier flags.
 * - Human reviewer comments (from someone other than the PR author) and bot
 *   findings carrying a severity tag remain unaddressed until either minimized
 *   or explicitly referenced (linked or uniquely quoted) by a later non-flag
 *   PR-author reply. A general reply like "thanks, looking" does not clear them.
 */
export function unaddressedIssueComments(comments, { prAuthor = null, textReviewerRules = [] } = {}) {
  if (!Array.isArray(comments) || comments.length === 0) return [];
  const ordered = comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => {
      const ta = a.comment.createdAt ?? "";
      const tb = b.comment.createdAt ?? "";
      return ta === tb ? a.index - b.index : ta < tb ? -1 : 1;
    })
    .map(({ comment }) => comment);

  const actionableIndices = new Set();
  for (let i = 0; i < ordered.length; i++) {
    if (isActionableIssueComment(ordered[i], prAuthor, textReviewerRules)) actionableIndices.add(i);
  }

  const unaddressed = [];
  for (let i = 0; i < ordered.length; i++) {
    if (!actionableIndices.has(i)) continue;
    const comment = ordered[i];
    if (comment.isReviewFlag) {
      unaddressed.push(comment);
      continue;
    }
    const addressed = ordered
      .slice(i + 1)
      .some((later, offset) => {
        if (!isReplyComment(later, prAuthor, textReviewerRules)) return false;
        const laterIndex = i + 1 + offset;
        const earlierActionable = [];
        for (let j = 0; j < laterIndex; j++) {
          if (actionableIndices.has(j) && !ordered[j].isReviewFlag) earlierActionable.push(ordered[j]);
        }
        return replyReferencesComment(later, comment, earlierActionable);
      });
    if (!addressed) unaddressed.push(comment);
  }
  return unaddressed;
}

/** Formats one unaddressed PR conversation comment for `watch-pr`'s verdict block. */
export function formatVerdictComment(comment, maxExcerpt = 200) {
  const who = comment.attribution
    ? `@${comment.author ?? "unknown"} (${comment.attribution})`
    : `@${comment.author ?? "unknown"}`;
  const tags = [];
  if (comment.shortCommit) tags.push(`${comment.shortCommit} ${comment.onHead ? "head" : "older"}`);
  if (comment.severity) tags.push(comment.severity);
  const meta = tags.length ? ` [${tags.join(", ")}]` : "";
  return `  PR comment ${who}${meta}: ${cleanSnippet(comment.body, maxExcerpt)}`;
}

/** Formats the detailed thread (and unaddressed PR comment) list for `pr-threads.mjs --list`. */
export function formatThreadList({ url, head, threads, comments = [], includeResolved = false }) {
  const lines = [
    `pr: ${url}`,
    `head: ${head}`,
    `${includeResolved ? "threads" : "unresolved threads"}: ${threads.length}`,
  ];
  if (comments.length) {
    lines.push(`${includeResolved ? "PR comments" : "unaddressed PR comments"}: ${comments.length}`);
  }
  for (const thread of threads) {
    const location = `${thread.path ?? "(no file)"}:${thread.line ?? "?"}`;
    const commitLabel = thread.shortCommit
      ? `${thread.shortCommit} (${thread.onHead ? "head" : "older"}${thread.isOutdated ? ", outdated" : ""})`
      : thread.isOutdated ? "(outdated)" : "(no commit)";
    const parts = [
      thread.id ?? "(no id)",
      location,
      `@${thread.author ?? "unknown"}`,
      commitLabel,
    ];
    if (thread.severity) parts.push(`[${thread.severity}]`);
    if (includeResolved && thread.isResolved) parts.push("[resolved]");
    if (thread.commentCount > 1) parts.push(`(${thread.commentCount} comments)`);
    lines.push("");
    lines.push(parts.join("  "));
    if (thread.url) lines.push(`  url: ${thread.url}`);
    lines.push(`  snippet: ${cleanSnippet(thread.body, 240)}`);
  }
  for (const comment of comments) {
    const parts = [
      comment.id ?? "(no id)",
      "PR comment",
      comment.attribution ? `@${comment.author ?? "unknown"} (${comment.attribution})` : `@${comment.author ?? "unknown"}`,
    ];
    if (comment.shortCommit) parts.push(`${comment.shortCommit} (${comment.onHead ? "head" : "older"})`);
    if (comment.severity) parts.push(`[${comment.severity}]`);
    lines.push("");
    lines.push(parts.join("  "));
    if (comment.url) lines.push(`  url: ${comment.url}`);
    lines.push(`  snippet: ${cleanSnippet(comment.body, 240)}`);
  }
  return `${lines.join("\n")}\n`;
}
