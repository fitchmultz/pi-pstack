### Shipping

**Own what lands. Verify each PR, land only the permitted verified run from the root, and monitor the actual result.** Follow the [Pi execution contract](../../../docs/harness/pi.md).

1. **Verify each PR.** Use an authorized independent tool-using reviewer when available. Otherwise run the same checks, inspect the diff, and exercise the real user flow yourself. Record `PASS (self-verified)`, `PASS+NOTES (self-verified)`, or the actual failure. A text-only opinion or green CI is not an independent user-flow verdict. A failing review is not reviewer unavailability.
2. **Find the contiguous verified run.** Walk upward from the lowest unmerged PR and stop at the first missing or failing verdict. A PR that neither needs nor includes the lower work may be retargeted and reverified on the correct base.
3. **Check that evidence still applies.** Compare the reviewed patch and the current head, including base integration. Re-run affected checks and user flows when code, dependencies, build inputs, or the behavior under test changed. A changed head still needs its actual required CI and reviews. Do not carry a verdict across an untested change.
4. **Land bottom-up only when authorized.** Honor the user's holds, branch protections, required reviews, and approvals. Use the project's forge and credential conventions. Read the PR back to distinguish a merge from a queued or auto-merge request. Retarget the next PR to the actual merge result and verify it before landing.
5. **Monitor delivery.** Use the available finite CI and merge watchers, inspect stalls, and continue through required post-merge checks or deployment. Recurring unattended wakes require a real scheduler or long-lived host; do not assume a stopped Pi parent continues watching.
6. **Stop at the verified ceiling.** Extending the run requires verification of the next PR. Never merge an `autopilot-stack` hold.

**Reply:** the verified run and ceiling, each verdict and who produced it, what landed and how it was confirmed, and the next gap.
