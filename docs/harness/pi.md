# pstack in Pi

Read this adapter before following a pstack skill. `<pstack>` is the package directory containing `skills/`, `agents/`, and `docs/`. These Pi instructions override automatic workflow triggers and Cursor-specific tool, profile, model, and path assumptions in the upstream text, including its references and playbooks. Repository `AGENTS.md`, user authority, and safety requirements still take precedence.

## Task scope and workflow selection

These rules override poteto-mode's Non-negotiables triggers and automatic specialist steps in its playbooks.

- Investigate the facts needed to complete and verify the requested outcome. Stop expanding research once the relevant decisions are supported. Do not turn a specific request into a general policy.
- Select specialist workflows when the user names them, the repository requires them, or a concrete task need justifies them. A nontrivial change, a function boundary, or a review alone does not require `how`, `architect`, `arena`, or `no-comments`. When poteto-mode matches a playbook, select its specialist steps by this rule and mark unused steps `skip: <reason>`. Preserve the selected workflow's artifacts and checks. Use independent delegates where authorized and available; otherwise use its inline route and report the loss of independence or parallelism.
- Keep the existing design when it covers the required behavior. First-principles reasoning does not authorize a rewrite. Compare whole-design alternatives when an unresolved architectural tradeoff warrants them, not when a sufficient local change is already supported.
- Build a script or prototype when it resolves a concrete uncertainty or makes repeated work safer. Nontrivial work alone does not require a new tool.
- Reviews, comment cleanup, and broken skills do not authorize unrelated refactors or side PRs. Report out-of-scope findings without expanding the task. Preserve repository evidence requirements and explicit approval gates.

## Standalone use and prerequisites

Pi natively loads this package's skills and update/status extension. Writing, principles, TDD, local analysis, and other inline work need no sibling extension. The `pi.subagents.agents` manifest metadata is an **optional pi-subagents integration**, not a native Pi profile registry. The top-level `subagents.agents` alias is retained for older adapters.

Before starting a routed workflow, check its required capabilities against the tools and resources actually available in this session. `pstack_capabilities`, when present, reports the selected, visible tools for the current run and can show the schema and source of named tools. If the loadout changed during the run, it reports that visibility is unknown; inspect the current tools and discovery catalog rather than assuming absence. If the extension is excluded, use the model-visible tool list and advertised discovery instead. Presence does not establish permission, provider readiness, or model access.

### Choose the execution route

1. If the user or project forbids delegation, work inline. Otherwise inspect the available tool list and any advertised discovery catalog. Call a loader only when advertised, then recheck its actual schema and run controls. An installed package or familiar profile name does not prove availability.
2. Use an authorized, callable provider when it can complete the assignment in the current session while honoring the user's and project's tool, data, and write restrictions. If the provider cannot enforce a required restriction, work inline instead. Give each worker the full task, authority, evidence, and output location. A launch receipt is not a result. Observe the provider's actual completion and inspect the result before using it.
3. If no provider is reachable, the session cannot keep a child alive, or availability remains unknown after discovery, perform the same substantive work inline. Report unknown as unknown. Run distinct lenses or candidates serially and label the loss of independence, isolation, model diversity, and parallel execution where relevant.
4. If a launch outcome is uncertain, inspect the provider's run state before repeating it. If no child started, continue inline. Recheck the route before later delegation and after tool changes.

These rules apply to direct commands and nested skill reads. An inline review is `PASS (self-verified)` only after the parent performs the actual checks. When no authorized independent reviewer is available, this self-verdict replaces an upstream pstack playbook's mandatory cross-family verifier; it is not an independent review. It cannot satisfy an independent review required by the user, project, or forge. A text-only model opinion is not an independent tool-using review. Real required checks, branch protections, approvals, and explicit holds still apply. An actual failing review is not reviewer unavailability.

