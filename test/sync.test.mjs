import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// These are exactly the paths the existing automation stages after validation.
const shippedPaths = ["skills", "agents", "LICENSE", "plugin.json", "upstream.json", "package.json", "vendor", "pi"];

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

function sync(target, ...args) {
  return spawnSync(process.execPath, [join(target, "scripts/sync-pstack.mjs"), ...args],
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

test("the packed package can verify its pinned source and generated output offline", () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-pstack-packed-check-"));
  try {
    assert.equal(readFileSync(join(root, ".npmignore"), "utf8"),
      `${readFileSync(join(root, ".gitignore"), "utf8")}!/.gitignore\n!/.npmignore\n`);
    const packed = Object.values(JSON.parse(execFileSync(
      "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
      { cwd: root, encoding: "utf8" },
    )))[0];
    execFileSync("tar", ["-xzf", join(temp, packed.filename), "-C", temp]);
    const packageRoot = join(temp, "package");
    const gitConfig = join(temp, "gitconfig");
    put(gitConfig, "");
    const packageSync = (...args) => spawnSync(process.execPath, [join(packageRoot, "scripts/sync-pstack.mjs"), ...args], {
      cwd: packageRoot, encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" },
    });
    assertSuccess(packageSync("--check"));
    put(join(packageRoot, "skills/poteto-mode/scripts/node_modules/commander/package.json"), "{}\n");
    assertSuccess(packageSync("--check"));
    assertSuccess(packageSync("--record"));
    assert.doesNotMatch(readFileSync(join(packageRoot, "pi/overlays/pstack.patch"), "utf8"), /node_modules\/commander/);
    assertSuccess(packageSync("--check"));
    const extra = join(packageRoot, "skills/tdd/debug.log");
    put(extra, "unexpected\n");
    const unexpected = packageSync("--check");
    assert.notEqual(unexpected.status, 0);
    assert.match(unexpected.stderr, /Unexpected generated path: skills\/tdd\/debug\.log/);
    assertSuccess(packageSync("--record"));
    assert.match(readFileSync(join(packageRoot, "pi/overlays/pstack.patch"), "utf8"), /skills\/tdd\/debug\.log/);
    rmSync(extra);
    assertSuccess(packageSync("--record"));
    assert.deepEqual(readFileSync(join(packageRoot, ".gitignore")), readFileSync(join(root, ".gitignore")));
    const globalIgnore = join(temp, "global-ignore");
    put(globalIgnore, "*.tmp\n");
    execFileSync("git", ["config", "--file", gitConfig, "core.excludesFile", globalIgnore]);
    put(join(packageRoot, "skills/tdd/cache.tmp"), "local\n");
    const overlay = readFileSync(join(packageRoot, "pi/overlays/pstack.patch"));
    assertSuccess(packageSync("--check"));
    assertSuccess(packageSync("--record"));
    assert.deepEqual(readFileSync(join(packageRoot, "pi/overlays/pstack.patch")), overlay);
    const file = join(packageRoot, "skills/tdd/SKILL.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}\nchanged\n`);
    const drift = packageSync("--check");
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /Drifted generated path: skills\/tdd\/SKILL.md/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("offline sync check rejects generated content, inventory, and mode drift", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "pi-pstack-offline-check-"));
  try {
    for (const path of ["scripts", "docs", "skills", "agents", "LICENSE", "plugin.json", "package.json", "upstream.json", "vendor", "pi"]) {
      if (existsSync(join(root, path))) cpSync(join(root, path), join(temp, path), { recursive: true });
    }
    const check = () => spawnSync(process.execPath, [join(temp, "scripts/sync-pstack.mjs"), "--check"],
      { cwd: temp, encoding: "utf8" });
    assertSuccess(check());
    const file = join(temp, "skills/tdd/SKILL.md");
    const original = readFileSync(file);
    await t.test("content", () => {
      writeFileSync(file, Buffer.concat([original, Buffer.from("\nchanged\n")]));
      const result = check();
      writeFileSync(file, original);
      assert.notEqual(result.status, 0);
    });
    await t.test("unexpected file", () => {
      const extra = join(temp, "skills/tdd/unexpected.txt");
      put(extra, "unexpected\n");
      const result = check();
      rmSync(extra);
      assert.notEqual(result.status, 0);
    });
    await t.test("executable mode", () => {
      chmodSync(file, 0o755);
      const result = check();
      chmodSync(file, 0o644);
      assert.notEqual(result.status, 0);
    });
    assertSuccess(check());
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// Issue #7 and issue #16: exercise staging, a clean upstream merge, a later
// removal, and recovery through the public CLI and real Git worktrees.
test("staged sync preserves generated files until review and protects previously shipped skills", (t) => {
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
    cpSync(join(root, "vendor/pstack"), pstack, { recursive: true });
    commit(source, ["pstack"], "Initial upstream");
    for (const path of ["scripts", "docs", ".gitignore", ...shippedPaths]) {
      cpSync(join(root, path), join(target, path), { recursive: true });
    }
    commit(target, ["scripts", "docs", ".gitignore", ...shippedPaths], "Initialize adapter");
    const toolDependencies = join(target, "skills/poteto-mode/scripts/node_modules");
    put(join(toolDependencies, "commander/package.json"), "{}\n");
    assertSuccess(sync(target, "--check"));
    assertSuccess(sync(target, "--record"));
    assert.doesNotMatch(readFileSync(join(target, "pi/overlays/pstack.patch"), "utf8"), /node_modules\/commander/);
    rmSync(toolDependencies, { recursive: true, force: true });
    const before = generatedSnapshot(target);

    const added = join(pstack, "skills", "fixture-added", "SKILL.md");
    const adapted = join(pstack, "skills/tdd/SKILL.md");
    const manifest = join(pstack, "plugin.json");
    put(added, skill("fixture-added", "New independently shipped instructions."));
    put(adapted, `${readFileSync(adapted, "utf8")}\nUpstream guidance added.\n`);
    const plugin = JSON.parse(readFileSync(manifest));
    plugin.version = "0.15.37";
    put(manifest, JSON.stringify(plugin, null, 2) + "\n");
    commit(source, ["pstack"], "Add a skill and update an adapted file");
    assertSuccess(sync(target, source));
    assert.deepEqual(generatedSnapshot(target), before, "Staging must not publish any generated content or provenance");
    const review = JSON.parse(readFileSync(join(target, ".pstack-sync/review.json")));
    assert.ok(review.changes.some(({ path, status, classification }) =>
      path === "skills/fixture-added/SKILL.md" && status === "A" && classification === "shipped"));
    assert.ok(review.changes.some(({ path, adapted }) => path === "skills/tdd/SKILL.md" && adapted));
    const obstruction = join(target, ".pstack-sync/backup/upstream.json");
    mkdirSync(obstruction, { recursive: true });
    const failedPublication = sync(target, "--continue");
    assert.equal(failedPublication.status, 1, failedPublication.stdout + failedPublication.stderr);
    assert.match(failedPublication.stderr, /Publication failed and previous files were restored/);
    assert.deepEqual(generatedSnapshot(target), before, "A publication failure must roll back every generated path and provenance");
    rmSync(obstruction, { recursive: true });
    assertSuccess(sync(target, "--continue"));
    assertSuccess(sync(target, "--check", source));
    assert.match(readFileSync(join(target, "skills/fixture-added/SKILL.md"), "utf8"), /^disable-model-invocation: true$/m);
    assert.match(readFileSync(join(target, "skills/tdd/SKILL.md"), "utf8"), /Upstream guidance added/);
    assert.equal(JSON.parse(readFileSync(join(target, "package.json"))).version, "0.15.37");
    const afterAddition = generatedSnapshot(target);
    assertSuccess(sync(target, source));
    assert.deepEqual(generatedSnapshot(target), afterAddition, "An unchanged upstream tree is idempotent");
    commit(target, shippedPaths, "Ship the reviewed addition");
    git(temp, "clone", target, shipped);
    assert.equal(git(shipped, "status", "--porcelain"), "");
    const beforeRemoval = generatedSnapshot(shipped);

    rmSync(dirname(added), { recursive: true });
    plugin.version = "0.15.38";
    put(manifest, JSON.stringify(plugin, null, 2) + "\n");
    put(join(pstack, "LICENSE"), "Changed upstream attribution\n");
    commit(source, ["pstack"], "Remove the previously shipped addition");
    const staged = sync(shipped, source);
    assert.equal(staged.status, 1, staged.stdout + staged.stderr);
    assert.match(staged.stderr, /Unresolved upstream conflicts/);
    assert.deepEqual(generatedSnapshot(shipped), beforeRemoval);
    const workspace = join(shipped, ".pstack-sync/worktree");
    git(workspace, "rm", "-r", "--", "skills/fixture-added");
    const rejected = sync(shipped, "--continue");
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    assert.match(rejected.stderr, /Refusing to remove shipped skills without approval: fixture-added/);
    assert.deepEqual(generatedSnapshot(shipped), beforeRemoval, "A rejected removal must leave generated bytes and provenance unchanged");
    assert.equal(git(shipped, "status", "--porcelain"), "");

    git(workspace, "checkout", "pi-rendering", "--", "skills/fixture-added");
    assertSuccess(sync(shipped, "--continue"));
    assertSuccess(sync(shipped, "--check", source));
    assert.match(readFileSync(join(shipped, "skills/fixture-added/SKILL.md"), "utf8"), /New independently shipped instructions/);
    const provenance = JSON.parse(readFileSync(join(shipped, "upstream.json")));
    assert.equal(provenance.repoCommitSha, git(source, "rev-parse", "HEAD"));
    assert.equal(provenance.pstackCommitSha, git(source, "log", "-1", "--format=%H", "--", "pstack"));
    assert.equal(provenance.pstackTreeSha, git(source, "rev-parse", "HEAD:pstack"));
    assert.equal(provenance.version, "0.15.38");
    t.diagnostic("Addition, review, idempotence, removal rejection and preservation passed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// Issue #13: execute the generated audit against public synthetic sessions, not
// a source-text assertion. Resolve temp paths before Git records the worktrees.
test("generated worktree audit uses the newest Pi or Cursor session", async (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "pi-pstack-recency-")));
  const repo = join(temp, "repo");
  const candidate = join(temp, "candidate");
  const bin = join(temp, "bin");
  const script = join(root, "skills/poteto-mode/scripts/worktree-audit.sh");
  const recent = new Date(Date.now() - 60 * 60 * 1000);
  const old = new Date(recent.getTime() - 30 * 24 * 60 * 60 * 1000);
  try {
    mkdirSync(repo);
    git(repo, "init", "--initial-branch=main");
    put(join(repo, "README.md"), "Synthetic worktree audit input\n");
    commit(repo, ["README.md"], "Synthetic merged base");
    git(repo, "worktree", "add", "-b", "candidate", candidate);
    assert.equal(realpathSync(candidate), candidate);
    for (const name of ["origin", "gh"]) {
      const wrapper = join(bin, name);
      put(wrapper, "#!/bin/sh\nprintf '%s\\n' '[]'\n");
      chmodSync(wrapper, 0o755);
    }
    for (const [name, sessions] of [
      ["recent Pi only", [["pi", recent]]],
      ["newer Pi than Cursor", [["pi", recent], ["cursor", old]]],
      ["recent Cursor control", [["cursor", recent]]],
    ]) {
      await t.test(name, () => {
        const caseDir = join(temp, name.replaceAll(" ", "-"));
        const home = join(caseDir, "home");
        const agentDir = join(caseDir, "agent");
        mkdirSync(home, { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        const records = [];
        for (const [kind, mtime] of sessions) {
          const file = kind === "pi"
            ? join(agentDir, "sessions", "folder with spaces", "pi session.jsonl")
            : join(home, ".cursor", "projects", repo.slice(1).replaceAll("/", "-"), "agent-transcripts", "cursor.jsonl");
          put(file, JSON.stringify({ cwd: candidate }) + "\n");
          utimesSync(file, mtime, mtime);
          records.push({ file, mtime: statSync(file).mtime.toISOString(), body: readFileSync(file, "utf8") });
        }
        const args = [script, "-b", "main", repo];
        const result = spawnSync("bash", args, { encoding: "utf8", timeout: 10000,
          env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, PI_CODING_AGENT_DIR: agentDir,
            TMPDIR: caseDir, TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
        t.diagnostic(JSON.stringify({ command: ["bash", ...args], records,
          status: result.status, stdout: result.stdout, stderr: result.stderr }));
        assertSuccess(result);
        const fields = result.stdout.trim().split("\n").at(-1).split("\t");
        assert.equal(fields.length, 9, result.stdout);
        assert.deepEqual({ merged: fields[2], dirty: fields[3], pr: fields[5],
          lastChat: fields[6], bucket: fields[7], worktree: fields[8] }, {
          merged: "YES", dirty: "clean", pr: "-", lastChat: recent.toISOString().slice(0, 10),
          bucket: "verify-recent-chat", worktree: candidate,
        });
      });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
