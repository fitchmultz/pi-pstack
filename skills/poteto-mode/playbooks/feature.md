### Feature

Follow [the Pi execution contract](../../../docs/harness/pi.md) for delegated or inline work, real prerequisites, and existing user gates.

**You own the design. Plan, review, verify.** Use an authorized delegate or implement inline.

1. Ground the affected subsystem. Use `how` when its architectural explanation is needed.
2. Use `architect` to compare distinct designs when an unresolved tradeoff warrants it.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Implement with an authorized delegate or inline. Name the scope, data shape, organizing structure, and success criteria first. Use **arena** when comparing real alternatives helps the task. Review delegated results; label serial self-review. Re-ground upstream-derived files, fix shared causes across affected consumers, and verify each.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
6. Rebase into small, ordered commits. Stack only dependent follow-ups.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.
7. If the design is contested, `interrogate` before shipping.
8. Run **Opening a PR**.

Keep code-coupled work with one owner. Parallelize independent artifacts only when authorized providers are available; otherwise execute the same units serially. Rewrite the checkpoint at phase boundaries.

**Reply:** what you built, what you chose and why, the throughput checkpoint, open decisions. Tables for design alternatives.