- `poteto-mode` supplies its inline style and principles without delegation. A missing required live driver or other real prerequisite remains a gap; do not substitute a simulation for a live verification.
- `/pstack-mode on|off|status` controls the persistent poteto-mode instructions for the active session branch. The setting follows saved-session resume and tree navigation. If this package's skill is excluded or another extension forces the system prompt, follow the reported limitation rather than assuming the mode was applied.
- Live UI/TUI proof needs an actual driver for that surface. A repository-owned Playwright, PTY, simulator, or HTTP harness can suffice. Otherwise discover a suitable tool/skill if advertised. If no driver can exercise the required interaction, report the blocked proof. Source review, screenshots without interaction, and unit tests do not substitute for it.
- Preserve user questions and approval gates. Ordinary conversation can ask a question and wait for the user's answer when no dialog tool exists. Never substitute a default answer for required approval.

## Tools

| Cursor | Pi |
| --- | --- |
| `Task` | Use an available delegation provider's actual schema. Current pi-subagents exposes `delegate` and `agent_runs`. Profile-based providers may advertise `subagents_enable` and `subagent`; call their loader and discover profiles when available. Use only advertised entry points. Otherwise perform the work inline and report the loss of independence or parallelism. |
| `AskQuestion` | Use an available question tool, or ask in conversation and wait. With `ask_question`, order options from most recommended to least; Pi adds its own custom-answer option. |
| Open a todolist | Keep a concise checklist in the reply or a task-owned file. Use `notes` only if available. |
| Run another pstack skill (`/name` or "the **name** skill") | Resolve the installed skill through Pi's resource discovery, then read its `SKILL.md` in full and check prerequisites. Honor resource exclusions instead of bypassing them by reading a filtered skill directly. User-facing invocations are `/skill:<name>`. |
| `/deslop` | Apply the code-cleanup procedure below. A separately installed `deslop` skill is optional. |
| `control-cli` | Use the repository's real CLI/TUI driver or a discovered terminal-control capability. A bounded CLI command can run through native `bash`; interactive TUI proof requires a PTY or equivalent driver. No `interactive-testing` skill is assumed. |
| `control-ui` | Use a repository-owned UI harness or available browser/native-app tools. `dogfood` and `macuse` skills are optional, not prerequisites supplied by Pi. Stop if the required live interaction cannot be driven. |
| `/loop` | For a finite watcher, use `background_command` if available, or a bounded native `bash` command such as `gh pr checks --watch`. Neither a foreground command nor a task checklist supplies persistent periodic wakeups. If the workflow needs unattended recurring wakes and no scheduler is available, report the missing capability and stop that phase. |
| `/create-skill` | Write `SKILL.md` in `.pi/skills/<name>/` or `~/.pi/agent/skills/<name>/`, following existing repository skill checks. `/reload` refreshes native discovery. No separate authoring skill is required. |
| `Grep`, `Glob` | Native `bash` with `rg` / `find`, and `read` for file contents. |

### Code cleanup

Inspect the changed diff and surrounding contracts. Remove redundant narration, speculative scaffolding, forwarding-only helpers, unjustified casts or suppressions, and catches that hide failures. Preserve behavior, validation, error identity, cleanup, accessibility, and necessary comments, including `ponytail:` ceilings and repository-required evidence. Use the repository's formatter and required checks, then inspect the resulting diff. This cleanup is not an independent review and does not replace a reviewer required by the task.

## Delegation fields and profiles

The following examples cover current pi-subagents and older profile-based providers, not native Pi APIs. Use the selected provider's actual schema. Do not pass unsupported fields or silently discard a required capability.

