---
name: watch-pr
description: "Wait for a GitHub PR's checks, reviews, or merge readiness with one background watcher, not a hand-written loop."
---

# Watch a pull request

Read [the Pi execution contract](../../docs/harness/pi.md).

Use the watcher to wait until one GitHub pull request can be merged, or to learn what blocks it. It checks four things on the head commit: the checks finished, the required reviewers signed off, the review threads are resolved, and GitHub can merge. Do not write your own check loop. Do not add separate reads after `gh pr checks --watch`.

The watcher (`scripts/watch-pr.mjs`) only reads from GitHub. It does not merge, comment, rerun or resolve. Use the companion helper `scripts/pr-threads.mjs` when you explicitly want to list, reply to, or resolve review threads, and `scripts/watch-run.mjs` when waiting on a single GitHub Actions workflow run (such as a post-merge deploy with a manual production approval gate) using the same repository routing.

## Start the watcher

Start `scripts/watch-pr.mjs` from this skill's directory with `background_command`. Then do other work or end the turn. Do not poll the job.

```json
{"action":"start","command":"node SKILL_DIRECTORY/scripts/watch-pr.mjs https://github.com/OWNER/REPO/pull/123"}
```

- Name the pull request by URL, or by number with `--repo OWNER/NAME`. A number without `--repo` refers to the `origin` remote of the current directory.
- `--timeout SECONDS` ends the watch after that time. The default is 3600. `0` waits without limit.
- `--interval SECONDS` is the time between ordinary polls. The default is 60 and the minimum is 30 (lower positive values are clamped to 30 without error to protect GitHub API rate limits).
- `--once` prints the verdict for the current state and exits. Run it with `bash` to look without waiting.
- `--sha SHA`, full or short, evaluates nothing until GitHub reports that commit as the head. Pass `--sha $(git rev-parse HEAD)` right after `git push`: GitHub can answer the first read with the previous head, and without `--sha` the watcher would judge that older commit's checks and threads. The wait shares the watch's `--timeout` and `--interval`; `--once` reports it without waiting.
- `--required-checks-only` treats non-required, non-reviewer checks as optional when `pending` (including `waiting`, `queued`, `in_progress`) or `cancelled`, so manual-approval or non-blocking jobs do not block readiness once required checks and reviewers are green. Explicit failures (`failure`, `timed_out`, `action_required`, etc.) still block with exit 4. Required status checks from branch protection/rulesets and configured reviewer checks are never ignored. Fail-closed: if branch protection and rulesets declare no required status checks for the base branch, the watcher reports `UNKNOWN` (exit 9).
- Without `background_command`, run the watcher with `bash` and a `--timeout` below the `bash` time limit.
- Start one job for each pull request.

After a rate-limited read, the watcher uses a future reset or `Retry-After` instead of the ordinary polling interval. If that time has already passed, the watcher uses the ordinary interval to avoid retrying in a tight loop. Secondary limits without a deadline start with a wait of at least 60 seconds. Repeated secondary limits back off separately. These waits use no ordinary query retries and do not extend `--timeout`. With `--once`, the watcher reports the rate limit without waiting.

## Read the verdict

The verdict is the last output. It has at most 20 lines and 2048 bytes, so a completion notice shows all of it. Earlier lines are progress.

```text
BLOCKED: 1 unresolved review thread
pr: https://github.com/OWNER/REPO/pull/123
commit: 6e9e0011bc4e754c032e6afcf47f5b15ffcc96ed (head did not move during this watch)
checks on 6e9e001: 4 passed, 0 failed, 0 pending, 2 skipped
expected checks: all present (1 workflow that every push starts, 1 required check)
reviewers:
  Greptile: 5/5 on 6e9e001
  Review bot: passed on 6e9e001
unresolved review threads: 1
  app/lib/dedup.ts:208 @reviewer [6e9e001 head, blocks]: Use the existing indexed predicate ...
merge: MERGEABLE; GitHub merge state CLEAN; review decision none
```

| Exit | First line | Meaning |
| --- | --- | --- |
| 0 | `READY` or `MERGED` | Every rule passed on the named commit, or the pull request is merged. |
| 2 | `BLOCKED: merge conflicts ...` | Resolve the conflicts. |
| 3 | `BLOCKED: N unresolved review threads` or `BLOCKED: N unaddressed PR comments` | Fix or rebut each inline thread or PR conversation comment. Resolve inline threads (`pr-threads.mjs --resolve PRRT_...`), minimize attributed review flags (`pr-threads.mjs --resolve IC_...`), or for human reviewer and severity-tagged bot comments either minimize (`IC_...`) or post a PR-author reply that quotes or links the comment. |
| 4 | `BLOCKED: N checks failed` | The block links each failed check. |
| 5 | `BLOCKED: timed out ...` or `BLOCKED: not ready ...` | The watch ran out of time or the pull request is not ready. The line says what the watcher was waiting for, including a GitHub rate limit. |
| 6 | `BLOCKED: ...` | Draft, closed, changes requested, behind the base branch, or GitHub requires an approving review. |
| 7 | `BLOCKED: GitHub query failed ...` | The watcher could not read GitHub. The block names the GitHub CLI it ran. |
| 8 | `BLOCKED: NAME did not sign off ...` | A required reviewer reported on this commit and did not pass. |
| 9 | `UNKNOWN: ...` | The watcher cannot prove readiness. |
| 64 | none | Wrong arguments or an invalid configuration file. The message is on stderr. |

