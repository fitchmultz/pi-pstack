### Orchestrate

**Coordinate a standing program and account for every unit.** Follow the [Pi execution contract](../../../docs/harness/pi.md). One task driven to a predicate is Autonomous run; one ambitious bespoke run is figure-it-out.

1. **Track the program.** Keep the goal, scope, decisions, dependencies, owners, evidence, PR states, and holds in a task-owned tracker. Use available notes or files; verify live state after a restart.
2. **Assign coherent units.** With authorized providers, give each owner the complete goal, permitted paths and actions, required proof, dependencies, and output location. Use separate worktrees for concurrent writers and the provider's actual lifecycle. A worktree is not a cloud VM. Without providers, complete the same units serially yourself and report the loss of parallel autonomous ownership.
3. **Ground repeated work.** Verify a representative unit before repeating an uncertain pattern. Preserve real user approvals and holds; unrelated work can proceed independently.
4. **Verify and supervise.** Read each diff and artifact, check live PR and CI state, and inspect actual completed worker results rather than trusting launch receipts or summaries. Use an independent verifier where available; otherwise run the same checks and label `PASS (self-verified)`. Reproduce findings or report a real gap. Keep every worker accounted for as completed, stopped, or replaced.
5. **Use actual watches.** Start finite PR or CI watchers when available. A recurring unattended audit needs an available scheduler or long-lived host. Do not claim that a stopped parent continues reasoning. Inspect uncertain launches before repeating them.
6. **Handle change and stop.** Reconcile independent work against current trunk without expanding scope, address failures, and honor the user's explicit hold or stop. Ask only for a real decision or blocker that requires the user.

**Reply:** what landed against the goal, each PR's live state and verdict with a link, what was dropped and why, and decisions waiting on the user.
