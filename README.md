# pi-pstack

Pi package adapter for [Cursor's `pstack`](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (`poteto`).

## What this package provides

- **All 54 core `pstack` skills** (`./skills`), including `/skill:poteto-mode` (23 playbooks), all 24 `principle-*` skills, `/skill:how`, `/skill:why`, `/skill:architect`, `/skill:arena`, `/skill:swarm`, `/skill:interrogate`, `/skill:tdd`, `/skill:bro`, `/skill:unslop`, `/skill:no-comments`, `/skill:ketchup`, `/skill:recall`, `/skill:reflect`, `/skill:correct`, `/skill:teach`, `/skill:sharpen`, `/skill:in-your-own-words`, `/skill:figure-it-out`, `/skill:show-me-your-work`, `/skill:technical-writing`, `/skill:typescript-best-practices`, `/skill:benchmark-checklist`, `/skill:blast-radius`, `/skill:create-verification-skill`, `/skill:maintain-verification-skill`, `/skill:automate-me`, and `/skill:setup-pstack`.
- **Optional delegation profiles** (`./agents`): `poteto-agent` and `comment-sicko`. `pi-subagents` discovers them through `pi.subagents.agents` in the manifest. The top-level `subagents.agents` alias is retained for older adapters; native Pi does not consume either profile-metadata key. No sibling's generic profiles are assumed or copied.
- **Pi harness adapter** ([`docs/harness/pi.md`](./docs/harness/pi.md)): defines task scope, workflow selection, native tool/path mappings, capability checks, standalone code cleanup, model inheritance, and `ponytail:` / `AGENTS.md` protections. Ordinary changes do not require architecture competitions or new tools. Explicitly selected workflows retain their required panels and checks. Its Pi rules override broader workflow triggers and Cursor assumptions in the bundled upstream skills and playbooks.
- **Automated upstream sync & notifications**:
  - `.github/workflows/sync-upstream.yml` polls `cursor/plugins` (`pstack/`) every 6 hours, runs `scripts/sync-pstack.mjs` + `npm run check:compat`, and commits updates to `main`.
  - Pi's built-in interactive startup package checker detects new commits on `fitchmultz/pi-pstack` and displays the native `Package Updates Available` banner (`pi update --extensions`).
  - `extensions/index.js` also performs a non-blocking, cached (6h TTL) check against `cursor/plugins/pstack` on interactive startup and provides `/pstack-status` so upstream commits are surfaced immediately even between scheduled sync runs.

## Install

```bash
pi install git:github.com/fitchmultz/pi-pstack
```

## Standalone use and optional integrations

The package loads by itself on official Pi and the Pi fork. Inline skills such as `unslop`, `tdd`, the principles, and the style portion of `poteto-mode` need no other extension.

Independent/parallel workflows still need real delegation. Explicit bundled `architect`, `arena`, `how`, `interrogate`, `maintain-verification-skill`, `no-comments`, `reflect`, `show-me-your-work`, and `swarm` commands stop before model work when no supported delegation entry point is reachable. The adapter applies the same prerequisites to nested skill reads and other playbook phases. It never replaces an independent panel with serial self-review. The early check does not prove profiles, run controls, or model diversity; discover and validate those before launching.

With pi-subagents, an advertised `subagents_enable` loader is sufficient for initial admission even while `subagent` is inactive. Call the loader before delegating; admission does not launch it or any workers.

Optional providers include `pi-subagents` for delegation, `pi-ask-question` for dialogs, `pi-posthorse` for notes/history, `pi-agent-skills` for additional cleanup/browser guidance, `macuse` for native app driving, and the Pi fork's `background_command` for detached finite watchers. Use only available tools and their actual schemas. Ordinary questions, task-owned files, native shell commands, and repository-owned verification drivers cover their corresponding standalone cases. A missing required live driver, scheduler, or delegation capability blocks that phase with an explanation.

The bundled profiles inherit the session model instead of pinning a credentialed provider. Existing explicit choices in `~/.pi/agent/pstack-models.md` still take precedence. Diverse-model panels require actual available models; they do not invent routes or silently collapse to one family.

## Maintenance

```bash
npm run sync          # Fetch latest cursor/plugins main and regenerate tree
npm run check:compat  # Validate sync invariants, skill/extension discovery, and pack
```

Set `PI_HOST_INDEX=/absolute/path/to/pi-coding-agent/dist/index.js` to qualify a particular host. Native tests use an isolated packed package, HOME, and agent directory, without external inference.

CI also qualifies the real optional pi-subagents **0.79.1** loader in a separate install prefix. To include that regression locally, set `PI_SUBAGENTS_INDEX=/absolute/path/to/pi-subagents/index.js` when running `npm run smoke`, with `PI_HOST_INDEX` pointing to its host. Without that variable, only the real-provider subtest is skipped; the standalone and loader-fixture checks still run. The integration checks packed-profile discovery and dynamic/eager admission, including missing-tool rejection, without launching workers. Profile discovery uses that pinned provider's internal scanner because its public API does not expose package discovery.

## License

MIT. Upstream `pstack` is Copyright (c) 2026 Lauren Tan (see [`LICENSE`](./LICENSE)).
