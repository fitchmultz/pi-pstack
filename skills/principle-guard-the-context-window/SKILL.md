---
name: principle-guard-the-context-window
description: "Manage large outputs, long files, and repeated reads without losing relevant evidence."
disable-model-invocation: true
---

# Guard the Context Window

Read [the Pi execution contract](../../docs/harness/pi.md).

Manage large outputs, long files, and repeated reads without losing relevant evidence.

Use authorized subagents for bounded bulk work when available. Otherwise page and filter reads, retain the evidence needed for decisions, and use Pi's native session and compaction behavior. A summary made by the parent is not an independent context or review.

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**
- **Size phases to the task.** Keep durable evidence and continuation state where needed without imposing arbitrary limits on the work.
