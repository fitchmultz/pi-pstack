# pstack in Pi

pstack skills use Cursor names. In Pi, read this file once per session, then map each Cursor name in a skill with the tables below. `<pstack>` means the package root folder that holds `skills/`, `agents/`, and `docs/`. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

Repository `AGENTS.md` rules (including mandatory evidence and pushback gates, upstream reporting stop gates, and shared-worktree safety) outrank generic `pstack` autonomy instructions.

## Tools

| Cursor | Pi |
| --- | --- |
| `Task` | `subagent` or `delegate` (call `load_subagent({})` first if inactive). |
| `AskQuestion` | `ask_question`. List options from most recommended to least; do not add a custom-answer option (Pi adds one automatically). |
| Open a todolist | Keep a concise checklist in your current-state `notes` or reply, updating it at each phase. |
| Run another pstack skill (`/name` or "the **name** skill") | `read` `<pstack>/skills/<name>/SKILL.md` in full and follow it. When telling the user to invoke a skill directly, write `/skill:<name>`. |
| `/deslop` | `read` the installed `deslop` skill from `pi-agent-skills` (`/skill:deslop`). |
| `control-cli` | Load the `interactive-testing` skill (controlled tmux terminal). |
| `control-ui` | Load the `dogfood` skill (browser/Electron/VFR) or `macuse` skill (native macOS UI). |
| `/loop` | Use `background_command` (`action: "start"`) for finite watchers like `watch-pr`. End the turn and wait for automatic completion delivery instead of polling. |
| `/create-skill` | Author `SKILL.md` directly in `.pi/skills/<name>/SKILL.md` or `~/.pi/agent/skills/<name>/SKILL.md` and validate with `/reload`. |
| `Grep`, `Glob` | `bash` with `rg` / `find`, and `read` for file contents. |

## Subagent fields

| Cursor | Pi (`subagent` / `delegate`) |
| --- | --- |
| `subagent_type: generalPurpose` | Use the matching Pi profile (`worker` for implementation, repairs, or generic execution, `scout` or `researcher` for read-only recon/investigation, `planner` for planning, or `reviewer` / `reviewer-claude` for review). |
| `poteto-agent`, `comment-sicko` | `agent: "poteto-agent"` or `agent: "comment-sicko"` (registered via `pi-pstack`'s `subagents.agents` manifest). |
| `readonly: true` | Use a read-only profile (`scout`, `researcher`, `reviewer`, `comment-sicko`) and state in the task brief not to edit files. |
| `readonly: false` | Use `poteto-agent` or `worker`. |
| `environment: "cloud"` | `worktree: true` for isolated parallel writers. Name the base branch or commit in the brief when needed. |
| `environment: "local"` | Omit `worktree` (or set `worktree: false`). |
| `cloud_base_branch: <b>` | Instruct the child to start from branch `<b>` in an isolated worktree. |
| `run_in_background: true` | Default in Pi (`async: true` is the stock top-level default). Launch parallel tasks with `subagent({ tasks: [...] })` or separate `delegate` runs, then end the turn and wait for automatic completion. |
| `resume` | `agent_runs({ action: "continue", id, message })` or `subagent({ action: "resume", id, message })`. |
| `file_attachments` | Pass `reads: ["path/to/file"]` in `subagent` tasks or list the file paths in the task brief. |

Profiles supply short role defaults. The parent supplies original requirements and settled decisions or readable references, scope, relevant evidence, authority, acceptance criteria, verification commands and execution venue, output instructions, and stop conditions. For a simplicity pass, brief `reviewer` to preserve required behavior and safety while identifying what can be removed.

## Models

| Cursor | Pi |
| --- | --- |
| `claude-<family>-<version>-<effort>[-fast]`, such as `claude-opus-5-5-xhigh` | `model: "cloudflare-ai-gateway/claude-opus-5-5:xhigh"` (or omit `model` when using `planner` / `reviewer-claude` so profile fallbacks remain active). Drop `-fast`. |
| `grok-4.7-xhigh-fast` or other `grok-*` / `gpt-*` code/exploration defaults | Omit `model` to use the selected Pi profile's default (`cloudflare-ai-gateway/gpt-6.1-sol:xhigh` with `cloudflare-ai-gateway/claude-opus-5-5` fallback), or pass `model: "cloudflare-ai-gateway/gpt-6.1-sol:<effort>"` when pinning a panel arm in `arena` / `interrogate`. |
| `auto` or `inherit-parent` | Omit `model`. |
| The `pstack-models.mdc` rule | Pi does not load `.cursor/rules/pstack-models.mdc`. If `~/.pi/agent/pstack-models.md` exists, read it for per-role `provider/model:effort` overrides; otherwise use the Pi profile defaults above. Never write role lines into `AGENTS.md`. |

## Paths

| Cursor | Pi |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `.pi/skills/`, `~/.pi/agent/skills/` |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/git/github.com/fitchmultz/pi-pstack/`, `package.json` |
| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md` for project rules; `~/.pi/agent/pstack-models.md` for optional per-role model overrides. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | Use Pi's native `history` tool (`history({ op: "search", query })` and `history({ op: "read", id })`) or read session JSONL files under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/` for the current workspace only. |

## Comment Sicko & Autonomy Rules in Pi

- **Preserve `ponytail:` and policy comments:** In `/skill:no-comments` and `comment-sicko`, deliberate-shortcut comments marked with `ponytail:` and required repository comments (such as GitHub issue numbers on regression tests) are on the protected keep-list and must never be deleted.
- **Cursor-only features:** Cursor Automations (`benny`), Grok Bot `update_state` / `SendToUser` webhook routines (`make-bot-ui`), Bugbot auto-triggers, and Cursor Cloud VMs have no native Pi equivalent. When a skill step references one, state that clearly, skip that Cursor-only step, and continue with native Pi tools.