| Cursor | Pi with a delegation provider |
| --- | --- |
| `subagent_type: generalPurpose` | With `delegate`, put role requirements and authority in the complete assignment. With a profile-based provider, discover a suitable profile. This describes a role, not a guaranteed profile name. |
| `poteto-agent`, `comment-sicko` | Use these package-owned profiles only if the provider discovers them. With `delegate`, put the corresponding `<pstack>/agents/*.md` instructions or readable paths in the assignment. Preserve Comment Sicko's report-only boundary. If no independent session is available, follow the same role instructions inline and label the review self-performed. |
| `readonly: true` | Explicitly forbid edits in the assignment. Use a read-only profile if the provider supplies one. Pi does not have Cursor's readonly/Ask mode or its claimed automatic MCP removal. Honor the provider's actual tool restrictions. |
| `readonly: false` | State the assignment's write authority. Choose an execution profile only if the provider uses profiles. This does not grant unrelated writes. |
| `environment: "cloud"` | Use the provider's supported isolation for parallel writers, or prepare separate worktrees and pass each provider's supported cwd. Pi does not supply Cursor cloud VMs. If independent isolation is unavailable, run the work serially and say so. |
| `environment: "local"` | Run in the intended local cwd, preserving shared-worktree safety. |
| `cloud_base_branch: <b>` | Name branch `<b>` and the exact starting revision in the isolated worker's brief. |
| `run_in_background: true` | Current pi-subagents launches asynchronously and rejects `async` fields and `agent_runs.wait`. Completion notifications require a persistent main. In one-shot print or a child session where this provider cannot finish, do the work inline rather than launching children that will be stopped. Otherwise launch authorized work, continue independent work, and inspect completed results. |
| `resume` | Current pi-subagents uses `agent_runs({ action: "continue", id, prompt })` and returns a receipt. Older profile-based providers may use `subagent({ action: "resume", id, message })`. |
| `file_attachments` | With advanced `subagent`, use `reads: ["path/to/file"]`; otherwise put readable paths and required original instructions in the task brief. |

Profiles supply defaults, not the original task. The parent supplies requirements, settled decisions, scope, evidence, authority, acceptance, verification venue, output paths, and stop conditions. The parent reviews and integrates results. Never assume a generic profile exists, or count the parent's own second pass as an independent agent.

## Models

Pi model IDs are `provider/model`, with `:effort` where the selected delegation provider supports that syntax. Cursor slugs such as `claude-<family>-<version>-<effort>[-fast]`, `grok-*`, and `gpt-*` are not proof of an available Pi model or provider.

- Pi does not load the `pstack-models.mdc` rule. If `~/.pi/agent/pstack-models.md` exists, read it for explicit per-role choices. Preserve those choices; do not overwrite the file during ordinary work or write model policy into `AGENTS.md`.
- Without a configured choice, ordinary jobs inherit the current session model by omitting the model override. No Cloudflare route, sibling profile default, or hard-coded model catalog is assumed. The optional bundled profiles likewise inherit the host model.
- Resolve explicit choices against the selected host's available models and the delegation provider's contract. `auto` and `inherit-parent` mean the parent session model, not an unrelated profile's pinned model. Use the provider's actual inheritance option or the parent's verified model ID when omission would use a different default.
- When diverse models or families are available and authorized, use actual configured IDs. Otherwise continue with the available route and report the missing diversity; never silently present repeated parent-model work as a diverse panel.
- `pstack_opinion` can request a text-only opinion from an explicitly configured `provider/model` using only the material supplied in the call. It has no tools or independent repository access. It is not a delegated reviewer, a verified finding, or a replacement for required panel seats.
- `/skill:setup-pstack` writes `~/.pi/agent/pstack-models.md` in Pi. Detect real available IDs, preserve existing choices, ask the stated budget/selection questions, and validate before writing. Map effort to the host/provider's supported levels, not Cursor's slug ladder. A missing discovery API is a reason to request the required model information, not to invent defaults.

## Paths and history

| Cursor | Pi |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.pi/skills/`, `~/.pi/agent/skills/` |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | The actual loaded package root and `package.json`. Do not assume a git install location. |
| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md` for project policy; `~/.pi/agent/pstack-models.md` for optional model choices. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | `history` is optional. Use the current session's provided path or an explicitly selected workspace's session JSONL under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/`. Do not search unrelated workspaces or private chats. Without a transcript, use a tight digest of this conversation and disclose the gap. |

## Cursor-only features and the Pi bot

`make-bot-ui` builds a user-owned authenticated webhook receiver and a dedicated Pi RPC session; it does not require a Cursor routine. Real browser access, a running host, and any requested tailnet or scheduler remain prerequisites.

Cursor Automations (`benny`), Bugbot auto-triggers, and Cursor Cloud VMs have no native Pi equivalent. State the missing capability when a user explicitly requires one. Skip a step only when it is genuinely optional and report the omission. Do not claim the full outcome after dropping a required step.
