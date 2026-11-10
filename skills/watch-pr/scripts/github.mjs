// Read-only GitHub queries for the watcher, through one GitHub CLI executable.
// Every REST read names the commit it is about, so one poll never mixes two heads.

import { spawn } from "node:child_process";
import { basename } from "node:path";

/** A GitHub read that failed. `retryable` is false when repeating it cannot help. */
export class QueryError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = "QueryError";
    this.retryable = retryable;
  }
}

const PULL_REQUEST = `query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    url state isDraft mergedAt mergeable mergeStateStatus reviewDecision headRefOid baseRefName
    mergeCommit{oid}
    reviewThreads(first:100,after:$endCursor){
      pageInfo{hasNextPage endCursor}
      nodes{isResolved path line originalLine comments(first:1){nodes{author{login} body}}}
    }
  }}
}`;
const HEAD = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid}}
}`;
const WORKFLOWS = `query($owner:String!,$repo:String!,$expression:String!){
  repository(owner:$owner,name:$repo){object(expression:$expression){
    ... on Tree{entries{name type object{... on Blob{text}}}}
  }}
}`;

// Check run and workflow run conclusions:
// https://docs.github.com/en/rest/checks/runs#get-a-check-run
const PASSED = new Set(["success"]);
const SKIPPED = new Set(["neutral", "skipped"]);
/** State of a check run or workflow run from its `status` and `conclusion`. */
function stateOf({ status, conclusion }) {
  if (status !== "completed") return "pending";
  return PASSED.has(conclusion) ? "passed" : SKIPPED.has(conclusion) ? "skipped" : "failed";
}

/** True when a GraphQL response says the repository or pull request does not exist for this account. */
function notFound(stdout) {
  try {
    // `--slurp` wraps the pages in an array.
    return [JSON.parse(stdout)].flat().some((page) => page.errors?.some((error) => error.type === "NOT_FOUND"));
  } catch {
    return false;
  }
}

const segment = (value) => value.split("/").map(encodeURIComponent).join("/");
/** Bot logins end in `[bot]` in REST and not in GraphQL; compare without it. */
export const login = (value) => (value ?? "").replace(/\[bot\]$/, "").toLowerCase();

/**
 * @param {string} executable GitHub CLI name on PATH, or a path to it.
 */
export function createGitHub(executable) {
  function run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
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
    const { code, stdout, stderr } = await run(args);
    if (code !== 0) {
      const detail = stderr.trim().split(/\r?\n/, 1)[0].slice(0, 240);
      throw new QueryError(`${executable} ${args.slice(0, 2).join(" ")} exited ${code}${detail ? `: ${detail}` : ""}`,
        { retryable: !notFound(stdout) });
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new QueryError(`${executable} ${args.slice(0, 2).join(" ")} did not return JSON`);
    }
  }

  /** All pages of a REST list, as an array of page bodies. */
  const rest = (path) => json(["api", path, "--paginate", "--slurp"]);

  function graphql(query, variables, paginate = false) {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
    }
    if (paginate) args.push("--paginate", "--slurp");
    return json(args);
  }

  function pullRequestNode(page, pr) {
    const node = page?.data?.repository?.pullRequest;
    if (!node) throw new QueryError(`GitHub returned no pull request for ${pr.owner}/${pr.repo}#${pr.number}`);
    return node;
  }

  return {
    /** State of the pull request and its unresolved review threads, in one snapshot per page. */
    async pullRequest(pr) {
      const pages = await graphql(PULL_REQUEST, pr, true);
      const nodes = pages.map((page) => pullRequestNode(page, pr));
      const last = nodes.at(-1);
      return {
        url: last.url,
        state: last.state,
        isDraft: last.isDraft,
        mergedAt: last.mergedAt,
        mergeCommit: last.mergeCommit?.oid ?? null,
        mergeable: last.mergeable,
        mergeState: last.mergeStateStatus,
        reviewDecision: last.reviewDecision || null,
        head: last.headRefOid,
        baseRef: last.baseRefName,
        threads: nodes.flatMap((node) => node.reviewThreads.nodes).filter((thread) => !thread.isResolved)
          .map((thread) => {
            const comment = thread.comments.nodes[0];
            return {
              path: thread.path,
              line: thread.line ?? thread.originalLine,
              author: comment?.author?.login ?? null,
              body: comment?.body ?? "",
            };
          }),
      };
    },

    async head(pr) {
      return pullRequestNode(await graphql(HEAD, pr), pr).headRefOid;
    },

    /**
     * Checks and workflow runs on one commit.
     *
     * Reads the commit, not the pull request: the pull request's check list
     * omits runs started by workflow_dispatch on the same commit.
     * https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
     * https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference
     * https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-repository
     */
    async commitChecks(pr, sha) {
      const base = `repos/${pr.owner}/${pr.repo}`;
      const [checkPages, statusPages, runPages] = await Promise.all([
        rest(`${base}/commits/${sha}/check-runs?per_page=100`),
        rest(`${base}/commits/${sha}/status?per_page=100`),
        rest(`${base}/actions/runs?head_sha=${sha}&per_page=100`),
      ]);
      const runs = runPages.flatMap((page) => page.workflow_runs).map((run) => ({
        id: run.id, path: run.path, event: run.event, suite: run.check_suite_id,
        status: run.status, conclusion: run.conclusion, link: run.html_url,
      }));
      const bySuite = new Map(runs.map((run) => [run.suite, run]));
      const runKey = (run) => `${run.path} ${run.event}`;
      const latestRun = new Map();
      for (const run of runs) {
        if (!latestRun.has(runKey(run)) || latestRun.get(runKey(run)).id < run.id) latestRun.set(runKey(run), run);
      }
      // A workflow can run again on the same commit and event: a cancelled run,
      // a reopened pull request, a label. The runs can hold different jobs, so
      // every job name counts, with its newest check.
      const newest = new Map();
      for (const check of checkPages.flatMap((page) => page.check_runs)) {
        const run = bySuite.get(check.check_suite?.id);
        const key = `${run ? runKey(run) : `suite ${check.check_suite?.id}`}\n${check.name}`;
        const previous = newest.get(key);
        if (!previous || previous.id < check.id) newest.set(key, check);
      }
      const checks = [...newest.values()]
        // The check of an earlier run is not final while a later run of the same workflow is unfinished.
        .filter((check) => {
          const run = bySuite.get(check.check_suite?.id);
          return !run || latestRun.get(runKey(run)) === run || latestRun.get(runKey(run)).status === "completed";
        })
        .map((check) => ({
          name: check.name,
          state: stateOf(check),
          detail: check.status !== "completed" ? check.status : check.conclusion,
          link: check.details_url || check.html_url || "",
          suite: check.check_suite?.id,
        }));
      // A workflow run exists before its jobs do. GitHub creates a job that
      // needs another job only when that job ends, and a run can end without
      // any job (approval required, invalid workflow file). So an unfinished
      // run, and a latest run that did not succeed, count even when no check says so.
      for (const run of runs) {
        const state = stateOf(run);
        const counts = state === "pending" || (state === "failed" && latestRun.get(runKey(run)) === run);
        if (!counts || checks.some((check) => check.suite === run.suite && check.state === state)) continue;
        checks.push({
          name: `workflow ${basename(run.path)}`,
          state,
          detail: run.status !== "completed" ? run.status : run.conclusion,
          link: run.link,
        });
      }
      for (const status of statusPages.flatMap((page) => page.statuses)) {
        checks.push({
          name: status.context,
          state: status.state === "success" ? "passed" : status.state === "pending" ? "pending" : "failed",
          detail: status.state,
          link: status.target_url || "",
        });
      }
      return { checks, runs };
    },

    /** Workflow files in the tree of one commit: `[{ path, text }]`; text is null when GitHub returns none. */
    async workflowFiles(pr, sha) {
      const result = await graphql(WORKFLOWS, { owner: pr.owner, repo: pr.repo, expression: `${sha}:.github/workflows` });
      if (!result?.data?.repository) throw new QueryError(`GitHub returned no repository for ${pr.owner}/${pr.repo}`);
      return (result.data.repository.object?.entries ?? [])
        .filter((entry) => entry.type === "blob" && /\.ya?ml$/.test(entry.name))
        .map((entry) => ({ path: `.github/workflows/${entry.name}`, text: entry.object?.text ?? null }));
    },

    /**
     * Names of the status checks GitHub requires before merging into `baseRef`,
     * from rulesets and from classic branch protection.
     * https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch
     * https://docs.github.com/en/rest/branches/branches#get-a-branch
     */
    async requiredChecks(pr, baseRef) {
      const base = `repos/${pr.owner}/${pr.repo}`;
      const [rulePages, branchPages] = await Promise.all([
        rest(`${base}/rules/branches/${segment(baseRef)}?per_page=100`),
        rest(`${base}/branches/${segment(baseRef)}`),
      ]);
      const names = rulePages.flat().filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => rule.parameters.required_status_checks.map((check) => check.context));
      const classic = branchPages[0]?.protection?.required_status_checks;
      if (classic && classic.enforcement_level !== "off") names.push(...(classic.contexts ?? []));
      return [...new Set(names)];
    },

    /**
     * Text that reviewers left on the pull request, newest first: issue comments
     * and review bodies. A review names its commit; a comment does not.
     */
    async reviewTexts(pr) {
      const base = `repos/${pr.owner}/${pr.repo}`;
      const [commentPages, reviewPages] = await Promise.all([
        rest(`${base}/issues/${pr.number}/comments?per_page=100`),
        rest(`${base}/pulls/${pr.number}/reviews?per_page=100`),
      ]);
      return [
        ...commentPages.flat().map((comment) => (
          { author: login(comment.user?.login), body: comment.body ?? "", at: comment.updated_at, commit: null })),
        ...reviewPages.flat().map((review) => (
          { author: login(review.user?.login), body: review.body ?? "", at: review.submitted_at, commit: review.commit_id })),
      ].sort((a, b) => (a.at < b.at ? 1 : -1));
    },
  };
}
