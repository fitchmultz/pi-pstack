// Shared repository configuration and GitHub CLI routing for watch-pr tools
// (`watch-pr.mjs`, `pr-threads.mjs`, and future `watch-run.mjs`).

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class ConfigError extends Error {}

const ALLOWED_KEYS = new Set(["gh", "reviewers", "mergeWithoutApproval"]);

/** `WATCH_PR_CONFIG`, or `watch-pr.json` in the Pi agent directory. */
export function configPath(env = process.env) {
  if (env.WATCH_PR_CONFIG) return env.WATCH_PR_CONFIG;
  const agent = env.PI_CODING_AGENT_DIR;
  const directory = !agent ? join(homedir(), ".pi", "agent")
    : agent === "~" ? homedir() : agent.startsWith("~/") ? join(homedir(), agent.slice(2)) : agent;
  return join(directory, "watch-pr.json");
}

function fail(path, message) {
  throw new ConfigError(`${path}: ${message}`);
}

function pattern(path, where, value) {
  let regex;
  try {
    regex = new RegExp(value);
  } catch (error) {
    fail(path, `${where} is not a valid regular expression: ${error.message}`);
  }
  if (new RegExp(`${value}|`).exec("").length !== 2) fail(path, `${where} must have exactly one capture group`);
  return regex;
}

function reviewer(path, where, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, `${where} must be an object`);
  const keys = Object.keys(value).sort().join(",");
  const text = (key) => {
    if (typeof value[key] !== "string" || !value[key]) fail(path, `${where}.${key} must be a non-empty string`);
    return value[key];
  };
  if (keys === "check,name") return { name: text("name"), check: text("check") };
  if (keys === "author,commit,name,pass,verdict") {
    return {
      name: text("name"),
      author: text("author"),
      verdict: pattern(path, `${where}.verdict`, text("verdict")),
      pass: text("pass"),
      commit: pattern(path, `${where}.commit`, text("commit")),
    };
  }
  return fail(path, `${where} must have the keys name and check, or name, author, verdict, pass and commit`);
}

/**
 * Reads the settings file. A missing file is an empty configuration.
 *
 * The file is a JSON object. Each key is `*` (every repository), an owner, or
 * `owner/repository`. Each value may hold `gh` (the GitHub CLI executable),
 * `reviewers` (a list of rules), and `mergeWithoutApproval` (true or false).
 * Unknown keys are rejected: a misspelled rule must not be silently dropped.
 */
export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw new ConfigError(`${path}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(path, `not valid JSON: ${error.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail(path, "must be a JSON object");
  const scopes = new Map();
  for (const [scope, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, `"${scope}" must be an object`);
    for (const key of Object.keys(value)) {
      if (!ALLOWED_KEYS.has(key)) fail(path, `"${scope}" has the unknown key "${key}"`);
    }
    if ("gh" in value && (typeof value.gh !== "string" || !value.gh)) fail(path, `"${scope}".gh must be a non-empty string`);
    if ("reviewers" in value && !Array.isArray(value.reviewers)) fail(path, `"${scope}".reviewers must be a list`);
    if ("mergeWithoutApproval" in value && typeof value.mergeWithoutApproval !== "boolean") {
      fail(path, `"${scope}".mergeWithoutApproval must be true or false`);
    }
    scopes.set(scope.toLowerCase(), {
      gh: value.gh,
      mergeWithoutApproval: value.mergeWithoutApproval,
      reviewers: (value.reviewers ?? []).map((rule, index) => reviewer(path, `"${scope}".reviewers[${index}]`, rule)),
    });
  }
  return scopes;
}

/**
 * Settings for one repository. The most specific `gh` and
 * `mergeWithoutApproval` win: repository, then owner, then `*`. Reviewer rules
 * add up across `*`, owner, and repo.
 */
export function settingsFor(scopes, owner, repo) {
  const matching = ["*", owner, `${owner}/${repo}`].map((scope) => scopes.get(scope.toLowerCase())).filter(Boolean);
  return {
    gh: matching.map((scope) => scope.gh).filter(Boolean).at(-1) ?? null,
    mergeWithoutApproval: matching.map((scope) => scope.mergeWithoutApproval).filter((value) => value !== undefined).at(-1) ?? false,
    reviewers: matching.flatMap((scope) => scope.reviewers),
  };
}

/**
 * Resolves the GitHub CLI executable and its provenance description for a repository.
 * Precedence: `WATCH_PR_GH` env var > repo/owner/`*` config `gh` > `"gh"`.
 */
export function resolveGitHubCli(settings, { env = process.env, settingsPath = configPath(env) } = {}) {
  const executable = env.WATCH_PR_GH || settings.gh || "gh";
  const source = env.WATCH_PR_GH
    ? "WATCH_PR_GH"
    : settings.gh
      ? settingsPath
      : `the default; none is set in WATCH_PR_GH or ${settingsPath}`;
  return { executable, source };
}

/** Reads the `origin` remote URL of `cwd`, or returns `""` if unavailable. */
export function originRemote(cwd = process.cwd()) {
  return new Promise((resolve) => {
    execFile("git", ["remote", "get-url", "origin"], { cwd }, (error, stdout) => resolve(error ? "" : stdout.trim()));
  });
}

/** Extracts `{ owner, repo }` from a GitHub HTTPS or SSH remote URL. */
export function parseGitHubRepoUrl(remote) {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote ?? "");
  return match ? { owner: match[1], repo: match[2] } : null;
}

/**
 * Resolves `{ owner, repo }` from CLI `--owner`/`--repo` flags or the git `origin` remote.
 * Returns `null` if neither provides a complete GitHub repository identity.
 */
export async function resolveRepo({ owner, repo, cwd = process.cwd() } = {}) {
  let resolvedOwner = owner;
  let resolvedRepo = repo;
  if (resolvedRepo?.includes("/")) {
    const parts = resolvedRepo.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    [resolvedOwner, resolvedRepo] = parts;
  }
  if (!resolvedOwner || !resolvedRepo) {
    const origin = parseGitHubRepoUrl(await originRemote(cwd));
    resolvedOwner ??= origin?.owner;
    resolvedRepo ??= origin?.repo;
  }
  if (!resolvedOwner || !resolvedRepo) return null;
  return { owner: resolvedOwner, repo: resolvedRepo };
}

/** Parses a PR URL or number (`123`, `#123`) into `{ owner, repo, number }`. */
export async function parsePrTarget(target, { owner, repo, cwd = process.cwd() } = {}) {
  let parsedOwner = owner;
  let parsedRepo = repo;
  let number = String(target).replace(/^#/, "");
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(target);
  if (url) [, parsedOwner, parsedRepo, number] = url;
  if (!/^[1-9]\d*$/.test(number)) return { error: `not a pull request number or URL: ${target}` };
  const resolved = await resolveRepo({ owner: parsedOwner, repo: parsedRepo, cwd });
  if (!resolved) return { error: "name the repository: --repo OWNER/NAME" };
  return { pr: { owner: resolved.owner, repo: resolved.repo, number: Number(number) } };
}
