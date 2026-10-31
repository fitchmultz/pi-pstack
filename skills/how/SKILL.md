---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
---

# How

Read [the Pi execution contract](../../docs/harness/pi.md) and select the authorized delegated or inline route. Recheck before delegation. Report self-performed work and any loss of independence, isolation, model diversity, or parallelism.

Explore the codebase to answer "how does X work?" questions. Produce architectural explanations at the level of a senior engineer onboarding onto a subsystem, enough to build a working mental model, not so much that it reads like annotated source code.

Use authorized read-only explorers and an explainer when a provider can supply them. Honor available `how explorer` and `how explainer` model choices from `~/.pi/agent/pstack-models.md`; otherwise inherit the session model. Without a usable provider, read the same sources and perform the same exploration and synthesis yourself. Label the explanation self-performed, not an independent review.

## 1. Assess complexity

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

- **Simple** (a single module, a small utility, a narrow question such as "how does function X work"): explore and explain in one pass using `references/explainer-prompt.md` without the explorer-findings section. Go to step 4.
- **Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview): go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Decompose the question into 2 to 4 angles, each a distinct slice of the subsystem. Give each authorized explorer `references/explorer-prompt.md` with its angle, or investigate each angle serially yourself.

## 3. Synthesize (complex only)

Once the exploration is complete, synthesize with `references/explainer-prompt.md` and every finding, or give the same material to an authorized explainer.

## 4. Present

Present the explanation, verify its source citations, and identify whether it was self-performed.

## Output format

The explanation uses the sections defined in `references/explainer-prompt.md`, dropping any that do not apply: Overview, Key Concepts, How It Works, Where Things Live, Gotchas.
