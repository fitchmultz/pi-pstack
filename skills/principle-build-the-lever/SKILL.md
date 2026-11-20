---
name: principle-build-the-lever
description: "Use a rerunnable tool when it makes real work or verification safer, more consistent, or easier to review."
disable-model-invocation: true
---

# Build the Lever

Read [the Pi execution contract](../../docs/harness/pi.md).

Use an existing tool, or build a small one (a codemod, script, generator, or rerunnable check), when it resolves a concrete uncertainty or makes repeated work safer. Do not add a tool solely because work is nontrivial; a direct check can be the clearest proof.

- Do the first unit by hand, then build the tool and prove it by rerunning it on that unit. Make it safe to rerun.
- A deterministic tool beats fan-out. When you do fan out, write the recipe, the verification contract, and the fences as one skill the delegates read and cannot edit.
- Reuse a maintained tool when it already supplies the lever. Commit a new script when the work outlives the session.
- Build the smallest script that does or proves the job, never a framework.
