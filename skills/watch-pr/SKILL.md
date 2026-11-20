---
name: watch-pr
description: "Wait for a GitHub PR's checks, reviews, or merge readiness with one background watcher, not a hand-written loop."
---

# Watch a pull request

Read [the Pi execution contract](../../docs/harness/pi.md).

Use the watcher to wait until one GitHub pull request can be merged, or to learn what blocks it. It checks four things on the head commit: the checks finished, the required reviewers signed off, the review threads are resolved, and GitHub can merge. Do not write your own check loop. Do not add separate reads after `gh pr checks --watch`.

The watcher (`scripts/watch-pr.mjs`) only reads from GitHub. It does not merge, comment, rerun or resolve. Use the companion helper `scripts/pr-threads.mjs` when you explicitly want to list, reply to, or resolve review threads using the same repository routing.

## Start the watcher

Start `scripts/watch-pr.mjs` from this skill's directory with `background_command`. Then do other work or end the turn. Do not poll the job.

```json
{"action":"start","command":"node SKILL_DIRECTORY/scripts/watch-pr.mjs https://github.com/OWNER/REPO/pull/123"}
```

- Name the pull request by URL, or by number with `--repo OWNER/NAME`. A number without `--repo` refers to the `origin` remote of the current directory.
- `--timeout SECONDS` ends the watch after that time. The default is 3600. `0` waits without limit.
- `--interval SECONDS` is the time between ordinary polls. The default is 60.
- `--once` prints the verdict for the current state and exits. Run it with `bash` to look without waiting.
- `--sha SHA`, full or short, evaluates nothing until GitHub reports that commit as the head. Pass `--sha $(git rev-parse HEAD)` right after `git push`: GitHub can answer the first read with the previous head, and without `--sha` the watcher would judge that older commit's checks and threads. The wait shares the watch's `--timeout` and `--interval`; `--once` reports it without waiting.
- `--ignore-check NAME` (repeatable) marks a non-required check as optional so `pending` (including `waiting`, `queued`, `in_progress`) and `cancelled` states do not block readiness or keep the watcher waiting once all other checks and reviewers are green. Explicit failures (`failure`, `timed_out`, `action_required`, etc.) still block with exit 4. Checks required by GitHub branch protection/rulesets or configured reviewer rules are never ignored.
- `--required-checks-only` treats all non-required, non-reviewer checks as optional when `pending` or `cancelled`. Explicit failures still block with exit 4. Fail-closed: if branch protection and rulesets declare no required status checks for the base branch, the watcher reports `UNKNOWN` (exit 9).
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
| 3 | `BLOCKED: N unresolved review threads` | Fix or rebut each thread, then resolve it. |
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
- **Optional checks.** Checks listed in `optionalChecks` or `--ignore-check` (or non-required checks under `--required-checks-only`) settle without blocking when `pending` or `cancelled`, and appear in the verdict summary as `optional (ignored)`. Explicit failures (`failure`, `timed_out`, etc.) still block with exit 4. Required status checks declared by branch protection/rulesets and configured reviewer checks are never ignored.
- **Checks that have not started.** A commit with no failed and no pending check is not ready while an expected check is absent. Expected checks are the status checks that the base branch requires, and each workflow that every push to the pull request starts. A workflow with a path or branch filter and no run is unknown, unless another run of the same event exists on the commit. A commit with no checks and no expected check is unknown.
- **Reviewers.** Only rules from the configuration count. A sign-off counts only on the head commit. Without a rule, the block says `reviewers: no rule for OWNER/REPO`.
- **Threads and merge state.** Every unresolved review thread blocks. The watcher fetches up to 20 comments per thread in the same pull request GraphQL query (no extra API call) and includes each thread's short commit SHA (`head` vs `older`), author, `path:line`, parsed severity tag (`blocks`, `fix-if-cheap`, `next-action`, `critical`, `high`, `medium`, `low`, `nit`) when present, and concise snippet. Conflicts, a draft, requested changes and a head behind its base block.

## Manage review threads (`pr-threads.mjs`)

Use `scripts/pr-threads.mjs` to inspect unresolved review threads with their GraphQL thread IDs, commit SHAs, parsed severities, URLs, and snippets, and to reply or resolve threads safely through the repository's configured GitHub CLI (`gh-work` / `gh-personal`, with `GH_TOKEN`/`GITHUB_TOKEN` stripped).

```bash
# List unresolved threads (or add --json for structured output, --all for resolved too)
node SKILL_DIRECTORY/scripts/pr-threads.mjs https://github.com/OWNER/REPO/pull/123 --list

# Reply from a file (or "-" for stdin) without shell interpolation, then resolve
node SKILL_DIRECTORY/scripts/pr-threads.mjs --repo OWNER/REPO --reply PRRT_... --body-file reply.md --resolve PRRT_...
```

Exit codes for `pr-threads.mjs`: `0` success, `7` GitHub query failed, `64` usage or configuration error.

## Configure it

The watcher reads `watch-pr.json` in the Pi agent directory (`${PI_CODING_AGENT_DIR:-~/.pi/agent}`), or the file that `WATCH_PR_CONFIG` names. Without the file, it runs `gh` and requires no reviewer. Copy [config.example.json](config.example.json) to begin.

Each key is `*` for every repository, an owner, or `OWNER/REPO`. Each value can contain:

- `gh`: the GitHub CLI executable for these repositories. The most specific key wins. `WATCH_PR_GH` overrides it for one run.
- `reviewers`: reviewers that must sign off. The rules of `*`, the owner and the repository all apply.
  - `{"name", "check"}`: a check with this name must pass on the head commit.
  - `{"name", "author", "verdict", "pass", "commit"}`: the newest comment or review by `author` that matches the `verdict` pattern must capture the text `pass`. The `commit` pattern must capture the head commit from the same text. A review that does not match `commit` counts for the commit that GitHub recorded for it. Each pattern is a JavaScript regular expression with one capture group.
- `mergeWithoutApproval`: `true` when the user may merge although GitHub requires an approving review. The default is `false`, and that state then blocks with exit 6.
- `optionalChecks`: list of check names (exact job name or `"Workflow / Job"`) treated as optional when `pending` or `cancelled`. The rules of built-in defaults (`workos/tars` includes `"Build & Deploy / Deploy to Production"`), `*`, the owner, and the repository add up. Required checks from branch protection/rulesets and configured reviewer checks are never ignored.

The watcher rejects a file with an unknown key. Both `watch-pr.mjs` and `pr-threads.mjs` strip ambient `GH_TOKEN` and `GITHUB_TOKEN` before running the configured GitHub CLI so account-routing wrappers always use their selected account.

## Other watchers

`gh pr checks --watch` and `gh run watch` remain correct when the question is only "did these checks finish". The stack and merge-queue watcher is `../poteto-mode/scripts/watch-pr/watch-pr`.
