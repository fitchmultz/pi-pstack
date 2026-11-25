#!/usr/bin/env node
// Lists, replies to, and resolves GitHub pull request review threads using the
// shared watch-pr repository config and gh-client routing.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { QueryError, createGhClient, formatRateLimit } from "./gh-client.mjs";
import { createGitHub } from "./github.mjs";
import {
  ConfigError,
  configPath,
  loadConfig,
  parsePrTarget,
  resolveGitHubCli,
  resolveRepo,
  settingsFor,
} from "./repo-config.mjs";
import { actionableThreads, formatThreadList, unaddressedIssueComments } from "./threads.mjs";
import { EXIT } from "./verdict.mjs";

const USAGE = `Usage: pr-threads.mjs [<number|url>] [--repo OWNER/NAME] [--list] [--all] [--json]
       pr-threads.mjs [<number|url>] [--repo OWNER/NAME] --reply <threadId> --body-file <path>
       pr-threads.mjs [<number|url>] [--repo OWNER/NAME] --resolve <threadOrCommentId>
       pr-threads.mjs [<number|url>] [--repo OWNER/NAME] --unresolve <threadId>

Lists unresolved PR review threads and unaddressed PR conversation comments, or
replies to / resolves them through the repository's configured GitHub CLI
(watch-pr.json / WATCH_PR_GH).

  <number|url>        pull request number or URL (required for --list; optional for --reply/--resolve
                      when --repo or the origin remote identifies the repository)
  --repo              OWNER/NAME; default: the origin remote (also --owner OWNER --repo NAME)
  --list              list unresolved review threads, resolved threads with new replies, and
                      unaddressed PR comments (default with a PR)
  --all               with --list, include resolved threads and all PR comments as well
  --json              with --list, print structured JSON
  --reply THREAD_ID   post a reply to this inline review thread (requires --body-file)
  --body-file PATH    UTF-8 file containing the reply body (use "-" to read stdin)
  --resolve ID        resolve an inline review thread (PRRT_...) or minimize a PR comment
                      (IC_...) as resolved
  --unresolve ID      reopen a resolved inline review thread (PRRT_...)

Exit: 0 success, 7 GitHub query failed, 64 usage or configuration error.
`;

const REPLY_MUTATION = `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){
    comment{id fullDatabaseId url createdAt author{login}}
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){
    thread{id isResolved}
  }
}`;

const UNRESOLVE_MUTATION = `mutation($threadId:ID!){
  unresolveReviewThread(input:{threadId:$threadId}){
    thread{id isResolved}
  }
}`;

const MINIMIZE_MUTATION = `mutation($subjectId:ID!){
  minimizeComment(input:{subjectId:$subjectId,classifier:RESOLVED}){
    minimizedComment{isMinimized}
  }
}`;

class UsageError extends Error {}

function readBodyFile(path) {
  let content;
  try {
    content = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(`cannot read --body-file "${path}": ${error.message}`);
  }
  if (!content.trim()) throw new UsageError("--body-file must not be empty");
  return content;
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
        list: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        reply: { type: "string" },
        "body-file": { type: "string" },
        resolve: { type: "string" },
        unresolve: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  if (values.help) return null;
  if (positionals.length > 1) throw new UsageError("name at most one pull request");
  if (positionals.length && values.pr !== undefined) throw new UsageError("name the pull request once");
  const target = positionals[0] ?? values.pr;

  const replyId = values.reply?.trim();
  const resolveId = values.resolve?.trim();
  const unresolveId = values.unresolve?.trim();
  if (values.reply !== undefined && !replyId) throw new UsageError("--reply requires a non-empty thread ID");
  if (values.resolve !== undefined && !resolveId) throw new UsageError("--resolve requires a non-empty thread ID");
  if (values.unresolve !== undefined && !unresolveId) throw new UsageError("--unresolve requires a non-empty thread ID");
  if (unresolveId?.startsWith("IC_")) {
    throw new UsageError("--unresolve only supports inline review threads (PRRT_...)");
  }
  if (resolveId && unresolveId && resolveId === unresolveId) {
    throw new UsageError("cannot both --resolve and --unresolve the same thread");
  }
  if (replyId && !values["body-file"]) throw new UsageError("--reply requires --body-file <path>");
  if (!replyId && values["body-file"] !== undefined) throw new UsageError("--body-file can only be used with --reply");

  const hasMutation = Boolean(replyId || resolveId || unresolveId);
  const doList = values.list || (!hasMutation && target !== undefined);
  if (!doList && !hasMutation) {
    throw new UsageError("specify --list <number|url>, --reply <threadId> --body-file <path>, --resolve <threadId>, or --unresolve <threadId>");
  }
  if (doList && target === undefined) throw new UsageError("--list requires a pull request number or URL");

  let pr = null;
  let repoTarget = null;
  if (target !== undefined) {
    const resolved = await parsePrTarget(target, { owner: values.owner, repo: values.repo });
    if (resolved.error) throw new UsageError(resolved.error);
    pr = resolved.pr;
    repoTarget = { owner: pr.owner, repo: pr.repo };
  } else {
    repoTarget = await resolveRepo({ owner: values.owner, repo: values.repo });
    if (!repoTarget) throw new UsageError("name the repository: --repo OWNER/NAME");
  }

  return {
    pr,
    repo: repoTarget,
    list: doList,
    all: values.all,
    json: values.json,
    replyId: replyId ?? null,
    bodyFile: values["body-file"] ?? null,
    resolveId: resolveId ?? null,
    unresolveId: unresolveId ?? null,
  };
}

