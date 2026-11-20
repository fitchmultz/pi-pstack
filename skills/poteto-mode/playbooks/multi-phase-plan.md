### Multi-phase or multi-PR plan

**Own an actionable, evidence-backed plan.** Follow the [Pi execution contract](../../../docs/harness/pi.md). If the user requested only a plan, stop after presenting it. If execution is already authorized, continue under that authorization rather than inventing another hold.

1. When the change is one or two files with an obvious approach, skip the plan. Say so and stop.
2. Settle open observable questions from source or a prototype before writing, per `playbooks/prototype.md`. Ask the operator only about a product or preference call that no run can settle.
3. Write the plan file. Open with what changes, the PR ids in landing order, and the dependency graph, naming which PRs are independent and branch from trunk in separate worktrees, which wait for which, and the files each may touch. Then include one section per PR (the **sequence-verifiable-units** principle skill) with checkboxes for what it depends on, the files it edits, the one change it builds, the observable result, and its verification.
4. Plan verification that matches the change and its user-facing consequences: relevant unit checks, real user-flow or runtime proof on the actual surface, and performance measurements (metric, probe, baseline, failure rule) when the task or observed risk requires them. State why a category is not applicable rather than inventing lanes, thresholds, or baselines. Preserve the project's required checks, reviews, branch protections, screenshots, approvals, and user holds. Use independent reviewers when available; otherwise plan the same real checks and label self-verification. A missing real driver or scheduler is a named gap, not a simulated pass.
5. Hand back the plan path and stop if the request is plan-only; otherwise continue under the user's existing authorization.

**Reply:** the plan path, the PR ids with their dependencies and actual review gates, and what stays unproven.
