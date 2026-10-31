import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requiredSkills } from "./required-skills.mjs";

function resolveHostIndex() {
  if (process.env.PI_HOST_INDEX) return pathToFileURL(process.env.PI_HOST_INDEX).href;
  try {
    return import.meta.resolve("@earendil-works/pi-coding-agent");
  } catch {
    const candidates = [
      process.env.PI_PACKAGE_DIR && join(process.env.PI_PACKAGE_DIR, "dist/index.js"),
      join(homedir(), ".local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    ].filter(Boolean);
    try {
      const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
      candidates.push(join(globalRoot, "@earendil-works/pi-coding-agent/dist/index.js"));
    } catch {
      // The explicitly selected host does not require a global npm installation.
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) return pathToFileURL(candidate).href;
    }
    throw new Error("Could not resolve @earendil-works/pi-coding-agent for discovery test.");
  }
}

const hostIndex = resolveHostIndex();
const { DefaultResourceLoader, SettingsManager } = await import(hostIndex);
const root = fileURLToPath(new URL("..", import.meta.url));
const upstream = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
const delegationSkills = [
  "architect", "arena", "how", "interrogate", "maintain-verification-skill",
  "no-comments", "reflect", "show-me-your-work", "swarm",
];

async function withRpc(cli, args, options, run) {
  const child = spawn(process.execPath, [cli, "--mode", "rpc", ...args], options);
  const closed = once(child, "close");
  const events = [];
  const waiting = new Map();
  const watchers = new Set();
  let buffer = "";
  let stderr = "";
  let sequence = 0;
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      events.push(event);
      for (const watch of watchers) watch(event);
      const resolve = waiting.get(event.id);
      if (resolve) {
        waiting.delete(event.id);
        resolve(event);
      }
    }
  });
  child.once("close", () => {
    for (const resolve of waiting.values()) resolve({ success: false, error: `RPC exited: ${stderr}` });
    waiting.clear();
    for (const watch of watchers) watch();
  });
  const request = (command) => new Promise((resolve) => {
    const id = `request-${++sequence}`;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
  });
  // Resolves with the first matching event, including one already received, or undefined if Pi exits first.
  const waitForEvent = (matches) => new Promise((resolve) => {
    const seen = events.find(matches);
    if (seen) return resolve(seen);
    const watch = (event) => {
      if (event && !matches(event)) return;
      watchers.delete(watch);
      resolve(event);
    };
    watchers.add(watch);
  });
  try {
    await run(request, events, waitForEvent);
  } finally {
    child.stdin.end();
    const [code, signal] = await closed;
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
  }
}

function assertNoRunnableModel(response) {
  assert.equal(response.success, true, JSON.stringify(response));
  const model = response.data.model;
  assert.ok(!model || (model.provider === "unknown" && model.api === "unknown"),
    "The isolated fixture must have no runnable model before prompts are submitted");
}

function assertModelValidation(response) {
  assert.equal(response.success, false, JSON.stringify(response));
  assert.match(response.error, /No model|No API key|Authentication/i);
  assert.doesNotMatch(response.error, /pi-pstack:/);
}

async function readToolState(request, events) {
  const result = await request({ type: "prompt", message: "/pstack-test-tools" });
  assert.equal(result.success, true, JSON.stringify(result));
  const notification = events.findLast((event) => event.message?.startsWith("pstack-test-tools:"));
  assert.ok(notification, "Missing tool-state probe");
  return JSON.parse(notification.message.slice("pstack-test-tools:".length));
}