- The notice of a succeeded job has no output. Exit 0 always means `READY` or `MERGED`. To see the commit, read the block with `{"action":"status","id":"JOB_ID"}`.
- `READY` is true only for the commit in the block. The watcher follows new pushes while it runs.
- `UNKNOWN` is not `READY`. Verify the named item yourself and report what you verified.
- After you fix a blocker, start the watcher again.
- The watcher does not know the user's merge permission or hold. `READY` does not authorize a merge.

## How the watcher decides

- **Checks.** It reads the check runs, commit statuses and workflow runs of the head commit. It does not read the pull request's check list, which omits runs that `workflow_dispatch` started. A workflow run that is not finished, or did not succeed, counts as a check even while it has no job.
- **Optional checks.** With `--required-checks-only`, non-required checks settle without blocking when `pending` or `cancelled`, and appear in the verdict summary as `optional (ignored)`. Explicit failures (`failure`, `timed_out`, etc.) still block with exit 4. Required status checks declared by branch protection/rulesets and configured reviewer checks are never ignored. If GitHub declares no required status checks for the base branch, `--required-checks-only` fails closed with `UNKNOWN` (exit 9).
- **Checks that have not started.** A commit with no failed and no pending check is not ready while an expected check is absent. Expected checks are the status checks that the base branch requires, and each workflow that every push to the pull request starts. A workflow with a path or branch filter and no run is unknown, unless another run of the same event exists on the commit. A commit with no checks and no expected check is unknown.
- **Reviewers.** Only rules from the configuration count. A sign-off counts only on the head commit. Without a rule, the block says `reviewers: no rule for OWNER/REPO`.
- **Threads, PR comments, and merge state.** Every unresolved inline review thread blocks. The watcher also reads PR conversation comments in the same GraphQL query (paginating automatically when a PR has >100 comments) and blocks on unaddressed attributed review flags (such as Grok Bot `— Attributed to ...` / leading `Review flag` comments, even when posted under the PR author's login) until minimized as resolved (e.g. `pr-threads.mjs --resolve IC_...`), plus human reviewer comments from someone other than the PR author and bot comments carrying a structured severity tag until minimized or explicitly referenced (linked via `#issuecomment-<id>` / URL or quoted with `> ...`) by a later non-flag PR-author reply. Comments already consumed by a configured text reviewer rule (such as Greptile verdicts) and informational deploy bots (GraphQL `Bot` accounts without a severity tag) do not block. Each thread includes its short commit SHA (`head` vs `older`), author, `path:line`, parsed severity tag (`blocks`, `fix-if-cheap`, `next-action`, `critical`, `high`, `medium`, `low`, `nit`) when present, and concise snippet. Conflicts, a draft, requested changes and a head behind its base block.

## Manage review threads and PR comments (`pr-threads.mjs`)

Use `scripts/pr-threads.mjs` to inspect unresolved inline review threads (`PRRT_...`) and unaddressed PR conversation comments (`IC_...`) with their GraphQL IDs, commit SHAs, parsed severities, URLs, and snippets, and to reply to inline threads or resolve threads / minimize PR comments safely through the repository's configured GitHub CLI (`gh-work` / `gh-personal`, with `GH_TOKEN`/`GITHUB_TOKEN` stripped).

```bash
# List unresolved threads and unaddressed PR comments (add --json for JSON, --all for resolved too)
node SKILL_DIRECTORY/scripts/pr-threads.mjs https://github.com/OWNER/REPO/pull/123 --list

# Reply to an inline thread from a file (or "-" for stdin) without shell interpolation, then resolve
node SKILL_DIRECTORY/scripts/pr-threads.mjs --repo OWNER/REPO --reply PRRT_... --body-file reply.md --resolve PRRT_...

# Minimize an addressed PR conversation comment (e.g. an attributed review flag) as resolved
node SKILL_DIRECTORY/scripts/pr-threads.mjs --repo OWNER/REPO --resolve IC_...
```

Exit codes for `pr-threads.mjs`: `0` success, `7` GitHub query failed, `64` usage or configuration error.

## Watch a workflow run (`watch-run.mjs`)

Use `scripts/watch-run.mjs` with `background_command` to wait on one GitHub Actions workflow run without writing a custom polling loop. It reuses `watch-pr.json` / `WATCH_PR_GH` CLI routing, strips ambient `GH_TOKEN`/`GITHUB_TOKEN`, and applies the same primary/secondary rate-limit backoff as `watch-pr.mjs`.

```json
{"action":"start","command":"node SKILL_DIRECTORY/scripts/watch-run.mjs https://github.com/OWNER/REPO/actions/runs/123456789 --stop-at-waiting"}
```

- Name the run by URL (`https://github.com/OWNER/REPO/actions/runs/<id>`) or by numeric ID with `--repo OWNER/NAME` (defaults to the `origin` remote of the current directory).
- `--interval SECONDS` sets the ordinary polling interval. The default is 60 and the minimum is 30 (lower positive values are clamped to 30 without error).
- `--timeout SECONDS` ends the watch after that time. The default is 3600; `0` waits without limit.
- `--until-job NAME` (repeatable) matches a job name (or `"Workflow / Job"`) and settles with exit `0` (`SETTLED` or `PASSED`) once all named jobs succeed, even while downstream manual-approval or other jobs remain `waiting` or `in_progress`. If any named job fails, is cancelled, times out, or is skipped, the watcher exits `4` immediately.
- `--stop-at-waiting` settles with exit `0` (`SETTLED`) once all active non-waiting jobs have succeeded and the only remaining incomplete job(s) are in `waiting` status (GitHub Actions deployment environment approval gate). If any job fails or is cancelled, it fails closed immediately with exit `4`.
- `--once` evaluates the current state and exits without polling (run with `bash`).

The last output is a bounded summary (at most 20 lines and 2048 bytes) naming the run URL, workflow name and status, head commit SHA, job counts (`passed`, `failed`, `waiting`, `pending`, `skipped`), failed job URLs, and waiting deployment-gate jobs.

| Exit | First line | Meaning |
| --- | --- | --- |
| 0 | `PASSED` or `SETTLED` | The workflow run succeeded, all `--until-job` targets passed, or only `waiting` deployment-gate jobs remain under `--stop-at-waiting`. |
| 4 | `FAILED` or `CANCELLED` | The workflow run or a job (or `--until-job` target) failed, timed out, was cancelled, or was skipped. |
| 7 | `UNKNOWN: ...` | GitHub query failed, a `--until-job` target never appeared in a completed run, or the run ended in an unexpected non-success conclusion (`skipped` / `neutral`). |
| 8 | `TIMEOUT: ...` or `PENDING: ...` | The watch reached `--timeout`, or `--once` saw the run still in progress. |
| 64 | none | Wrong arguments or an invalid configuration file. The message is on stderr. |

## Configure it

The watcher reads `watch-pr.json` in the Pi agent directory (`${PI_CODING_AGENT_DIR:-~/.pi/agent}`), or the file that `WATCH_PR_CONFIG` names. Without the file, it runs `gh` and requires no reviewer. Copy [config.example.json](config.example.json) to begin.

Each key is `*` for every repository, an owner, or `OWNER/REPO`. Each value can contain:

- `gh`: the GitHub CLI executable for these repositories. The most specific key wins. `WATCH_PR_GH` overrides it for one run.
- `reviewers`: reviewers that must sign off. The rules of `*`, the owner and the repository all apply.
  - `{"name", "check"}`: a check with this name must pass on the head commit.
  - `{"name", "author", "verdict", "pass", "commit"}`: the newest comment or review by `author` that matches the `verdict` pattern must capture the text `pass`. The `commit` pattern must capture the head commit from the same text. A review that does not match `commit` counts for the commit that GitHub recorded for it. Each pattern is a JavaScript regular expression with one capture group.
- `mergeWithoutApproval`: `true` when the user may merge although GitHub requires an approving review. The default is `false`, and that state then blocks with exit 6.

The watcher rejects a file with an unknown key. `watch-pr.mjs`, `pr-threads.mjs`, and `watch-run.mjs` strip ambient `GH_TOKEN` and `GITHUB_TOKEN` before running the configured GitHub CLI so account-routing wrappers always use their selected account.

## Other watchers

For stacked PRs, start one `scripts/watch-pr.mjs` background job per PR so every PR in the stack uses the same `watch-pr.json` routing, required reviewers, checks, inline threads, and PR conversation comment checks. `gh pr checks --watch` and `gh run watch` remain useful only when the question is "did these checks finish" without repository routing, reviewer gates, comment tracking, rate-limit backoff, or manual deployment gates.
