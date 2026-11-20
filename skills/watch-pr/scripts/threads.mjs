// Review thread normalization, severity tag parsing, and formatting shared by
// `github.mjs`, `verdict.mjs`, and `pr-threads.mjs`.

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
  `(?:^|[\\s(\\[*_>])(?:severity|priority|level|class|verdict|category|tag)(?:<[^>]+>|[*_\`\\s])*[:=](?:<[^>]+>|[*_\`\\[\\]()\\s])*(${TAG_ALT})(?![a-z0-9-])`,
  "i",
);
const BRACKET_TAG = new RegExp(`\\[(${TAG_ALT})\\]`, "i");
const LINE_START_MARKUP = new RegExp(
  `^\\s*(?:(?:<[^>]+>|[#>*•\\-]+|[^\\w\\s]{1,4})\\s*)*(?:\\*\\*|__|<b>|<strong>|\`)\\s*(${TAG_ALT})(?![a-z0-9-])\\s*(?:[:—–\\-|]|(?:\\*\\*|__|<\\/b>|<\\/strong>|\`)(?:\\s*[:—–\\-|]|\\s|$))`,
  "im",
);
const LINE_START_COLON = new RegExp(
  `^\\s*(?:[#>*•\\-]+\\s*|[^\\w\\s]{1,4}\\s*)*(${TAG_ALT})\\s*:`,
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
  const visible = body.replace(/<!--[\s\S]*?-->/g, "");
  for (const pattern of [EXPLICIT_LABEL, BRACKET_TAG, LINE_START_MARKUP, LINE_START_COLON, COMPOUND_TAG]) {
    const match = pattern.exec(visible);
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

/** Formats the detailed thread list for `pr-threads.mjs --list`. */
export function formatThreadList({ url, head, threads, includeResolved = false }) {
  const lines = [
    `pr: ${url}`,
    `head: ${head}`,
    `${includeResolved ? "threads" : "unresolved threads"}: ${threads.length}`,
  ];
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
  return `${lines.join("\n")}\n`;
}
