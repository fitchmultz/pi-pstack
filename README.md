# pi-pstack

Pi package adapter for [Cursor's `pstack`](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (`poteto`).

## What this package provides

- **All 56 core `pstack` skills** (`./skills`), including `/skill:poteto-mode` (23 playbooks), all 24 `principle-*` skills, `/skill:how`, `/skill:why`, `/skill:architect`, `/skill:arena`, `/skill:swarm`, `/skill:interrogate`, `/skill:tdd`, `/skill:bro`, `/skill:unslop`, `/skill:no-comments`, `/skill:ketchup`, `/skill:recall`, `/skill:reflect`, `/skill:correct`, `/skill:teach`, `/skill:sharpen`, `/skill:in-your-own-words`, `/skill:figure-it-out`, `/skill:show-me-your-work`, `/skill:technical-writing`, `/skill:typescript-best-practices`, `/skill:benchmark-checklist`, `/skill:blast-radius`, `/skill:create-verification-skill`, `/skill:maintain-verification-skill`, `/skill:create-formal-verification-skill`, `/skill:maintain-formal-verification-skill`, `/skill:automate-me`, and `/skill:setup-pstack`.
- **Optional delegation profiles** (`./agents`): `poteto-agent` and `comment-sicko`. The profile-based `pi-subagents` npm package discovers them through `pi.subagents.agents` in the manifest. The top-level `subagents.agents` alias is retained for older adapters; native Pi does not consume either profile-metadata key. `@fitchmultz/pi-subagents` does not read profiles: its `delegate` tool takes the complete assignment, so include a profile's instructions or readable path as [`docs/harness/pi.md`](./docs/harness/pi.md) describes. No sibling's generic profiles are assumed or copied.
- **Pi harness adapter** ([`docs/harness/pi.md`](./docs/harness/pi.md)): defines task scope, workflow selection, native tool/path mappings, capability checks, standalone code cleanup, model inheritance, and `ponytail:` / `AGENTS.md` protections. Ordinary changes do not require architecture competitions or new tools. Explicitly selected workflows retain their required panels and checks. Its Pi rules override broader workflow triggers and Cursor assumptions in the bundled upstream skills and playbooks.
- **Automated upstream sync & notifications**:
  - `.github/workflows/sync-upstream.yml` polls `cursor/plugins` (`pstack/`) every 6 hours, runs `scripts/sync-pstack.mjs`, `npm run check:compat`, and the exact-host qualification in `scripts/qualify-hosts.mjs`, and commits updates to `main` only when all of them pass.
  - Pi's built-in interactive startup package checker detects new commits on `fitchmultz/pi-pstack` and displays the native `Package Updates Available` banner (`pi update --extensions`).
  - `extensions/index.js` also performs a non-blocking, cached (6h TTL) check against `cursor/plugins/pstack` on interactive startup and provides `/pstack-status` so upstream commits are surfaced immediately even between scheduled sync runs.

## Install

```bash
pi install git:github.com/fitchmultz/pi-pstack
```

The supported hosts are the latest official Pi release and the current `fitchmultz/pi` fork revision. Older Pi releases and other forks are not compatibility targets; the exact tested revisions are listed under [Maintenance](#exact-hosts-and-the-configured-provider).

## Standalone use and optional integrations

The package loads by itself on official Pi and the Pi fork. Inline skills such as `unslop`, `tdd`, the principles, and the style portion of `poteto-mode` need no other extension.

Independent/parallel workflows still need real delegation. Explicit bundled `architect`, `arena`, `how`, `interrogate`, `maintain-verification-skill`, `no-comments`, `reflect`, `show-me-your-work`, and `swarm` commands stop before model work when no supported delegation entry point is reachable. The adapter applies the same prerequisites to nested skill reads and other playbook phases. It never replaces an independent panel with serial self-review. The early check does not prove profiles, run controls, or model diversity; discover and validate those before launching.

With the profile-based `pi-subagents` npm package, an advertised `subagents_enable` loader is sufficient for initial admission even while `subagent` is inactive. Call the loader before delegating; admission does not launch it or any workers. With `@fitchmultz/pi-subagents`, its active `delegate` tool admits the workflow.

Optional providers include `pi-subagents` for delegation, `pi-ask-question` for dialogs, `pi-posthorse` for notes/history, `pi-agent-skills` for additional cleanup/browser guidance, `macuse` for native app driving, and the Pi fork's `background_command` for detached finite watchers. Use only available tools and their actual schemas. Ordinary questions, task-owned files, native shell commands, and repository-owned verification drivers cover their corresponding standalone cases. A missing required live driver, scheduler, or delegation capability blocks that phase with an explanation.

The bundled profiles inherit the session model instead of pinning a credentialed provider. Existing explicit choices in `~/.pi/agent/pstack-models.md` still take precedence. Diverse-model panels require actual available models; they do not invent routes or silently collapse to one family.

## GitHub CLI selection for watch-pr

The bundled `skills/poteto-mode/scripts/watch-pr/watch-pr` helper uses `gh` by default. On hosts with account-routing wrappers, explicitly select the appropriate executable for the repository:

```bash
WATCH_PR_GH=gh-personal /path/to/pi-pstack/skills/poteto-mode/scripts/watch-pr/watch-pr --owner OWNER --repo REPO --pr 123 --status-only
# Use WATCH_PR_GH=gh-work for a work-account repository.
```

`WATCH_PR_GH` is one executable name on `PATH` or an executable path (quote paths containing spaces), not a shell command or a place for extra arguments. Unset or empty means `gh`. The selection applies to every watcher GitHub read, including context/stack discovery, checks, GraphQL rollups, and paginated review threads; git commands are unchanged. Select the wrapper authorized for the repository rather than bypassing its router or changing credentials. Omit `--status-only` for normal polling; review/merge gates and retry behavior are unchanged.

## Synced workflow changes in 0.15.29

- `/skill:create-formal-verification-skill` creates a project-local verification skill; `/skill:maintain-formal-verification-skill` checks for drift after code changes. Both can run without delegation. Actual verifier tooling must be available separately; this package does not bundle a model checker or prover. Generated-input testing is not an exhaustive proof.
- `/skill:sharpen` now rewrites the prompt for a deeper task instead of executing the task. `/skill:ketchup` keeps every waiting item individually decidable.
- `/skill:setup-pstack` offers formal-verification setup only on acceptance. Pi's adapter and existing approval gates still apply.

## Maintenance

```bash
npm run sync          # Fetch latest cursor/plugins main and regenerate tree
npm run check:compat  # Validate sync invariants, skill/extension discovery, and pack
```

Set `PI_HOST_INDEX=/absolute/path/to/pi-coding-agent/dist/index.js` to qualify a particular host. Native tests use an isolated packed package, HOME, and agent directory, without external inference. Before writing any generated files or advancing provenance, the sync generator compares the checked-out skill inventory with the rendered upstream inventory and rejects removals or renames. Thus every automatic addition becomes protected on the next sync through the shipped skills tree itself, without a separate receipt or staging change. Removals or renames require an explicitly reviewed local change. The named test baseline also protects the initially reviewed commands; native discovery must expose every bundled skill. SDK queue checks exercise expansion of the synced formal-verification and sharpen commands without launching a model.

CI also qualifies the profile-based `pi-subagents` npm package's **0.84.0** loader on official Pi 1.4.0 in a separate install prefix. To include that regression locally, set `PI_SUBAGENTS_INDEX=/absolute/path/to/pi-subagents/bundle/index.js` when running `npm run smoke`, with `PI_HOST_INDEX` pointing to its host. Without that variable, that subtest is skipped; the standalone and loader-fixture checks still run. The integration checks packed-profile discovery through the provider's public `subagent` tool and dynamic/eager admission, including missing-tool rejection, without launching workers.

### Exact hosts and the configured provider

CI's `exact-hosts` job runs `node scripts/qualify-hosts.mjs`. The upstream sync runs the same script on generated output before committing, so a failure opens its sync-failure issue instead. The script pins these sources in one place:

- official Pi **1.4.0** from npm;
- `fitchmultz/pi` commit `9e0674e`, built and validated by that fork's documented staged release installer (`scripts/install-fork.mjs --stage`), which never selects the build;
- `@fitchmultz/pi-subagents` commit `3676214` (version 0.52.5), installed by Pi's own `pi install git:…`, which runs the provider's pinned `prepare` build;
- the profile-based `pi-subagents` npm package **0.84.0**, in a separate install prefix that contains no second Pi because its Pi peers are optional.

It then runs `npm run smoke` on each host with `PI_FITCH_SUBAGENTS_INDEX` and `PI_SUBAGENTS_INDEX` set, so both provider subtests run there. The `@fitchmultz/pi-subagents` subtest loads that package through Pi settings and checks that `delegate` and `agent_runs` are active and come from that package, that `/skill:how` reaches Pi's model check, and that excluding both tools produces pstack's handled diagnostic. Pi's built-in faux model then drives one offline delegation from the parent to a real child process and back. To run it locally, set `PI_FITCH_SUBAGENTS_INDEX=/absolute/path/to/pi-subagents/dist/index.js` along with `PI_HOST_INDEX`; without that variable, this subtest is also skipped.

Limits: the faux model proves delegation wiring, not live-model behavior, and no model credentials or paid inference calls are used. The script needs network access, Node 24.21.0 or later with npm (the provider's engine requirement; pi-pstack itself still supports Node 24.15.0 and later), and the fork installer's prerequisites, including tmux and Git 2.40 or later (the fork's source archive uses `git archive --mtime`). The fork build fetches its model catalog when it runs, so that catalog can differ from an installed release of the same commit; the offline smoke does not exercise live-model or catalog behavior. Change the pins only in `scripts/qualify-hosts.mjs`.

## License

MIT. Upstream `pstack` is Copyright (c) 2026 Lauren Tan (see [`LICENSE`](./LICENSE)).
