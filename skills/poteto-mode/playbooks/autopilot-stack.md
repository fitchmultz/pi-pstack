### Autopilot-stack

Follow [the Pi execution contract](../../../docs/harness/pi.md) and the Autopilot-full playbook, but do not merge.

1. **Stop at verified.** Each PR must be verified and green at its current head. Hand the PRs to the operator for merge, and continue addressing authorized review or check failures.
2. **Stack only dependent PRs.** Base each on the parent it actually builds on. Reconcile the root against trunk and each later PR against its parent. A changed head needs current checks; reuse a verdict only when its evidence still covers the patch and integration.
3. **Keep verification honest.** Use an independent reviewer when available. Otherwise run the same real checks and user flows yourself and record `PASS (self-verified)`. Preserve real protections, approvals, and holds.

**Reply:** list each PR with its live state and verdict, and state that the operator will merge.
