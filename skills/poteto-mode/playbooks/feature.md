### Feature

Follow [the Pi execution contract](../../../docs/harness/pi.md) for delegated or inline work, real prerequisites, and existing user gates.

**You own the design. Plan, review, verify.** Use an authorized delegate or implement inline.

1. Ground the affected subsystem. Use `how` when its architectural explanation is needed.
2. Use `architect` to compare distinct designs when an unresolved tradeoff warrants it.
3. Identify dependencies, independent work, and shared mutable state. Use separate worktrees for concurrent writers. Keep tightly coupled changes with one owner; parallelize only when it helps.
4. Implement with an authorized delegate or inline. Name the scope, data shape, organizing structure, and success criteria first. Use **arena** when comparing real alternatives helps the task. Review delegated results; label serial self-review. Re-ground upstream-derived files, fix shared causes across affected consumers, and verify each.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
6. Rebase into small, ordered commits. Stack only dependent follow-ups.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.
7. If the design is contested, `interrogate` before shipping.
8. Run **Opening a PR**.

Adjust the plan when evidence changes the dependencies or scope.

**Reply:** what changed, material design choices, verification, and any open decision.
