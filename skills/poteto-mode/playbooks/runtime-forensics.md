### Runtime forensics

Follow [the Pi execution contract](../../../docs/harness/pi.md) for delegated or inline work, real prerequisites, and existing user gates.

**You own the diagnosis. Instrument the live process, don't theorize from source.** The deliverable is a cited diagnosis, not a fix.

1. Capture the live signal on the matching surface via the control skill: a CPU profile for a spinning process, a heap snapshot for a leak, a CDP trace for a visual glitch. A real artifact, not a guess.
2. Reduce the artifact to the smoking gun: the function on the hot path, the retainer chain from the leaked object to a GC root, or the loop firing without input. Use an authorized delegate or page and filter the artifact yourself.
3. Prove the mechanism before believing it. Use authorized instrumentation on the real target or an isolated reproduction. Do not mutate a production process without the required authority.
4. Map the finding back to source: file, symbol, the line that allocates or schedules.
5. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only forensics`.

**Reply:** the signal captured, the reduced finding, how you proved the mechanism, the source location, artifact paths. No fix unless asked. Hand back to Bug fix or Perf once the cause is known.
