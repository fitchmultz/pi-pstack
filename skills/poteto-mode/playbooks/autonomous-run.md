### Autonomous run

**Own the exit condition. Define done, then drive to it without stopping.** Follow the [Pi execution contract](../../../docs/harness/pi.md) for delegated and inline work.

1. State the exit condition as a checkable predicate before the first iteration.
2. Use a real event watcher for finite waits, such as an available `background_command` or a bounded forge watch. An authorized provider may watch when its lifecycle supports it. A recurring unattended wake needs a real scheduler or long-lived host; report its absence. A stopped Pi parent does not keep reasoning.
3. Each iteration makes the smallest evidence-supported change, verifies it against the predicate, and keeps only advances. Sequence work with the **sequence-verifiable-units** principle.
4. Address in-scope discoveries and return to the predicate. Preserve explicit approvals and holds. Ask only for information or decisions the user must supply; do not park ordinary authorized work.
5. Checkpoint meaningful iterations through **show-me-your-work**.
6. Stop when the predicate is met or a genuine blocker remains. Do not relax the predicate to declare victory.

**Reply:** the exit condition, iterations run, what landed, what was discarded, and the final predicate state.
