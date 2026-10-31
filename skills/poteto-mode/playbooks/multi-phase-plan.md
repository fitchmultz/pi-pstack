### Multi-phase or multi-PR plan

**Own an actionable, evidence-backed plan.** Follow the [Pi execution contract](../../../docs/harness/pi.md). If the user requested only a plan, stop after presenting it. If execution is already authorized, continue under that authorization rather than inventing another hold.

1. Ground the goal, current system, constraints, and actual user flow. Resolve observable questions from source or a real prototype; ask only for a user-owned decision. Use authorized explorers or investigate serially yourself and label the loss of independence.
2. Divide work into small, reviewable PRs with explicit dependencies. Independent work can proceed concurrently in separate worktrees. Name the execution playbook, owner or inline route, merge authority, and real holds.
3. For every PR, name the change, observable result, relevant unit checks, and real user-flow or runtime proof. Plan performance measurements only when the task or observed risk needs them. State why a category is not applicable rather than inventing lanes, thresholds, or a baseline.
4. Preserve the project's required checks, reviews, branch protections, screenshots, approvals, and user holds. Use independent reviewers when available; otherwise plan the same real checks and label self-verification. A missing real driver or scheduler is a named gap, not a simulated pass.
5. Use `node <pstack>/skills/poteto-mode/scripts/check-plan.mjs <plan.md>` to check the structure. Fix reported problems without replacing actual verification with placeholder text.

A plan can use this skeleton. Adjust the examples to the real task and keep one section per PR.

````markdown
# <Program> plan

<Who benefits, the goal, and the intended sequence.>

## How to read this

One box is one unit of work and names the evidence. Check a box only when its evidence exists. Follow `playbooks/<execution playbook>.md`. Verification must match the change and its user-facing consequences.

## Program checklist

### Arm the program
- [ ] Record authorization, holds, and the execution playbook.
### Assign work
- [ ] Name owners or the inline route, dependencies, and isolated worktrees.
### PR mechanics
- [ ] Open reviewable PRs and start the actual check and review watchers.
### Verdict and merge
- [ ] Verify each head and preserve required approvals and the merge boundary.
### Boot recipe
- [ ] Name the real host, setup, and driver where live verification needs one.

## <Task> (<PR id>)

**Depends on.** <PR id or None.>
**Files.**
- [ ] <Paths and intended changes.>
**Build.**
- [ ] <One concrete change.>
**You see.**
- [ ] <Observable result.>
**Verify, unit.** Verification must match the change and its user-facing consequences.
- [ ] <Relevant command and expected result.>
**Verify, live.** Verification must match the change and its user-facing consequences.
- [ ] <Real user flow or runtime command.> Pass when <observable result>.
**Verify, perf.** Verification must match the change and its user-facing consequences. Not applicable. <Reason, if performance is not part of the task.>
**Review gate.** None. <Reason, if no additional user gate was requested.>
**Merge.**
- [ ] <Actual authorized merge or handoff rule.>

## Close the program
- [ ] Confirm evidence, reviews, required checks, and the actual outcome.

## Appendix A. Prototype evidence
<Observed evidence and unresolved questions.>
## Appendix B. Alternatives rejected
<Alternatives and reasons.>
## Appendix C. Risks
<Concrete risks and owners.>
## Appendix D. Links and reading list
<Source and documentation needed for the work.>
````

When performance matters, replace `Not applicable` with Metric, Probe, Baseline, and Rule boxes based on the user's target or measured behavior. For a user-visible change, use the real surface and any screenshots or review gate the project actually requires. Keep exact-head checks and verdicts current.

**Reply:** the plan path, PR dependencies, actual review gates, evidence, and unresolved questions. Continue implementation if it is already authorized.
