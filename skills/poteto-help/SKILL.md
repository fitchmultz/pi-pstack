---
name: poteto-help
description: Guides users through pstack setup, /skill:poteto-mode, and picking the skill, playbook, or principle for a task. Type /skill:poteto-help with a question.
---

# Poteto help

Read [the Pi execution contract](../../docs/harness/pi.md). Answer the user's help question, link the installed source, and do not start work they did not request. If they request work, follow the relevant skill and existing authorization instead.

## Get started

1. Install the package as described in `<pstack>/README.md`. It supplies skills for the latest supported Pi hosts; it does not require Cursor at runtime.
2. Invoke `/skill:poteto-mode` for a task, or use `/pstack-mode on`, `off`, and `status` to manage the persistent mode for the current session branch. Respect resource exclusions. A clear prompt names the goal, proof, and any real hold.
3. Run `/skill:setup-pstack` only if the user wants per-role model choices. Without those choices, workflows inherit the session model. Independent delegation is optional; when unavailable, workflows run the same substantive checks inline and label the loss of independence. Live interaction, real approvals, and required external gates still need their actual prerequisites.

Use the installed skill and [playbook index](../poteto-mode/SKILL.md) for current behavior. The references below provide example prompts and do not imply a scheduler, provider, or model exists.

## Pick a skill

The default answer is `/skill:poteto-mode`, which runs most of the others when its steps need them. Name a skill directly when the user wants more or less of something than the playbook gives. Read the skill before you recommend it, and give one example prompt.

