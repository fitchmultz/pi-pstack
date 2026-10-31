---
name: no-comments
description: "Review comments with the Comment Sicko criteria, fix accepted findings, and offer encodings for claimed constraints."
---

# No comments

Read [the Pi execution contract](../../docs/harness/pi.md) and select the authorized delegated or inline route. Recheck before delegation. Report self-performed work and any loss of independence, isolation, model diversity, or parallelism.

Review the scoped comments using the package's `comment-sicko` role and act on accepted findings. An authorized independent reviewer can provide a fresh perspective; otherwise follow the same report-only role yourself and label the review self-performed.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Read `<pstack>/agents/comment-sicko.md`. Give the scope and role instructions to an authorized provider, or apply the report-only role yourself. The reviewer identifies candidates without editing files.
2. Inspect the report against the scoped code. Reject scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Preserve exact exceptions (including `ponytail:` ceiling comments and required project policy comments) with scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, run `how` or `why` on their symbol. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. Recheck a rejected report with the failure named. If it remains invalid, report it open and fail `/skill:no-comments`.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, run `/skill:architect` once for the accepted set and surrounding code. Stop at the sketch. Architect shapes. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The **principle-fix-root-causes** and **principle-redesign-from-first-principles** skills guide intent only. Neither authorizes widening the fence nor fixing instances outside it. Never bolt on symptom guards.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. Offer the cheapest in-scope type, runtime, test, or CI lint. Wait for interactive approval. Unattended and eval require caller pre-approval. If approved, encode then delete. Otherwise delete, report the constraint open, and sketch out-of-scope work.
6. Report the deletion count, restored comments, reruns, architect sketch, fixes, encoding offers, encodings, unenforced constraints, and other open work.
