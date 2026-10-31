import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

const checker = join(import.meta.dirname, "check-plan.mjs");
const rule =
	"Verification must match the change and its user-facing consequences.";

const validPlan = `# Demo

## How to read this
One box is one unit of work and names the evidence. Check a box only when its evidence exists. See playbooks/.
${rule}

## Program checklist
### Arm the program
- [ ] Record the authority and holds.
### Assign work
- [ ] Assign the work.
### PR mechanics
- [ ] Start checks and review.
### Verdict and merge
- [ ] Honor required gates.
### Boot recipe
- [ ] Start the real runtime.

## PR 1
**Depends on.** None.
**Files.**
- [ ] Do the thing.
**Build.**
- [ ] Do the thing.
**You see.**
- [ ] Do the thing.
**Verify, unit.** ${rule}
- [ ] Check the thing.
**Verify, live.** ${rule}
- [ ] Run the user's real flow. Pass when the result appears.
**Verify, perf.** ${rule} Not applicable. No performance requirement.
**Review gate.** None. No additional approval was requested.
**Merge.**
- [ ] Merge when approved.

## Close the program
Close.

## Appendix Prototype evidence
Recorded.
`;

const runPlan = (example: string, expectedExit: number, plan = validPlan) => {
	const directory = mkdtempSync(join(tmpdir(), "check-plan-test-"));
	const file = join(directory, "plan.md");
	writeFileSync(file, plan + example);
	try {
		const result = spawnSync(process.execPath, [checker, file], { encoding: "utf8" });
		assert.equal(result.status, expectedExit, result.stderr);
		return result;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
};

test("accepts proportional live verification and requires a real pass predicate", () => {
	runPlan("", 0);
	const missingPredicate = validPlan.replace(" Pass when the result appears.", "");
	const result = runPlan("", 1, missingPredicate);
	assert.match(result.stderr, /live check has no pass predicate/);
});

test("requires a reason for omitted performance and real review gates", () => {
	const missingReason = validPlan.replace("Not applicable. No performance requirement.", "Not applicable.");
	assert.match(runPlan("", 1, missingReason).stderr, /perf omission needs a reason/);
	const perf = validPlan.replace("Not applicable. No performance requirement.", "")
		.replace("**Review gate.**", "- [ ] Metric. Latency.\n- [ ] Probe. Measure both heads.\n- [ ] Baseline. Record trunk.\n- [ ] Rule. Compare to target.\n**Review gate.**");
	runPlan("", 0, perf);
	const unplannedGate = perf.replace("**Review gate.** None. No additional approval was requested.", "**Review gate.** Required.");
	assert.match(runPlan("", 1, unplannedGate).stderr, /Review gate has no box/);
});

test("accepts ordinary, indented, and longer closing fences", () => {
	for (const indent of ["", " ", "  ", "   "])
		runPlan(`${indent}\`\`\`markdown\n## Example only\n${indent}\`\`\`\n`, 0);
	runPlan("```markdown\n## Example only\n````\n", 0);
});

test("accepts nested backticks and tilde info strings", () => {
	runPlan("````markdown\n```markdown\n## Example only\n```\n````\n", 0);
	runPlan("~~~markdown `info`\n## Example only\n ~~~\n", 0);
});

test("keeps mismatched, shorter, and suffixed closers inside the fence", () => {
	runPlan("````markdown\n~~~\n## Example only\n````\n", 0);
	runPlan("````markdown\n```\n## Example only\n````\n", 0);
	runPlan("````markdown\n``` info\n## Example only\n````\n", 0);
});

test("rejects headings and prose outside a proper close", () => {
	for (const suffix of ["  ", "\t"]) {
		const heading = runPlan(`\`\`\`markdown\n## Example only\n\`\`\`${suffix}\n## Example only\n`, 1);
		assert.match(heading.stderr, /"## Example only" after Close the program is not an appendix/);
	}

	const prose = runPlan("```markdown\nThis prose has a mid-sentence colon: inside code\n```\nThis prose has a mid-sentence colon: bad.\n", 1);
	assert.match(prose.stderr, /mid-sentence colon/);
});

test("rejects backtick info strings containing a backtick", () => {
	const result = runPlan("```markdown `invalid`\n## Example only\n```\n", 1);
	assert.match(result.stderr, /"## Example only" after Close the program is not an appendix/);
});

test("ignores prose punctuation inside matching multi-backtick code spans", () => {
	for (const count of [2, 3, 4]) {
		const delimiter = "`".repeat(count);
		runPlan(`Use ${delimiter}echo \`x\`: “quoted” — example${delimiter}.\n`, 0);
	}
});

test("checks prose following a multi-backtick span and unmatched delimiters", () => {
	const outside = runPlan("Use ``echo `x`: y``. Bad: prose.\n", 1);
	assert.match(outside.stderr, /mid-sentence colon/);
	const unmatched = runPlan("Use ``unclosed: bad` here.\n", 1);
	assert.match(unmatched.stderr, /mid-sentence colon/);
});
