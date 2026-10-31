### Eval

Follow [the Pi execution contract](../../../docs/harness/pi.md) for delegated or inline work, real prerequisites, and existing user gates.

**You own the experiment design. Plan, blind, run, synthesize.**

**Non-negotiables for blinding:**

- No `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate`, or `arena` in any directory, file, or prompt the candidate sees.
- The candidate prompt looks like an organic user request. State the goal, not the meta.
- No chain-eliciting cues. Don't ask the candidate to list which skills, principles, or files they applied. Ask for design notes generally and grade chain-following from code shape, not self-report.
- Sanitize directory and slug names. Use project-shaped names a user might pick.
- Don't tell the candidate other candidates exist.
- The judge can know it's judging but sees outputs by sanitized label only, never by model name.
- Comparing two variants: one judge scores both sets in a single pass on one scale, blind to which set each came from.

**Steps:**

1. **Frame.** State what variant is under test and what behavior counts as success. Write the rubric (3-6 concrete criteria) for the judge only. Hold it back from candidates.
2. **Set up sanitized environments.** Per-candidate working dir with the variant in place. Plant any context an organic task would have: a project skeleton, the skills the candidate would naturally read.
3. **Author one organic prompt.** What a user would type. No leakage of what's being measured.
4. **Run candidates** per the **arena** skill. Give authorized workers the same prompt in separate sanitized dirs and use real available model IDs. Without a provider, produce the same candidates serially yourself and state that the experiment is not self-blind or independent.
5. **Judge the outputs.** An authorized independent judge sees sanitized labels and the rubric, not model names. Otherwise apply the same rubric yourself and label the judgment self-performed. A text-only opinion on supplied output is not a tool-using judge.
6. **Verify the chain from transcripts, not self-report.** Read each available candidate transcript through its actual provider or session history. Do not search unrelated workspaces or private chats. Grade chain-following from the files actually read and the code shape. Report a missing transcript as a gap.
7. **Read every candidate output yourself** end to end. Compare to the judge's verdict. Disagreement means a model is biased or the rubric is ambiguous. Synthesize.

**Reply:** variant under test, rubric, per-candidate notes, judge's verdict, your synthesis, and a recommendation for whether to promote the variant.
