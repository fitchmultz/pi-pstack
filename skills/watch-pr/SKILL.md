---
name: watch-pr
description: "Wait for a GitHub PR's checks, reviews, or merge readiness with one background watcher, not a hand-written loop."
---

# Watch a pull request

Read [the Pi execution contract](../../docs/harness/pi.md).

Use the watcher to wait until one GitHub pull request can be merged, or to learn what blocks it. It checks four things on the head commit: the checks finished, the required reviewers signed off, the review threads are resolved, and GitHub can merge. Do not write your own check loop. Do not add separate reads after `gh pr checks --watch`.

The watcher only reads from GitHub. It does not merge, comment, rerun or resolve.

## Start the watcher

Start `scripts/watch-pr.mjs` from this skill's directory with `background_command`. Then do other work or end the turn. Do not poll the job.

```json
{"action":"start","command":"node SKILL_DIRECTORY/scripts/watch-pr.mjs https://github.com/OWNER/REPO/pull/123"}
```

- Name the pull request by URL, or by number with `--repo OWNER/NAME`. A number without `--repo` refers to the `origin` remote of the current directory.
- `--timeout SECONDS` ends the watch after that time. The default is 3600. `0` waits without limit.
- `--interval SECONDS` is the time between reads. The default is 60.
- `--once` prints the verdict for the current state and exits. Run it with `bash` to look without waiting.
- Without `background_command`, run the watcher with `bash` and a `--timeout` below the `bash` time limit.
- Start one job for each pull request.

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
  TARS review: passed on 6e9e001
unresolved review threads: 1
  app/lib/dedup.ts:208 @reviewer: Use the existing indexed predicate ...
merge: MERGEABLE; GitHub merge state CLEAN; review decision none
```

| Exit | First line | Meaning |
| --- | --- | --- |
| 0 | `READY` or `MERGED` | Every rule passed on the named commit, or the pull request is merged. |
| 2 | `BLOCKED: merge conflicts ...` | Resolve the conflicts. |
| 3 | `BLOCKED: N unresolved review threads` | Fix or rebut each thread, then resolve it. |
| 4 | `BLOCKED: N checks failed` | The block links each failed check. |
| 5 | `BLOCKED: timed out ...` or `BLOCKED: not ready ...` | Something is still running or has not started. The line says what. |
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
- **Checks that have not started.** A commit with no failed and no pending check is not ready while an expected check is absent. Expected checks are the status checks that the base branch requires, and each workflow that every push to the pull request starts. A workflow with a path or branch filter and no run is unknown, unless another run of the same event exists on the commit. A commit with no checks and no expected check is unknown.
- **Reviewers.** Only rules from the configuration count. A sign-off counts only on the head commit. Without a rule, the block says `reviewers: no rule for OWNER/REPO`.
- **Threads and merge state.** Every unresolved review thread blocks. Conflicts, a draft, requested changes and a head behind its base block.

## Configure it

The watcher reads `watch-pr.json` in the Pi agent directory (`${PI_CODING_AGENT_DIR:-~/.pi/agent}`), or the file that `WATCH_PR_CONFIG` names. Without the file, it runs `gh` and requires no reviewer. Copy [config.example.json](config.example.json) to begin.

Each key is `*` for every repository, an owner, or `OWNER/REPO`. Each value can contain:

- `gh`: the GitHub CLI executable for these repositories. The most specific key wins. `WATCH_PR_GH` overrides it for one run.
- `reviewers`: reviewers that must sign off. The rules of `*`, the owner and the repository all apply.
  - `{"name", "check"}`: a check with this name must pass on the head commit.
  - `{"name", "author", "verdict", "pass", "commit"}`: the newest comment or review by `author` that matches the `verdict` pattern must capture the text `pass`. The `commit` pattern must capture the head commit from the same text. A review that does not match `commit` counts for the commit that GitHub recorded for it. Each pattern is a JavaScript regular expression with one capture group.
- `mergeWithoutApproval`: `true` when the user may merge although GitHub requires an approving review. The default is `false`, and that state then blocks with exit 6.

The watcher rejects a file with an unknown key.

## Other watchers

`gh pr checks --watch` and `gh run watch` remain correct when the question is only "did these checks finish". The stack and merge-queue watcher is `../poteto-mode/scripts/watch-pr/watch-pr`.
