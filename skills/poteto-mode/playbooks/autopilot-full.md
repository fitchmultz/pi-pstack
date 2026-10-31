### Autopilot-full

**Own each PR's result through the permitted delivery gate.** Follow the [Pi execution contract](../../../docs/harness/pi.md). Use independent owners and verifiers when authorized and available; otherwise do their work serially and label self-verification.

1. **Honor the operator's gates.** The grant covers only the named queue. Stop items explicitly reserved for the operator at merge-ready. Preserve actual approvals, branch protections, and holds.
2. **Build each PR.** Give an authorized owner the complete scope, evidence, verification, and branch authority, or perform the work yourself. Use separate worktrees for concurrent writers. Open a reviewable PR, clean the diff, run the real checks, and record the code-ready head and decision trail. Use the project's forge and credential conventions.
3. **Run independent work concurrently where possible.** Base unrelated PRs on the current trunk. Without providers, complete the same units serially; do not claim separate owners or parallel execution.
4. **Verify each candidate.** Use independent tool-using reviewers when available. Otherwise perform the same real checks and user-flow verification yourself and record `PASS (self-verified)` or the actual failure. A model-only opinion is not an independent verifier. Resolve or substantively rebut actual review findings; green CI alone is not proof of the user flow.
5. **Land only verified work when authorized.** Confirm the verdict still covers the patch, required CI is green at the head, the tested base is current enough for the change, and all real gates are satisfied. Recheck affected work on the merge result when the base changes. Follow **shipping** and **babysit** through actual merge and delivery; never bypass forge protections.
6. **Supervise until done.** Use available completion notifications or finite watchers. For recurring unattended supervision use a real scheduler or long-lived host and report any missing capability. A stopped parent cannot keep reasoning. Inspect actual state before repeating an uncertain launch or mutation.
7. **Honor a stop immediately.** Propagate the hold to active workers, preserve their state, and resume only when the hold is released.

**Reply:** each PR's live state and verdict, what merged, open operator gates, and follow-ups, with links to PRs and trails.
