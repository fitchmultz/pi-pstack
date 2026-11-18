import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requiredSkills } from "./required-skills.mjs";

const root = path.resolve(import.meta.dirname, "..");
const skillsDir = path.join(root, "skills");
const agentsDir = path.join(root, "agents");

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

test("package manifest exposes skills, extension, and subagent profiles", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const upstream = JSON.parse(readFileSync(path.join(root, "upstream.json"), "utf8"));
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.deepEqual(manifest.pi.extensions, ["./extensions/index.js"]);
  assert.deepEqual(manifest.pi.subagents.agents, ["./agents"]);
  assert.deepEqual(manifest.subagents, manifest.pi.subagents);
  assert.equal(manifest.version, upstream.version);
  assert.match(upstream.pstackCommitSha, /^[0-9a-f]{40}$/);
  assert.match(upstream.pstackTreeSha, /^[0-9a-f]{40}$/);
  const skills = readdirSync(skillsDir);
  for (const name of requiredSkills) {
    assert.ok(skills.includes(name), `Missing shipped skill: ${name}`);
  }
  assert.deepEqual(readdirSync(agentsDir).sort(), ["comment-sicko.md", "poteto-agent.md"]);
});

test("sync-pstack --check passes and all skills have valid normalized frontmatter", () => {
  execFileSync(process.execPath, [path.join(root, "scripts", "sync-pstack.mjs"), "--check"], {
    cwd: root,
    encoding: "utf8",
  });

  const skills = readdirSync(skillsDir).sort();
  for (const skill of skills) {
    const source = readFileSync(path.join(skillsDir, skill, "SKILL.md"), "utf8");
    assert.match(source, new RegExp(`^---\\n[\\s\\S]*?^name: ${skill}$[\\s\\S]*?\\n---\\n`, "m"));
    assert.match(source, /^[a-z0-9-]+$/m.test(skill) ? /.*/ : /never/);
    for (const file of filesUnder(path.join(skillsDir, skill))) {
      assert.notEqual(path.basename(file), ".DS_Store");
      if (file.endsWith(".sh")) {
        assert.notEqual(statSync(file).mode & 0o111, 0, `${file} must be executable`);
      }
    }
  }
});

test("adapted agents include valid pi-subagents frontmatter and ponytail protection", () => {
  const potetoAgent = readFileSync(path.join(agentsDir, "poteto-agent.md"), "utf8");
  assert.match(potetoAgent, /^name: poteto-agent$/m);
  assert.doesNotMatch(potetoAgent, /^(?:model|fallbackModels):/m);
  assert.match(potetoAgent, /docs\/harness\/pi\.md/);

  const commentSicko = readFileSync(path.join(agentsDir, "comment-sicko.md"), "utf8");
  assert.match(commentSicko, /^name: comment-sicko$/m);
  assert.doesNotMatch(commentSicko, /^(?:model|fallbackModels):/m);
  assert.match(commentSicko, /docs\/harness\/pi\.md/);
  assert.match(commentSicko, /ponytail:/);
});

test("qualify-hosts --check-cache rejects partial caches and build refuses unowned non-empty directories", (t) => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-pstack-cache-test-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const script = path.join(root, "scripts", "qualify-hosts.mjs");
  const missingDir = path.join(tempRoot, "missing");
  assert.equal(
    spawnSync(process.execPath, [script, "--check-cache"], {
      cwd: root,
      env: { ...process.env, PI_PSTACK_HOSTS_CACHE_DIR: missingDir },
    }).status,
    1,
  );

  const partialDir = path.join(tempRoot, "partial");
  mkdirSync(partialDir, { recursive: true });
  writeFileSync(path.join(partialDir, ".pi-pstack-hosts-owner"), "pi-pstack qualify-hosts cache\n");
  assert.equal(
    spawnSync(process.execPath, [script, "--check-cache"], {
      cwd: root,
      env: { ...process.env, PI_PSTACK_HOSTS_CACHE_DIR: partialDir },
    }).status,
    1,
  );

  const unownedDir = path.join(tempRoot, "unowned");
  mkdirSync(unownedDir, { recursive: true });
  writeFileSync(path.join(unownedDir, "keep.txt"), "user file\n");
  const refused = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PI_PSTACK_HOSTS_CACHE_DIR: unownedDir },
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to replace non-empty unowned directory/);
  assert.equal(readFileSync(path.join(unownedDir, "keep.txt"), "utf8"), "user file\n");
});
