---
name: swarm
description: "Cover slices or compare candidates and return one report. Use for /skill:swarm, coverage, races, gauntlets, and exploration."
---

# Swarm

Read [the Pi execution contract](../../docs/harness/pi.md) and select the authorized delegated or inline route. Recheck before delegation. Report self-performed work and any loss of independence, isolation, model diversity, or parallelism.

## Start

Track one entry per phase before starting, using an available task list, a task-owned file, or the conversation.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Use the `swarm workers` choice from `~/.pi/agent/pstack-models.md` when configured and available; otherwise inherit the session model. For a model race, name each actual model up front. If the requested diversity is unavailable, report that limitation rather than inventing a model.
4. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Execute

With an authorized provider, launch the N workers using its actual schema and isolated output locations. Name the branch and revision when a worker must start from a particular state. A worktree is not a cloud VM.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

Without a usable provider, execute the same slices or candidates serially yourself, preserve their outputs and the declared selection rule, and report the loss of parallel and independent workers. For `first pass`, stop only after a candidate actually meets the predicate. If a worker drops out, note it and cover required slices yourself or report the gap.

## Phase C: Aggregate

Read the completed results. Reject a result that does not record the SHAs and method its brief names, then redo that slice or record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, and the race rule when used.
