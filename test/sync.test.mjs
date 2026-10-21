import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// These are exactly the paths the existing automation stages after validation.
const shippedPaths = ["skills", "agents", "LICENSE", "plugin.json", "upstream.json", "package.json"];

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Sync regression", "-c", "user.email=sync-test@example.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(cwd, paths, message) {
  git(cwd, "add", "--", ...paths);
  git(cwd, "commit", "-m", message);
}

function sync(target, source, check = false) {
  return spawnSync(process.execPath, [join(target, "scripts/sync-pstack.mjs"), ...(check ? ["--check"] : []), source],
    { cwd: target, encoding: "utf8" });
}

function assertSuccess(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function generatedSnapshot(target) {
  function entries(path) {
    const full = join(target, path);
    const stat = statSync(full);
    return stat.isDirectory()
      ? readdirSync(full).sort().flatMap((name) => entries(join(path, name)))
      : [[path, stat.mode & 0o777, readFileSync(full).toString("base64")]];
  }
  return shippedPaths.flatMap(entries);
}

function skill(name, body) {
  return `---\nname: ${name}\ndescription: Sync regression fixture\n---\n\n# ${name}\n\n${body}\n`;
}

// Issue #7 / PR #9: test the canonical CLI across real upstream and shipping Git
// commits. No hand-maintained receipt or test baseline admits the later skill.
test("sync remembers later-shipped skills and rejects removals before any generated write", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "pi-pstack-sync-"));
  const source = join(temp, "upstream");
  const target = join(temp, "adapter");
  const shipped = join(temp, "fresh-checkout");
  const pstack = join(source, "pstack");
  try {
    mkdirSync(source);
    mkdirSync(target);
    git(source, "init");
    git(target, "init");
    for (const path of ["scripts/sync-pstack.mjs", "docs/harness/pi.md", "package.json"]) {
      mkdirSync(dirname(join(target, path)), { recursive: true });
      cpSync(join(root, path), join(target, path));
    }
    commit(target, ["scripts", "docs", "package.json"], "Initialize isolated adapter");

    const original = join(pstack, "skills", "fixture-existing", "SKILL.md");
    const added = join(pstack, "skills", "fixture-added", "SKILL.md");
    const manifest = join(pstack, "plugin.json");
    put(original, skill("fixture-existing", "Original shipped instructions."));
    put(join(pstack, "skills", "fixture-existing", "scripts", "probe.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(pstack, "skills", "fixture-existing", "scripts", "probe.sh"), 0o755);
    put(join(pstack, "agents", "comment-sicko.md"), "---\nname: comment-sicko\ndescription: Fixture\n---\n# Comment Sicko\n\nOriginal agent instructions.\n");
    put(join(pstack, "LICENSE"), "MIT fixture license, original attribution\n");
    put(manifest, JSON.stringify({ name: "pstack", version: "1.0.0" }));
    commit(source, ["pstack"], "Initial upstream");
    assertSuccess(sync(target, source));
    assertSuccess(sync(target, source, true));
    commit(target, shippedPaths, "Ship initial upstream");

    // A future automatic addition must be accepted and persisted by the ordinary
    // staging set, without changing test/required-skills.mjs or any other receipt.
    put(added, skill("fixture-added", "New independently shipped instructions."));
    put(manifest, JSON.stringify({ name: "pstack", version: "1.0.1" }));
    commit(source, ["pstack"], "Add a new upstream skill");
    assertSuccess(sync(target, source));
    assertSuccess(sync(target, source, true));
    assert.match(readFileSync(join(target, "skills/fixture-added/SKILL.md"), "utf8"), /^name: fixture-added$/m);
    assert.equal(JSON.parse(readFileSync(join(target, "package.json"))).version, "1.0.1");
    const afterAddition = generatedSnapshot(target);
    assertSuccess(sync(target, source));
    assert.deepEqual(generatedSnapshot(target), afterAddition, "Unchanged sync must be idempotent");
    commit(target, shippedPaths, "Automatically ship added skill");
    git(temp, "clone", target, shipped);
    assert.equal(git(shipped, "status", "--porcelain"), "");
    const shippingCommit = git(shipped, "rev-parse", "HEAD");
    const beforeRemoval = generatedSnapshot(shipped);
    t.diagnostic("Addition, unchanged resync, shipping commit and fresh checkout passed");

    // Remove only the later addition, while changing other generated resources
    // and provenance. Rejection must happen before deleting/replacing anything.
    rmSync(dirname(added), { recursive: true });
    put(original, skill("fixture-existing", "Changed instructions must not leak through rejection."));
    put(join(pstack, "agents/comment-sicko.md"), "# Comment Sicko\n\nChanged agent must not leak.\n");
    put(join(pstack, "LICENSE"), "Changed attribution must not leak\n");
    put(manifest, JSON.stringify({ name: "pstack", version: "1.0.2" }));
    commit(source, ["pstack"], "Remove the previously auto-shipped addition");
    const rejected = sync(shipped, source);
    t.diagnostic(`Removal exit=${rejected.status}; generated snapshot changed=${JSON.stringify(generatedSnapshot(shipped)) !== JSON.stringify(beforeRemoval)}`);
    assert.equal(rejected.error, undefined);
    assert.equal(rejected.status, 1, "A previously auto-shipped skill must not disappear silently");
    assert.match(rejected.stderr, /Refusing upstream sync.*fixture-added/);
    assert.deepEqual(generatedSnapshot(shipped), beforeRemoval,
      "Rejected sync must preserve all generated bytes, executable modes, licensing and provenance");
    assert.equal(git(shipped, "status", "--porcelain"), "", "Rejected sync must leave the shipped checkout clean");
    assert.equal(git(shipped, "rev-parse", "HEAD"), shippingCommit);

    // Recovery does not need an override or an old-host fallback: restore the
    // missing skill upstream, then ordinary validation can advance provenance.
    put(added, skill("fixture-added", "Restored upstream instructions."));
    put(manifest, JSON.stringify({ name: "pstack", version: "1.0.3" }));
    commit(source, ["pstack"], "Restore the shipped skill");
    assertSuccess(sync(shipped, source));
    assertSuccess(sync(shipped, source, true));
    const provenance = JSON.parse(readFileSync(join(shipped, "upstream.json")));
    assert.equal(provenance.repoCommitSha, git(source, "rev-parse", "HEAD"));
    assert.equal(provenance.pstackCommitSha, git(source, "log", "-1", "--format=%H", "--", "pstack"));
    assert.equal(provenance.pstackTreeSha, git(source, "rev-parse", "HEAD:pstack"));
    assert.equal(provenance.version, "1.0.3");
    assert.match(readFileSync(join(shipped, "skills/fixture-added/SKILL.md"), "utf8"), /Restored upstream instructions/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
