---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Adversaries try to break a change or design, and only findings proven by a run survive."
disable-model-invocation: true
---

# Interrogate

Read [the Pi execution contract](../../docs/harness/pi.md) and select the authorized delegated or inline route. Recheck before delegation. Report self-performed work and any loss of independence, isolation, model diversity, or parallelism.

Adversaries try to break a change or a design. A finding survives only when a run proves it. Report the findings. Do not apply fixes.

## Frame

The scope is what the user names. Otherwise it is the branch diff from its merge base with the base branch, through the working tree. State the intent with the **in-your-own-words** skill, from the user's message, the commits, and the PR description. Ask the user when the intent is unclear.

## Attack passes

Run Phase A steps 3 and 4 and Phase B of the **arena** skill with distinct adversarial lenses. Use configured `interrogate reviewers` choices when available. Give each authorized reviewer an isolated copy of the scope, including uncommitted changes, and this brief. Without a provider, run the same attack passes serially yourself; keep their repros separate and label the review self-performed.

> Break this change. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros in your own worktree. Report each finding with a title, the exact command, the output it printed, and the output the intent requires. Leave out anything you did not run. That covers style, naming, structure, and risks that need a future change to matter. No findings is a valid result.

## Verify

Verify each finding per arena Phase F by rerunning its command. Keep a finding when the output shows the failure and the failure breaks the intent. Drop the rest. Merge findings that share a root cause.

Skip arena Phases C, D, and E. Attack passes find different failures, so the verdict keeps every verified finding, not one reviewer's list.

## Output

- **Intent**: the restatement.
- **Findings**: for each verified finding, the command, its output, how it breaks the intent, and the review lens that found it. Say "no verified findings" when none survive.
- **Dropped**: for each lens, the count of dropped findings and why. State whether the passes were independent or self-performed.
