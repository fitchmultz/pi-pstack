### Bug fix

Follow [the Pi execution contract](../../../docs/harness/pi.md) for delegated or inline work, real prerequisites, and existing user gates.

**You own this task. Plan, review, verify.** Use authorized delegates when available or investigate and fix it inline. Label self-verification.

Be scientific. Every shipped line traces to runtime evidence. Belt-and-suspenders that "might help" is a hypothesis, not a fix. It does not ship. When evidence refutes a hypothesis, revert what it motivated. The smallest change the evidence justifies ships, nothing more.

1. Reproduce it on the matching real surface with an available driver. Ask the user only when a concrete prerequisite is inaccessible. If it won't reproduce, inspect the observed trigger and instrument as needed; report an unproven mechanism.
2. Form and eliminate candidate causes with source and runtime evidence. Use `how` or `why` when the task warrants them. Use available finite watchers for long waits. Confirm the surviving mechanism before fixing it.
3. Plan the smallest supported fix. Use `architect` when an unresolved design tradeoff warrants it. Give an authorized delegate a specific scope, or implement it yourself.
4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
5. Stage the commits so the failing repro lands before the fix in git history. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
   This is the canonical **sequence-verifiable-units** principle skill, the failing test first and the fix on top.
6. Run **Opening a PR**.

**Reply:** what was broken, root cause, fix, how you verified. Paste failing-then-passing repro output verbatim.