| The user wants to | Skill |
|---|---|
| Do any non-trivial task with rigor | [`/skill:poteto-mode`](../poteto-mode/SKILL.md) |
| Check that the agent understood their goal and the problem before it starts | [`/skill:in-your-own-words`](../in-your-own-words/SKILL.md) |
| Get a prompt rewritten deeper, not bigger, before sending it: what a top professional would add, their raw material and methods, and an outside check. It returns the prompt and doesn't do the task | [`/skill:sharpen`](../sharpen/SKILL.md) |
| Know how code works now, or where new code should live | [`/skill:how`](../how/SKILL.md) |
| Know why code is shaped this way, or where a number came from | [`/skill:why`](../why/SKILL.md) |
| Understand a change or subsystem, explained plainly | [`/skill:teach`](../teach/SKILL.md) |
| Catch up on their own recent work on a topic | [`/skill:recall`](../recall/SKILL.md) |
| Catch up on what changed in this chat since their last message, in plain words and small visuals, with every item waiting on them listed and decidable from the reply alone | [`/skill:ketchup`](../ketchup/SKILL.md) |
| Catch up like `/skill:ketchup`, in a short subtitled video of slides, with the waiting calls as text under it | [`/skill:ketchup-video`](../ketchup-video/SKILL.md) |
| Know what a small diff could break outside itself | [`/skill:blast-radius`](../blast-radius/SKILL.md) |
| Settle types and module shape before code that crosses a function boundary | [`/skill:architect`](../architect/SKILL.md) |
| Get several attempts at one brief, merged into the best one | [`/skill:arena`](../arena/SKILL.md) |
| Run checks over slices, or race workers, using available delegation or inline | [`/skill:swarm`](../swarm/SKILL.md) |
| Review a diff with available models and try to break it | [`/skill:interrogate`](../interrogate/SKILL.md) |
| Fix a bug test-first when a cheap local test exists | [`/skill:tdd`](../tdd/SKILL.md) |
| Apply TypeScript rules to `.ts` or `.tsx` work | [`/skill:typescript-best-practices`](../typescript-best-practices/SKILL.md) |
| Review and remove unnecessary comments | [`/skill:no-comments`](../no-comments/SKILL.md) |
| Clean AI tells out of prose | [`/skill:unslop`](../unslop/SKILL.md) |
| Write docs, an RFC, a README, a PR description, or a commit message to a standard | [`/skill:technical-writing`](../technical-writing/SKILL.md) |
| Hear the last reply again in plain words | [`/skill:bro`](../bro/SKILL.md) |
| Give agents a scripted way to drive the app and prove behavior | [`/skill:create-verification-skill`](../create-verification-skill/SKILL.md) |
| Bring a verification skill and its feature map back in line with the app | [`/skill:maintain-verification-skill`](../maintain-verification-skill/SKILL.md) |
| Formally verify a race, invariant, or other property that tests rarely reach | [`/skill:create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md) |
| Bring a formal verification back in line after the code it covers changed, and learn whether a failure is drift or a bug | [`/skill:maintain-formal-verification-skill`](../maintain-formal-verification-skill/SKILL.md) |
| Show a PM or designer what the user sees as a chart checked by a TLA+ model, with the shortest path to each state that breaks a rule | [`/skill:statechart`](../statechart/SKILL.md) |
| Vet a performance number before reporting or acting on it | [`/skill:benchmark-checklist`](../benchmark-checklist/SKILL.md) |
| Run a large or cross-cutting change, or one to review after stepping away | [`/skill:figure-it-out`](../figure-it-out/SKILL.md) |
| Keep a decision log during a run, and review it afterward | [`/skill:show-me-your-work`](../show-me-your-work/SKILL.md) |
| Pick a model for each role and a reasoning budget | [`/skill:setup-pstack`](../setup-pstack/SKILL.md) |
| Turn their own working habits into a personal mode skill | [`/skill:automate-me`](../automate-me/SKILL.md) |
| Turn what a finished task taught into skill edits | [`/skill:reflect`](../reflect/SKILL.md) |
| Stop agents from repeating the same mistakes in this repo | [`/skill:correct`](../correct/SKILL.md) |
| Build a page whose buttons wake a Pi bot over a webhook | [`/skill:make-bot-ui`](../make-bot-ui/SKILL.md) |
| Find their way around pstack | `/skill:poteto-help` |

If a skill directory next to this one is missing from the table, read its frontmatter and route by its description. The `principle-*` directories are covered under principles below.

Close calls:

- `/skill:how` explains what the code does. `/skill:why` explains the reasons. `/skill:teach` runs one or both and explains the result plainly.
- `/skill:arena` gives every worker the same brief and merges the best parts. `/skill:swarm` splits work into slices or a race and returns one report.
- `/skill:architect` implements right after it settles the design. Add "with checkpoint" to review the design before it writes code.
- `/skill:interrogate` reviews the diff. `/skill:blast-radius` looks for breakage outside the diff and proves the one fact that makes the change safe.
- `/skill:recall` rebuilds context across recent chats. `/skill:ketchup` covers only this chat since the user's last message. Resuming one specific chat or branch is the Session pickup playbook.
- `/skill:figure-it-out` designs one rigorous run. The Orchestrate playbook runs a program that spans days and many PRs. The Autonomous run playbook drives one task to a finish condition.

Not every Pi host includes a browser, native UI driver, scheduler, or delegation provider. Discover actual capabilities and follow the inline route where applicable. Orchestrate is a poteto-mode playbook, not a separate pstack skill.

## Playbooks and principles

Playbooks are step lists inside `/skill:poteto-mode`, not skills, so they have no slash command. Inside `/skill:poteto-mode`, describing the task picks one, and these phrases name one directly:

- "babysit this pr" or "check on pr 123" runs Babysit. It preserves actual merge authority and user holds.
- "land the stack" runs Shipping.
- "take over this branch" runs Session pickup.
- "pause safely" runs Pause safely.
- "full autopilot on this queue" runs Autopilot-full. "autopilot, don't merge" runs Autopilot-stack.
- "run the eval playbook" runs Eval.

The [playbook index](../poteto-mode/SKILL.md) lists every playbook and when it applies. For work spanning phases or PRs, the [Multi-phase plan playbook](../poteto-mode/playbooks/multi-phase-plan.md) preserves explicit plan-only requests and proceeds when execution is already authorized. For a design question, use Prototype or architect when the task needs one.

Principles are one-rule skills used when relevant. Invoke one with `/skill:principle-<name>`, or name the principle in the request. The installed package contains their current definitions.

## Fix a run that went wrong

| Symptom | Fix |
|---|---|
| The mode is not active | Check `/pstack-mode status`, resource exclusions, and any reported forced system prompt. |
| A question got treated as the next step of the last task | Say "new task", or say the turn doesn't need the mode. |
| A new model choice had no effect | Check the configured Pi model ID, provider schema, and the actual session model. |
| Runs cost more than expected | Use the session model or fewer authorized delegates where that meets the task. |
| A skill didn't load | Check Pi discovery, resource exclusions, and invoke it by `/skill:<name>` when needed. |
| Parallel agents overwrote each other | Give independent writers separate worktrees and reconcile their changes. |
| An unattended run stopped after the session ended | Use a real scheduler when recurring wakes are required; a finite background command is not a scheduler. |
| The reply claims success from a green build | Ask for the real command, flow, stored value, or profile. That's the prove-it-works principle. |

For a run that drifts, [`references/prompting.md`](references/prompting.md) has one-line steers.

## Make pstack my own

- [`/skill:automate-me`](../automate-me/SKILL.md) drafts a personal mode skill from the user's own history, to use alongside `/skill:poteto-mode`.
- [`/skill:reflect`](../reflect/SKILL.md) after a session turns its lessons into skill edits the user approves.
- `/skill:poteto-mode write a skill for <workflow>` runs the authoring playbook. The eval playbook tests a skill change blind.
- Fix a misbehaving skill in its own PR, not inside the feature work where it went wrong.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [`references/recipes.md`](references/recipes.md) when one fits, then the link to that file. Keep it short unless the user asked for the whole map.
