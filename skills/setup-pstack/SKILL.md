---
name: setup-pstack
description: Configure pstack's optional per-role model choices and reasoning budget for Pi. Use for /skill:setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Read [the Pi execution contract](../../docs/harness/pi.md). This skill configures pstack's optional instructions, not Pi's global model or authentication settings. Without a configuration, jobs inherit the current session model.

## Steps

1. Inspect the selected host's available model catalog, for example with `pi --list-models`, and the selected delegation provider's actual model and reasoning options. A listed model is not proof that credentials or entitlement work. If discovery is unavailable, ask for the missing information rather than inventing model IDs.
2. Read `~/.pi/agent/pstack-models.md` if it exists and preserve its choices as the starting point. Do not change the user's model or authentication settings.
3. Ask the user for their intended budget and role choices. Explain the actual provider's available reasoning levels rather than deriving them from model-name spelling. Offer the current session model as `inherit-parent`; omit an override where the provider really inherits the parent. Choose actual available `provider/model` IDs only, and do not substitute a different model without agreement.
4. Show the proposed table and get confirmation before writing. Relevant roles include feature, refactoring, bug-fix, perf-issue, hillclimb, judgment and prose, hardest tasks, how explorer and explainer, why investigators and synthesizer, reflect tooling and judgment, arena runners and cross-judge, swarm workers, architect runners, and interrogate reviewers. A panel can have several configured models, but its actual size is limited by the available authorized route; repeated parent-model work is not model diversity.
5. Write `~/.pi/agent/pstack-models.md` as a plain Markdown record of the agreed budget and `role: choice` lines. Use `inherit-parent` for roles without an explicit override; list multiple IDs for a panel. This is an instruction file that pstack workflows read, not an automatically enforced Pi model registry. Preserve any unrelated content the user wants to keep. Reload or start a new session if required for changed resources.
6. Verify the file and report its path, chosen roles, and any unverified model access. If a choice fails when used, report the error and use an agreed alternative.

A project can also use `/skill:create-verification-skill` or `/skill:create-formal-verification-skill` for real-app and formal proof when those are relevant to the user's goal. Neither is required to configure models.
