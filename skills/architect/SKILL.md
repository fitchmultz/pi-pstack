---
name: architect
description: "Sketch types, signatures, and modules before coding non-trivial work, then steer the implementation. Use for 'design this'."
---

# Architect

Read [the Pi execution contract](../../docs/harness/pi.md) once when needed for this session.

Before writing code, trace every system the change touches, then sketch two different shapes for it (types, signatures, module boundaries) and pick the one where each piece of state has one owner, each task has one way to do it, and callers need to know least. Redesign instead of patching if workarounds repeat.

For a large or contested design, run the **arena** skill instead of sketching alone.
