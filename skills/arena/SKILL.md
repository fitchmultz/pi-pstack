---
name: arena
description: "Compare candidates for the same task, pick a base, and graft the strongest parts of the others. Use for /arena or when one attempt would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Read [the Pi execution contract](../../docs/harness/pi.md) and select the authorized delegated or inline route. Recheck before delegation. Report self-performed work and any loss of independence, isolation, model diversity, or parallelism.

Open a todolist with one entry per phase (Frame, Candidates, Cross-judge, Pick, Graft, Verify) before starting.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Choose the candidate count and the distinct directions needed for this task. Honor the caller's count. For architecture, produce at least two structurally distinct candidates. Use configured `arena runners` choices from `~/.pi/agent/pstack-models.md` when present and available; otherwise inherit the session model. Do not invent model IDs or claim diversity you did not obtain.
4. Give each candidate its own output location (a git worktree where appropriate, otherwise a task-owned candidate directory), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Candidates

With an authorized provider, launch candidates with its actual schema and lifecycle. Give each the same task, shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming alternatives considered and rejected. Read actual completed results.

Without a usable provider, create the same candidate artifacts serially in their own locations. Record that there was no parallel race or independent author. If a candidate produces no output, report the dropout; create a replacement when the required candidate count is not met.

## Phase C: Cross-judge

After all candidates finish, request an independent read-only judge when an authorized provider and suitable model are available. Give it the rubric and candidate paths; it scores each criterion and recommends a base with rationale. Do not start it while candidates are still writing.

Otherwise score each candidate yourself against the same rubric and state that the judge was not independent. An optional `pstack_opinion` may provide a text-only perspective on supplied material, but cannot inspect files or count as a tool-using judge.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with an independent cross-judge when one ran. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict or that Phase C skipped the judge, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.