test("packed pstack loads and routes workflows with or without delegation", async (t) => {
  const packageDir = fileURLToPath(new URL("..", hostIndex));
  const temp = mkdtempSync(join(tmpdir(), "pi-pstack-discovery-"));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = join(temp, "project");
  const agentDir = join(temp, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  try {
    const [packed] = Object.values(JSON.parse(execFileSync(
      "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
      { cwd: root, encoding: "utf8" },
    )));
    execFileSync("tar", ["-xzf", join(temp, packed.filename), "-C", temp]);
    const packedRoot = join(temp, "package");
    process.env.HOME = temp;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const settingsManager = SettingsManager.inMemory({ packages: [packedRoot] });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();
    assert.deepEqual(diagnostics, []);
    const expected = readdirSync(join(root, "skills")).sort();
    for (const name of requiredSkills) {
      assert.ok(expected.includes(name), `Missing shipped skill: ${name}`);
    }
    assert.deepEqual(skills.map(({ name }) => name).sort(), expected);
    assert.deepEqual(skills.filter(({ disableModelInvocation }) => !disableModelInvocation)
      .map(({ name }) => name).sort(),
    expected.filter((name) => !name.startsWith("principle-")));
    for (const skill of skills) {
      assert.equal(realpathSync(skill.sourceInfo.path), realpathSync(join(packedRoot, "skills", skill.name, "SKILL.md")));
    }
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 1);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packedRoot] }));
    const env = {
      HOME: temp,
      PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_PACKAGE_DIR: packageDir,
    };
    const cli = join(packageDir, "dist/bundle/cli.js");
    const args = ["--offline", "--no-session", "--no-approve", "-np", "-nc", "--no-themes"];
    const options = { cwd, env, stdio: ["pipe", "pipe", "pipe"] };
    await t.test("native package filters exclude only the selected skill", async () => {
      const filtered = join(temp, "filtered-agent");
      mkdirSync(filtered);
      writeFileSync(join(filtered, "settings.json"), JSON.stringify({
        packages: [{ source: packedRoot, skills: ["!skills/how/SKILL.md"] }],
      }));
      await withRpc(cli, args, { ...options, env: { ...env, PI_CODING_AGENT_DIR: filtered } }, async (request) => {
        const commands = await request({ type: "get_commands" });
        assert.equal(commands.success, true);
        const names = commands.data.commands.map(({ name }) => name);
        assert.ok(!names.includes("skill:how"));
        assert.ok(names.includes("skill:why"));
        assert.ok(names.includes("pstack-mode"));
      });
    });
    const probe = join(temp, "tool-state.mjs");
    writeFileSync(probe, `export default function(pi) {
      pi.registerCommand("pstack-test-tools", { handler: async (_args, ctx) => {
        ctx.ui.notify("pstack-test-tools:" + JSON.stringify({ active: pi.getActiveTools(),
          tools: pi.getAllTools().map(({ name, exposure, sourceInfo }) => ({ name, exposure, path: sourceInfo.path })) }), "info");
      } });
    }`);
    await t.test("status handles an unavailable upstream and caches success under a tilde agent directory", async () => {
      const fetchProbe = join(temp, "pstack-fetch-probe.mjs");
      writeFileSync(fetchProbe, `
        let available = false;
        globalThis.fetch = async () => {
          if (!available) throw new TypeError("fetch failed");
          return { ok: true, json: async () => [{ sha: "test-upstream", commit: { message: "test update" } }] };
        };
        export default function(pi) {
          pi.registerCommand("pstack-test-fetch", { handler: async () => { available = true; } });
        }
      `);
      const statusEnv = { ...env, PI_CODING_AGENT_DIR: "~/agent" };
      delete statusEnv.PI_OFFLINE;
      const statusArgs = [...args.filter((arg) => arg !== "--offline"), "-e", fetchProbe];
      await withRpc(cli, statusArgs, { ...options, env: statusEnv }, async (request, events) => {
        async function command(message) {
          const before = events.length;
          const result = await request({ type: "prompt", message });
          assert.equal(result.success, true, JSON.stringify(result));
          return events.slice(before).findLast((event) => event.type === "extension_ui_request" && event.method === "notify")?.message;
        }
        assert.match(await command("/pstack-status"), /Could not reach GitHub API/);
        await command("/pstack-test-fetch");
        assert.match(await command("/pstack-status"), /upstream update available/);
        const cache = JSON.parse(readFileSync(join(agentDir, "cache/pi-pstack-upstream.json"), "utf8"));
        assert.equal(cache.latestSha, "test-upstream");
      });
    });
    await t.test("mode reports unavailable skills and a later forced system prompt", async () => {
      await withRpc(cli, [...args, "--no-skills"], options, async (request, events) => {
        const result = await request({ type: "prompt", message: "/pstack-mode on" });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.ok(events.some((event) => event.method === "notify" && event.message?.includes("skill is excluded or unavailable")));
      });
      const forceProbe = join(temp, "pstack-force-probe.mjs");
      writeFileSync(forceProbe, `
        import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
        export default function(pi) {
          const main = fauxProvider({ provider: "pstack-force-main", models: [{ id: "native" }] });
          main.setResponses([fauxAssistantMessage("Done.")]);
          pi.registerProvider(main.provider);
          pi.on("before_agent_start", (event) => { event.systemPromptOptions.forceSystemPrompt = "A forced system prompt."; });
        }
      `);
      await withRpc(cli, [...args, "-e", join(packedRoot, "extensions/index.js"), "-e", forceProbe,
        "--provider", "pstack-force-main", "--model", "native"],
        options, async (request, events, waitForEvent) => {
          assert.equal((await request({ type: "prompt", message: "/pstack-mode on" })).success, true);
          const before = events.length;
          assert.equal((await request({ type: "prompt", message: "Run with the forced prompt." })).success, true);
          assert.ok(await waitForEvent((event) => event.type === "agent_settled" && events.indexOf(event) >= before));
          assert.ok(events.slice(before).some((event) => event.method === "notify" &&
            event.message?.includes("forces the system prompt")), JSON.stringify(events.slice(before)));
        });
    });
    await t.test("mode follows the active branch and capability reports respect Pi's tool visibility", async () => {
      const runtimeProbe = join(temp, "pstack-runtime-probe.mjs");
      writeFileSync(runtimeProbe, `
        import { Type } from "typebox";
        import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
        export default function(pi) {
          let hidden = false;
          const main = fauxProvider({ provider: "pstack-runtime-main", models: [{ id: "native" }] });
          main.setResponses([
            fauxAssistantMessage([fauxToolCall("pstack_capabilities", {
              names: ["pstack-visible-probe", "pstack-hidden-probe"]
            }, { id: "capability-check" })], { stopReason: "toolUse" }),
            fauxAssistantMessage("Capabilities checked."),
            fauxAssistantMessage([fauxToolCall("pstack_opinion", {
              model: "pstack-runtime-judge/native", question: "Review the supplied text.", context: "A short document."
            }, { id: "opinion-check" })], { stopReason: "toolUse" }),
            fauxAssistantMessage("Opinion received."),
            fauxAssistantMessage("Mode checked."),
            fauxAssistantMessage([fauxToolCall("pstack-toggle-probe", {}, { id: "toggle-hidden" })], { stopReason: "toolUse" }),
            fauxAssistantMessage([fauxToolCall("pstack_capabilities", {
              names: ["pstack-hidden-probe"]
            }, { id: "capability-after-refresh" })], { stopReason: "toolUse" }),
            fauxAssistantMessage("Refreshed capabilities checked.")
          ]);
          const judge = fauxProvider({ provider: "pstack-runtime-judge", models: [{ id: "native" }] });
          judge.setResponses([fauxAssistantMessage("The document is clear.")]);
          pi.registerProvider(main.provider);
          pi.registerProvider(judge.provider);
          for (const name of ["pstack-visible-probe", "pstack-hidden-probe"]) {
            pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}),
              async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
          }
          pi.registerTool({ name: "pstack-policy-probe", label: "policy", description: "policy",
            parameters: Type.Object({}), prepareLoadout: () => ({ hiddenDeclarations: hidden ? ["pstack-hidden-probe"] : [] }),
            async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
          pi.registerTool({ name: "pstack-toggle-probe", label: "toggle", description: "toggle",
            parameters: Type.Object({}), async execute() { hidden = true; return { content: [], details: {} }; } });
          pi.registerCommand("pstack-test-hide", { handler: async () => { hidden = true; } });
          pi.registerCommand("pstack-test-show", { handler: async () => { hidden = false; } });
          pi.registerCommand("pstack-test-navigate", { handler: async (id, ctx) => {
            await ctx.navigateTree(id.trim(), { summarize: false });
          } });
        }
      `);
      const runtimeArgs = [...args.filter((arg) => arg !== "--no-session"), "-e", runtimeProbe,
        "--provider", "pstack-runtime-main", "--model", "native"];
      await withRpc(cli, runtimeArgs, options, async (request, events, waitForEvent) => {
        async function command(message) {
          const before = events.length;
          const result = await request({ type: "prompt", message });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.data.disposition, "handled");
          return events.slice(before).findLast((event) => event.type === "extension_ui_request" && event.method === "notify")?.message;
        }
        async function run(message, toolCallId) {
          const before = events.length;
          const result = await request({ type: "prompt", message });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.data.disposition, "started");
          assert.ok(await waitForEvent((event) => event.type === "agent_settled" && events.indexOf(event) >= before));
          if (toolCallId) {
            const tool = events.slice(before).find((event) => event.type === "tool_execution_end" && event.toolCallId === toolCallId);
            assert.ok(tool, JSON.stringify(events.slice(before)));
            return tool;
          }
        }
        assert.match(await command("/pstack-mode status"), /mode is off/);
        assert.match(await command("/pstack-mode on"), /mode is on/);
        const entries = await request({ type: "get_entries" });
        const enabledEntry = entries.data.entries.findLast((entry) => entry.type === "custom" && entry.customType === "pstack-mode" && entry.data.enabled);
        assert.ok(enabledEntry);

        await command("/pstack-test-hide");
        const capabilities = await run("Check the pstack loadout.", "capability-check");
        assert.equal(capabilities.isError, false, JSON.stringify(capabilities));
        assert.ok(capabilities.result.details.tools.some(({ name, parameters }) => name === "pstack-visible-probe" && parameters));
        assert.ok(!JSON.stringify(capabilities.result).includes("pstack-hidden-probe"), JSON.stringify(capabilities));
        const messages = await request({ type: "get_messages" });
        assert.ok(messages.data.messages.some((message) => message.role === "system" &&
          message.sections?.pstack_mode?.includes("Persistent pstack mode is on.")), JSON.stringify(messages));
        const opinion = await run("Ask for a text opinion.", "opinion-check");
        assert.equal(opinion.isError, false, JSON.stringify(opinion));
        assert.match(opinion.result.content[0].text, /Text-only opinion.*The document is clear/s);
        assert.equal(opinion.result.details.kind, "text-only opinion");
        assert.ok(opinion.result.usage);

        assert.match(await command("/pstack-mode off"), /mode is off/);
        await command(`/pstack-test-navigate ${enabledEntry.id}`);
        assert.match(await command("/pstack-mode status"), /mode is on/);
        await run("Continue on the restored branch.");
        const state = await request({ type: "get_state" });
        assert.ok(state.data.sessionFile);
        await command("/pstack-test-show");
        const refreshed = await run("Recheck after the tool loadout refreshes.", "capability-after-refresh");
        assert.equal(refreshed.isError, false, JSON.stringify(refreshed));
        assert.match(refreshed.result.details.visibility, /unknown/);
        assert.ok(!JSON.stringify(refreshed.result).includes("pstack-hidden-probe"), JSON.stringify(refreshed));
        assert.equal((await request({ type: "new_session" })).success, true);
        assert.match(await command("/pstack-mode status"), /mode is off/);
        assert.equal((await request({ type: "switch_session", sessionPath: state.data.sessionFile })).success, true);
        assert.match(await command("/pstack-mode status"), /mode is on/);
      });
    });
    await t.test("each user-facing skill reaches Pi directly and through a nested read without delegation", async () => {
      const workflowSkills = expected.filter((name) => !name.startsWith("principle-"));
      const inlineProbe = join(temp, "inline-probe.mjs");
      writeFileSync(inlineProbe, `
        import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
        export default function(pi) {
          const model = fauxProvider({ provider: "pstack-inline-probe", models: [{ id: "native" }] });
          model.setResponses(${JSON.stringify(workflowSkills)}.flatMap((name) => [
            fauxAssistantMessage(fauxToolCall("read", { path: ${JSON.stringify(packedRoot)} + "/skills/" + name + "/SKILL.md" },
              { id: "nested-" + name }), { stopReason: "toolUse" }),
            fauxAssistantMessage("Inline route available.")
          ]));
          pi.registerProvider(model.provider);
        }
      `);
      await withRpc(cli, [...args, "-e", inlineProbe, "--provider", "pstack-inline-probe", "--model", "native"],
        options, async (request, events, waitForEvent) => {
          for (const name of workflowSkills) {
            const before = events.length;
            const started = await request({ type: "prompt", message: `/skill:${name} inspect` });
            assert.equal(started.success, true, JSON.stringify(started));
            assert.equal(started.data.disposition, "started");
            assert.ok(await waitForEvent((event) => event.type === "agent_settled" && events.indexOf(event) >= before));
            const current = events.slice(before);
            const user = current.find((event) => event.type === "message_end" && event.message.role === "user")?.message;
            const userText = typeof user?.content === "string" ? user.content :
              user?.content?.map((part) => part.text ?? "").join("") ?? "";
            assert.ok(userText.includes(`<skill name="${name}"`), name);
            const read = current.find((event) => event.type === "tool_execution_end" && event.toolCallId === `nested-${name}`);
            assert.ok(read && !read.isError, JSON.stringify(read));
            const content = read.result.content.map((part) => part.text ?? "").join("\n");
            assert.match(content, /Pi execution contract/);
            if (delegationSkills.includes(name)) assert.match(content, /inline route/);
          }
        });
    });
    await t.test("poteto-mode names and reads every packed playbook", async () => {
      const modeRoot = join(packedRoot, "skills/poteto-mode");
      const mode = readFileSync(join(modeRoot, "SKILL.md"), "utf8");
      const section = mode.split("## Playbooks\n")[1];
      assert.ok(section, "poteto-mode must describe its playbooks");
      const named = [...section.matchAll(/^- \*\*(.+?)\*\* (.+)$/gm)].map(([, title, details]) => {
        const explicit = details.match(/File: `(playbooks\/[^`]+)`/)?.[1];
        const slug = title.replace(/\.$/, "").toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-");
        return explicit ?? `playbooks/${slug}.md`;
      }).sort();
      const shipped = readdirSync(join(modeRoot, "playbooks"))
        .filter((name) => name.endsWith(".md")).map((name) => `playbooks/${name}`).sort();
      assert.deepEqual(named, shipped);
      const probe = join(temp, "playbook-probe.mjs");
      writeFileSync(probe, `
        import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
        export default function(pi) {
          const model = fauxProvider({ provider: "pstack-playbook-probe", models: [{ id: "native" }] });
          model.setResponses([
            fauxAssistantMessage(${JSON.stringify(named)}.map((name, i) =>
              fauxToolCall("read", { path: ${JSON.stringify(modeRoot)} + "/" + name }, { id: "playbook-" + i })),
              { stopReason: "toolUse" }),
            fauxAssistantMessage("Playbooks read.")
          ]);
          pi.registerProvider(model.provider);
        }
      `);
      await withRpc(cli, [...args, "-e", probe, "--provider", "pstack-playbook-probe", "--model", "native"],
        options, async (request, events, waitForEvent) => {
          const started = await request({ type: "prompt", message: "/skill:poteto-mode inspect playbooks" });
          assert.equal(started.data.disposition, "started");
          assert.ok(await waitForEvent((event) => event.type === "agent_settled"));
          for (const [index, name] of named.entries()) {
            const result = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === `playbook-${index}`);
            assert.ok(result && !result.isError, name);
            assert.match(result.result.content.map((part) => part.text ?? "").join("\n"), /Pi execution contract/, name);
          }
        });
    });
    // Issue #7: exercise the real native command expander, not source-text equality
    // or a paid model. Public followUp queues expanded input without inference.
    await t.test("native SDK expands synced formal skills and sharpen without inference", () => {
      execFileSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(${JSON.stringify(hostIndex)});
        const settingsManager = SettingsManager.inMemory({ packages: [${JSON.stringify(packedRoot)}] });
        const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
          settingsManager, noContextFiles: true });
        await loader.reload();
        const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
          settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory() });
        try {
          const cases = [
            ["create-formal-verification-skill", "TLA+ is the default", "Pi execution contract"],
            ["maintain-formal-verification-skill", "Do not move the sync commit for a blocked check", "Pi execution contract"],
            ["sharpen", "Then rewrite my prompt", "Leave choices that are mine to make open"],
          ];
          for (const [name, ...markers] of cases) {
            assert.equal(await session.followUp("/skill:" + name + " issue7-input"), "queued");
            const [expanded] = session.getFollowUpMessages();
            assert.ok(expanded.startsWith('<skill name="' + name + '" location="'));
            assert.ok(expanded.includes(${JSON.stringify(packedRoot)} + "/skills/" + name + "/SKILL.md"));
            for (const marker of markers) assert.ok(expanded.includes(marker), name + ": " + marker);
            assert.ok(expanded.endsWith("</skill>\\n\\nissue7-input"));
            session.clearQueue();
          }
          assert.deepEqual(session.messages, []);
        } finally { session.dispose(); }
      `], { cwd, env, encoding: "utf8", timeout: 30000 });
    });
    await withRpc(cli, args, options, async (request, events) => {
      const commands = await request({ type: "get_commands" });
      assert.equal(commands.success, true, JSON.stringify(commands));
      assert.deepEqual(commands.data.commands.filter(({ source }) => source === "skill").map(({ name }) => name).sort(), expected.map((name) => `skill:${name}`).sort());
      assert.ok(commands.data.commands.some(({ name }) => name === "pstack-status"));
      assert.equal((await request({ type: "prompt", message: "/pstack-status" })).success, true);
      assert.ok(events.some((event) => event.method === "notify" &&
        event.message?.includes(`v${upstream.version}`) && event.message.includes(upstream.pstackCommitSha.slice(0, 7)) &&
        event.message.includes("Offline mode active")));
      const state = await request({ type: "get_state" });
      assertNoRunnableModel(state);
      for (const name of delegationSkills) {
        assertModelValidation(await request({ type: "prompt", message: `/skill:${name} audit` }));
      }
      for (const name of ["unslop", "tdd", "poteto-mode", "create-formal-verification-skill", "maintain-formal-verification-skill", "sharpen"]) {
        assertModelValidation(await request({ type: "prompt", message: `/skill:${name} text` }));
      }
      assert.ok(!events.some(({ type }) => type === "agent_start" || type === "tool_execution_start"));
    });

    await t.test("real pi-subagents discovers profiles and exposes dynamic and eager tools", {
      skip: !process.env.PI_SUBAGENTS_INDEX && "Set PI_SUBAGENTS_INDEX to qualify the optional provider",
    }, async () => {
      const provider = process.env.PI_SUBAGENTS_INDEX;
      assert.ok(existsSync(provider), `Missing pi-subagents extension: ${provider}`);
      const configDir = join(agentDir, "extensions", "subagent");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config.json"), JSON.stringify({ toolActivation: "eager" }));
      const profileProbe = join(temp, "profile-probe.mjs");
      writeFileSync(profileProbe, `
        import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
        export default function (pi) {
          const model = fauxProvider({ provider: "pstack-profile-probe", models: [{ id: "native" }] });
          const calls = [
            fauxToolCall("subagent", { action: "list", options: { capabilities: true } }, { id: "profiles" }),
            ...["comment-sicko", "poteto-agent"].map((agent) =>
              fauxToolCall("subagent", { action: "get", agent }, { id: agent })),
          ];
          model.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
          pi.registerProvider(model.provider);
        }
      `);
      await withRpc(cli, [...args.filter((arg) => arg !== "--no-session"), "-e", provider, "-e", profileProbe,
        "--provider", "pstack-profile-probe", "--model", "native"], options, async (request, events, waitForEvent) => {
        const started = await request({ type: "prompt", message: "List the packaged pstack profiles." });
        assert.equal(started.success, true, JSON.stringify(started));
        assert.equal(started.data.disposition, "started");
        assert.ok(await waitForEvent((event) => event.type === "agent_settled"));
        const results = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
        assert.equal(results.length, 3, JSON.stringify(results));
        for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
        const listed = results.find(({ toolCallId }) => toolCallId === "profiles");
        assert.deepEqual(listed.result.details.agentCapabilities.agents
          .filter(({ source }) => source === "package").map(({ name }) => name).sort(), ["comment-sicko", "poteto-agent"]);
        for (const name of ["comment-sicko", "poteto-agent"]) {
          const result = results.find(({ toolCallId }) => toolCallId === name);
          const text = result.result.content.find(({ type }) => type === "text").text;
          assert.ok(text.includes(`Path: ${join(packedRoot, "agents", `${name}.md`)}`), text);
        }
      });
      for (const mode of ["dynamic", "dynamic-codemode", "eager", "excluded"]) {
        writeFileSync(join(configDir, "config.json"), JSON.stringify({
          toolActivation: mode === "eager" ? "eager" : "dynamic",
        }));
        const providerArgs = [...args.filter((arg) => arg !== "--no-session"), "-e", provider, "-e", probe];
        if (mode === "dynamic-codemode") providerArgs.push("--tools", "read,bash,edit,write,codemode,subagent,subagents_enable");
        if (mode === "excluded") providerArgs.push("--exclude-tools", "subagent,subagents_enable");
        await withRpc(cli, providerArgs, options, async (request, events) => {
          assertNoRunnableModel(await request({ type: "get_state" }));
          const { active, tools } = await readToolState(request, events);
          if (mode.startsWith("dynamic")) {
            assert.ok(active.includes("subagents_enable"), mode);
            assert.ok(!active.includes("subagent"), mode);
            for (const name of ["subagent", "subagents_enable"]) {
              assert.equal(tools.find((tool) => tool.name === name)?.exposure, "model-only", name);
            }
            if (mode === "dynamic-codemode") assert.ok(active.includes("codemode"));
          } else if (mode === "eager") {
            assert.ok(active.includes("subagent"));
            assert.ok(!tools.some(({ name }) => name === "subagents_enable"));
          } else {
            assert.ok(!tools.some(({ name }) => ["subagent", "subagents_enable"].includes(name)));
          }
          for (const name of delegationSkills) {
            assertModelValidation(await request({ type: "prompt", message: `/skill:${name} audit` }));
          }
          assertModelValidation(await request({ type: "prompt", message: "/skill:tdd text" }));
          assert.ok(!events.some(({ type }) => type === "agent_start" || type === "tool_execution_start"));
          assert.ok(!events.some((event) => event.message?.includes("pi-pstack:")));
        });
      }
    });

    await t.test("configured fitchmultz pi-subagents package admits delegation and completes a delegated run", {
      skip: !process.env.PI_FITCH_SUBAGENTS_INDEX && "Set PI_FITCH_SUBAGENTS_INDEX to qualify the configured provider",
    }, async () => {
      const entry = realpathSync(process.env.PI_FITCH_SUBAGENTS_INDEX);
      // Without an owning package.json, Node 24.22 returns the queried path instead of the documented undefined.
      const packageJson = findPackageJSON(pathToFileURL(entry));
      assert.equal(basename(packageJson ?? ""), "package.json", `No package.json owns ${entry}`);
      const providerRoot = dirname(packageJson);
      // Private broker and provider temp roots keep these sessions out of the user's live state.
      const broker = mkdtempSync(join(tmpdir(), "psic-"));
      const agentFor = (name) => {
        const dir = join(temp, name);
        mkdirSync(join(dir, "extensions"), { recursive: true });
        writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [packedRoot, providerRoot] }));
        return { ...options, env: { ...env, PI_CODING_AGENT_DIR: dir, PI_INTERCOM_RUNTIME_DIR: join(broker, "i"),
          PI_SUBAGENT_TEMP_ROOT: join(broker, "pi-subagents-runtime") } };
      };
      try {
        const noModel = agentFor("provider-agent");
        await withRpc(cli, [...args, "-e", probe], noModel, async (request, events) => {
          assertNoRunnableModel(await request({ type: "get_state" }));
          const { active, tools } = await readToolState(request, events);
          for (const name of ["delegate", "agent_runs"]) {
            assert.ok(active.includes(name), name);
            assert.equal(realpathSync(tools.find((tool) => tool.name === name).path), entry, `${name} comes from another provider`);
          }
          assertModelValidation(await request({ type: "prompt", message: "/skill:how audit" }));
        });
        await withRpc(cli, [...args, "--exclude-tools", "delegate,agent_runs"], noModel, async (request) => {
          assertModelValidation(await request({ type: "prompt", message: "/skill:how audit" }));
        });

        // Pi's built-in faux model answers offline, both here and in the provider's real child process.
        const scripted = agentFor("faux-agent");
        writeFileSync(join(scripted.env.PI_CODING_AGENT_DIR, "extensions", "faux.js"), `
          import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
          const text = ({ content }) => typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
          function reply({ messages }) {
            const last = text(messages.at(-1));
            if (last === "pstack-child-assignment") return fauxAssistantMessage("PSTACK_CHILD_RESULT");
            if (last.startsWith('<skill name="how"')) {
              return fauxAssistantMessage(fauxToolCall("delegate", { prompt: "pstack-child-assignment" }), { stopReason: "toolUse" });
            }
            return fauxAssistantMessage(last.includes("PSTACK_CHILD_RESULT") ? "PSTACK_PARENT_DONE" : "PSTACK_PARENT_WAITING");
          }
          export default function (pi) {
            const model = fauxProvider({ provider: "pstack-faux", models: [{ id: "native" }] });
            model.setResponses([reply, reply, reply]);
            pi.registerProvider(model.provider);
          }
        `);
        await withRpc(cli, [...args, "--provider", "pstack-faux", "--model", "native"], scripted, async (request, _events, waitForEvent) => {
          const started = await request({ type: "prompt", message: "/skill:how audit" });
          assert.equal(started.success, true, JSON.stringify(started));
          assert.equal(started.data.disposition, "started");
          // agent_end ends every run, including a failed one. Pi steers the provider's completion notice into
          // the prompt's run while it is still streaming; otherwise the notice starts the next run.
          const launched = await waitForEvent((event) => event.type === "agent_end");
          assert.ok(launched?.messages.some(({ role, toolName, isError }) => role === "toolResult" && toolName === "delegate" && !isError),
            `delegate did not launch the child: ${JSON.stringify(launched?.messages.slice(-2))}`);
          const notified = launched.messages.some(({ role, customType }) => role === "custom" && customType === "agent-completion");
          const relayed = notified ? launched : await waitForEvent((event) => event.type === "agent_end" && event !== launched);
          assert.ok(relayed?.messages.some(({ role, content }) => role === "assistant" && content.some((part) => part.text === "PSTACK_PARENT_DONE")),
            `The parent did not relay its delegated child's result: ${JSON.stringify(relayed?.messages.slice(-2))}`);
        });
      } finally {
        rmSync(broker, { recursive: true, force: true });
      }
    });

    await t.test("a different package's namesake remains runnable", async () => {
      const otherSkill = join(temp, "other-swarm", "SKILL.md");
      mkdirSync(dirname(otherSkill));
      writeFileSync(otherSkill, "---\nname: swarm\ndescription: An unrelated inline skill\n---\nWrite one sentence.\n");
      await withRpc(cli, [...args, "--no-skills", "--skill", otherSkill], options, async (request) => {
        const commands = await request({ type: "get_commands" });
        const selected = commands.data.commands.find(({ name }) => name === "skill:swarm");
        assert.equal(realpathSync(selected.sourceInfo.path), realpathSync(otherSkill));
        assertModelValidation(await request({ type: "prompt", message: "/skill:swarm text" }));
      });
    });

    await t.test("print mode can run the inline route without a delegation provider", () => {
      const printProbe = join(temp, "print-probe.mjs");
      writeFileSync(printProbe, `
        import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
        export default function(pi) {
          const model = fauxProvider({ provider: "pstack-print-probe", models: [{ id: "native" }] });
          model.setResponses([fauxAssistantMessage("PSTACK_PRINT_INLINE")]);
          pi.registerProvider(model.provider);
        }
      `);
      const result = spawnSync(process.execPath, [cli, ...args, "-e", printProbe,
        "--provider", "pstack-print-probe", "--model", "native", "-p", "/skill:swarm audit"],
      { cwd, env, encoding: "utf8", timeout: 30000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PSTACK_PRINT_INLINE/);
    });
    t.diagnostic(`Selected native host: ${packageDir}`);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(temp, { recursive: true, force: true });
  }
});
