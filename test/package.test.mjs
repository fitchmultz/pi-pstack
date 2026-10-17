import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  assert.deepEqual(manifest.subagents.agents, ["./agents"]);
  assert.equal(manifest.version, upstream.version);
  assert.match(upstream.pstackCommitSha, /^[0-9a-f]{40}$/);
  assert.match(upstream.pstackTreeSha, /^[0-9a-f]{40}$/);
  assert.equal(readdirSync(skillsDir).length, 54);
  assert.deepEqual(readdirSync(agentsDir).sort(), ["comment-sicko.md", "poteto-agent.md"]);
});

test("sync-pstack --check passes and all skills have valid normalized frontmatter", () => {
  execFileSync(process.execPath, [path.join(root, "scripts", "sync-pstack.mjs"), "--check"], {
    cwd: root,
    encoding: "utf8",
  });

  const skills = readdirSync(skillsDir).sort();
  const advertised = [];
  for (const skill of skills) {
    const source = readFileSync(path.join(skillsDir, skill, "SKILL.md"), "utf8");
    assert.match(source, new RegExp(`^---\\n[\\s\\S]*?^name: ${skill}$[\\s\\S]*?\\n---\\n`, "m"));
    assert.match(source, /^[a-z0-9-]+$/m.test(skill) ? /.*/ : /never/);
    if (!/^disable-model-invocation:\s*true$/m.test(source)) {
      advertised.push(skill);
    }
    for (const file of filesUnder(path.join(skillsDir, skill))) {
      assert.notEqual(path.basename(file), ".DS_Store");
      if (file.endsWith(".sh")) {
        assert.notEqual(statSync(file).mode & 0o111, 0, `${file} must be executable`);
      }
    }
  }
  assert.deepEqual(advertised, ["poteto-mode", "tdd"]);
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

test("extension pstack-status handles fetch failures and tilde PI_CODING_AGENT_DIR gracefully", async () => {
  const { default: registerExtension } = await import("../extensions/index.js");
  let statusHandler;
  registerExtension({
    on() {},
    registerCommand(name, def) {
      if (name === "pstack-status") statusHandler = def.handler;
    },
  });
  assert.equal(typeof statusHandler, "function");

  const prevFetch = globalThis.fetch;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevOffline = process.env.PI_OFFLINE;
  const notifications = [];
  try {
    delete process.env.PI_OFFLINE;
    process.env.PI_CODING_AGENT_DIR = "~/.pi/agent";
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await statusHandler("", {
      ui: {
        notify(msg, level) {
          notifications.push({ msg, level });
        },
      },
    });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "warning");
    assert.match(notifications[0].msg, /Could not reach GitHub API/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = prevOffline;
  }
});
