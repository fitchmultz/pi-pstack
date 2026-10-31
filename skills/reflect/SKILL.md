---
name: reflect
description: Review the active transcript through three lenses, surface learnings, and route each to a concrete skill edit. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Read [the Pi execution contract](../../docs/harness/pi.md) and select the authorized delegated or inline route. Recheck before delegation. Report self-performed work and any loss of independence, isolation, model diversity, or parallelism.

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Use the current session's provided transcript path or Pi's available history tool. Do not search unrelated workspaces or private chats. If the current transcript is unavailable, use a tight digest of this conversation and disclose the gap.

## 2. Review three lenses

Use authorized reviewers when a provider can give them the necessary read access and preserve the user's restrictions. Otherwise review each lens yourself, serially, and state that the lenses are not independent. Honor configured Pi model-role choices when available; do not invent model IDs. Look up cited tickets, threads, and traces only through authorized tools.

| Lens | Prompt template |
|---|---|
| Judgment | `references/judgment-reviewer.md` |
| Tooling | `references/tooling-reviewer.md` |
| Divergent | `references/divergent-reviewer.md` |

Use each template with the transcript path or digest where marked. Collect findings and evidence for all three lenses.

## 3. Synthesize

Use `references/synthesizer.md` with all three findings to produce an Accepted / Rejected / Backlog list. Spot-verify citations against the actual available sources. An authorized delegate can synthesize; otherwise do this yourself and label it self-performed.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Before approval, show each destination, such as `.pi/skills/<skill>/` or `~/.pi/agent/skills/<skill>/`. Edit the authorized source after approval, not an installed package cache. Never open a PR or push for this workflow.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit: draft, test against the real task, and iterate using the project's skill-authoring procedure.
- `tune description: <skill path>`: adjust the description and test discovery and triggering.
- `new skill: <kebab-name>`: create a native Pi skill following the project's authoring procedure and test it against the real task.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
