// Watcher settings per repository owner or repository: which GitHub CLI to
// run, which reviewers must sign off on the head commit, and whether the user
// may merge without the approving review that GitHub requires.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class ConfigError extends Error {}

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
 * `reviewers` (a list of rules) and `mergeWithoutApproval` (true or false).
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
      if (!["gh", "reviewers", "mergeWithoutApproval"].includes(key)) fail(path, `"${scope}" has the unknown key "${key}"`);
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
 * add up across all three.
 */
export function settingsFor(scopes, owner, repo) {
  const matching = ["*", owner, `${owner}/${repo}`].map((scope) => scopes.get(scope.toLowerCase())).filter(Boolean);
  return {
    gh: matching.map((scope) => scope.gh).filter(Boolean).at(-1) ?? null,
    mergeWithoutApproval: matching.map((scope) => scope.mergeWithoutApproval).filter((value) => value !== undefined).at(-1) ?? false,
    reviewers: matching.flatMap((scope) => scope.reviewers),
  };
}
