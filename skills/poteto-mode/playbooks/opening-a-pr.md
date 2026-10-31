### Opening a PR

Follow the [Pi execution contract](../../../docs/harness/pi.md) and the repository's actual delivery rules.

**Worktree.** Use an isolated task worktree when the project requires one. Give concurrent writers separate worktrees. Preserve unrelated changes and never reset or overwrite someone else's work.

**Commits.** Keep changes small, coherent, and reviewable. Verify each meaningful unit and inspect the diff before committing. Preserve required public compatibility and generated surfaces.

**PR preparation.** Clean the changed diff using the Pi contract's code-cleanup procedure. Use **no-comments** when the task or project calls for it; an inline pass is self-review, not an independent reviewer. Write a concise title and description using the project's conventions and **technical-writing** / **unslop** guidance.

**Description.** Explain the user problem, what changed, material scope or tradeoffs, and actual verification. Include screenshots or video for user-visible changes when the project requires them. Report skipped or blocked checks honestly.

**Forge and stacks.** Use the repository's configured forge and credential wrapper. Stack only dependent PRs, targeting the actual parent branch. Reconcile each branch against its base; keep independent work independent. For ordered stacks, put `(n/total)` at the end of each title and update it when the stack changes.

**Readiness and follow-through.** Open PRs ready for review unless a draft was requested. Start available CI and review watches in the same turn; address failing checks and actionable findings, or give an evidence-backed rebuttal. Resolve threads when appropriate. Do not wait for unrelated slow checks before fixing a known failure. Honor actual approvals, branch protections, user holds, and `autopilot-stack`'s no-merge rule. Continue through the authorized delivery and post-merge gates rather than stopping at PR creation.

**Reply:** the PR link, scope, verification, outstanding gates, and any explicit merge hold.