/** Posts a reply to one review thread via GraphQL. */
export async function replyToThread(client, threadId, body) {
  const result = await client.graphql(REPLY_MUTATION, { threadId, body });
  const comment = result?.data?.addPullRequestReviewThreadReply?.comment;
  if (!comment) throw new QueryError(`GitHub returned no comment when replying to thread ${threadId}`);
  return comment;
}

/** Marks one review thread (`PRRT_...`) resolved or minimizes a PR comment (`IC_...`) as RESOLVED. */
export async function resolveThread(client, targetId) {
  if (targetId.startsWith("IC_")) {
    const result = await client.graphql(MINIMIZE_MUTATION, { subjectId: targetId });
    const comment = result?.data?.minimizeComment?.minimizedComment;
    if (!comment || !comment.isMinimized) {
      throw new QueryError(`GitHub did not confirm minimizing comment ${targetId}`);
    }
    return comment;
  }
  const result = await client.graphql(RESOLVE_MUTATION, { threadId: targetId });
  const thread = result?.data?.resolveReviewThread?.thread;
  if (!thread || !thread.isResolved) {
    throw new QueryError(`GitHub did not confirm resolution of thread ${targetId}`);
  }
  return thread;
}

/** Marks one resolved review thread (`PRRT_...`) unresolved via GraphQL. */
export async function unresolveThread(client, threadId) {
  const result = await client.graphql(UNRESOLVE_MUTATION, { threadId });
  const thread = result?.data?.unresolveReviewThread?.thread;
  if (!thread || thread.isResolved !== false) {
    throw new QueryError(`GitHub did not confirm unresolving thread ${threadId}`);
  }
  return thread;
}

async function main(argv, env) {
  const options = await parse(argv);
  if (options === null) {
    process.stdout.write(USAGE);
    return 0;
  }
  const body = options.replyId ? readBodyFile(options.bodyFile) : null;
  const settingsPath = configPath(env);
  const settings = settingsFor(loadConfig(settingsPath), options.repo.owner, options.repo.repo);
  const { executable, source } = resolveGitHubCli(settings, { env, settingsPath });
  const client = createGhClient(executable, { env });
  const github = createGitHub(client);

  try {
    if (options.replyId) {
      const comment = await replyToThread(client, options.replyId, body);
      process.stdout.write(`replied: ${options.replyId} -> ${comment.url ?? comment.id}\n`);
    }
    if (options.resolveId) {
      await resolveThread(client, options.resolveId);
      process.stdout.write(`resolved: ${options.resolveId}\n`);
    }
    if (options.unresolveId) {
      await unresolveThread(client, options.unresolveId);
      process.stdout.write(`unresolved: ${options.unresolveId}\n`);
    }
    if (options.list) {
      const facts = await github.pullRequest(options.pr);
      const textReviewerRules = settings.reviewers.filter((rule) => rule.check === undefined);
      const threadState = actionableThreads(facts.allThreads, { prAuthor: facts.author ?? null });
      const unaddressedComments = unaddressedIssueComments(facts.issueComments ?? [], {
        prAuthor: facts.author ?? null,
        textReviewerRules,
      });
      const threads = options.all ? facts.allThreads : threadState.all;
      const comments = options.all ? (facts.issueComments ?? []) : unaddressedComments;
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          pr: facts.url,
          head: facts.head,
          unresolvedCount: threadState.unresolved.length,
          resurfacedCount: threadState.resurfaced.length,
          unaddressedCommentCount: unaddressedComments.length,
          threads,
          comments,
        }, null, 2)}\n`);
      } else {
        process.stdout.write(formatThreadList({
          url: facts.url,
          head: facts.head,
          threads,
          comments,
          includeResolved: options.all,
          unresolvedCount: threadState.unresolved.length,
          resurfacedCount: threadState.resurfaced.length,
        }));
      }
    }
    return 0;
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    const reason = error.rateLimit ? formatRateLimit(error.rateLimit) : error.message;
    process.stderr.write([
      `pr-threads: GitHub query failed: ${reason}`,
      `github cli: ${executable} (${source})`,
    ].join("\n").concat("\n"));
    return EXIT.queryFailed;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof UsageError) && !(error instanceof ConfigError)) throw error;
    process.stderr.write(`pr-threads: ${error.message}\n${error instanceof UsageError ? USAGE : ""}`);
    process.exitCode = EXIT.usage;
  }
}
