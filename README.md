# pi-pstack

Pi package adapter for [Cursor's `pstack`](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (`poteto`).

## What this package provides

- **All 54 core `pstack` skills** (`./skills`), including `/skill:poteto-mode` (23 playbooks), all 24 `principle-*` skills, `/skill:how`, `/skill:why`, `/skill:architect`, `/skill:arena`, `/skill:swarm`, `/skill:interrogate`, `/skill:tdd`, `/skill:bro`, `/skill:unslop`, `/skill:no-comments`, `/skill:ketchup`, `/skill:recall`, `/skill:reflect`, `/skill:correct`, `/skill:teach`, `/skill:sharpen`, `/skill:in-your-own-words`, `/skill:figure-it-out`, `/skill:show-me-your-work`, `/skill:technical-writing`, `/skill:typescript-best-practices`, `/skill:benchmark-checklist`, `/skill:blast-radius`, `/skill:create-verification-skill`, `/skill:maintain-verification-skill`, `/skill:automate-me`, and `/skill:setup-pstack`.
- **Pi subagent profiles** (`./agents`): `poteto-agent` and `comment-sicko`, automatically discovered by `pi-subagents` via the `"subagents": { "agents": ["./agents"] }` manifest.
- **Pi harness adapter** ([`docs/harness/pi.md`](./docs/harness/pi.md)): maps Cursor tools (`Task`, `AskQuestion`), subagent parameters (`environment: "cloud"` -> `worktree: true`), skills (`/deslop` -> `deslop`, `control-cli` -> `interactive-testing`, `control-ui` -> `dogfood`/`macuse`), session history (`history` tool and `~/.pi/agent/sessions/`), model routes, and `ponytail:` / `AGENTS.md` protections.
- **Automated upstream sync & notifications**:
  - `.github/workflows/sync-upstream.yml` polls `cursor/plugins` (`pstack/`) every 6 hours, runs `scripts/sync-pstack.mjs` + `npm run check:compat`, and commits updates to `main`.
  - Pi's built-in interactive startup package checker detects new commits on `fitchmultz/pi-pstack` and displays the native `Package Updates Available` banner (`pi update --extensions`).
  - `extensions/index.js` also performs a non-blocking, cached (6h TTL) check against `cursor/plugins/pstack` on interactive startup and provides `/pstack-status` so upstream commits are surfaced immediately even between scheduled sync runs.

## Install

```bash
pi install git:github.com/fitchmultz/pi-pstack
```

## Maintenance

```bash
npm run sync          # Fetch latest cursor/plugins main and regenerate tree
npm run check:compat  # Validate sync invariants, skill/extension discovery, and pack
```

## License

MIT. Upstream `pstack` is Copyright (c) 2026 Lauren Tan (see [`LICENSE`](./LICENSE)).
