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

test("packed pstack loads alone and guards only its delegation workflows before inference", async (t) => {
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
      .map(({ name }) => name).sort(), ["poteto-mode", "tdd"]);
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
    const probe = join(temp, "tool-state.mjs");
    writeFileSync(probe, `export default function(pi) {
      pi.registerCommand("pstack-test-tools", { handler: async (_args, ctx) => {
        ctx.ui.notify("pstack-test-tools:" + JSON.stringify({ active: pi.getActiveTools(),
          tools: pi.getAllTools().map(({ name, exposure, sourceInfo }) => ({ name, exposure, path: sourceInfo.path })) }), "info");
      } });
    }`);
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
            ["create-formal-verification-skill", "TLA+ is the default", "Pi adapter"],
            ["maintain-formal-verification-skill", "Do not move the sync commit for a blocked check", "Pi adapter"],
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
        const result = await request({ type: "prompt", message: `/skill:${name} audit` });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.data.disposition, "handled");
        assert.ok(events.some((event) => event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error" && event.message.includes(`/skill:${name}`) && event.message.includes("pi-subagents")));
      }
      for (const name of ["unslop", "tdd", "poteto-mode", "create-formal-verification-skill", "maintain-formal-verification-skill", "sharpen"]) {
        assertModelValidation(await request({ type: "prompt", message: `/skill:${name} text` }));
      }
      assert.ok(!events.some(({ type }) => type === "agent_start" || type === "tool_execution_start"));
    });

    const registration = join(temp, "delegation-entry.mjs");
    writeFileSync(registration, `export default function(pi) {
      const mode = process.env.PSTACK_ADMISSION_FIXTURE;
      const loader = mode.startsWith("loader") || mode === "legacy-loader";
      pi.registerTool({ name: "subagent", label: "Admission fixture", description: "Never executed in this no-model fixture", defaultActive: mode === "active",
        ...(loader ? { exposure: "model-only" } : ["deferred", "discoverable"].includes(mode) ? { exposure: "deferred" } : {}),
        parameters: { type: "object", properties: {} }, execute: async () => { throw new Error("Unexpected tool execution"); } });
      if (mode === "discoverable") pi.on("session_start", () => pi.setActiveTools([...pi.getActiveTools(), "tool_search"]));
      if (loader) pi.registerTool({ name: mode === "legacy-loader" ? "load_subagent" : "subagents_enable", label: "Cold loader fixture", description: "Never executed",
        exposure: "model-only", defaultActive: mode !== "loader-inactive", parameters: { type: "object", properties: {} },
        execute: async () => { throw new Error("Unexpected loader execution"); } });
    }`);
    await t.test("only reachable delegation or an advertised cold loader passes admission", async () => {
      for (const mode of ["inactive", "deferred", "active", "discoverable", "loader", "loader-inactive", "legacy-loader"]) {
        const fixtureOptions = { ...options, env: { ...env, PSTACK_ADMISSION_FIXTURE: mode } };
        await withRpc(cli, [...args, "-e", registration], fixtureOptions, async (request) => {
          assertNoRunnableModel(await request({ type: "get_state" }));
          for (const name of mode === "loader" ? delegationSkills : ["swarm"]) {
            const result = await request({ type: "prompt", message: `/skill:${name} audit` });
            if (["inactive", "deferred", "loader-inactive"].includes(mode)) {
              assert.equal(result.success, true, `${mode}: ${JSON.stringify(result)}`);
              assert.equal(result.data.disposition, "handled", mode);
            } else assertModelValidation(result);
          }
        });
      }
      const loaderOptions = { ...options, env: { ...env, PSTACK_ADMISSION_FIXTURE: "loader" } };
      for (const excluded of ["subagents_enable", "subagent,subagents_enable"]) {
        await withRpc(cli, [...args, "-e", registration, "--exclude-tools", excluded], loaderOptions, async (request) => {
          const result = await request({ type: "prompt", message: "/skill:swarm audit" });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.data.disposition, "handled");
        });
      }
    });

    await t.test("real pi-subagents discovers profiles and admits dynamic and eager tools", {
      skip: !process.env.PI_SUBAGENTS_INDEX && "Set PI_SUBAGENTS_INDEX to qualify the optional provider",
    }, async () => {
      const provider = process.env.PI_SUBAGENTS_INDEX;
      assert.ok(existsSync(provider), `Missing pi-subagents extension: ${provider}`);
      // This scanner is internal to the CI-pinned provider; its public API has no package-discovery seam.
      const scanner = pathToFileURL(join(dirname(provider), "src", "agents", "agents.js")).href;
      const discovered = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
        const { discoverAgents } = await import(${JSON.stringify(scanner)});
        const { agents, agentDiagnostics: diagnostics } = discoverAgents(process.cwd(), "both", undefined, { globalNpmRoot: null });
        console.log(JSON.stringify({ agents: agents.filter(({ source }) => source === "package"), diagnostics }));
      `], { cwd, env, encoding: "utf8" }));
      assert.deepEqual(discovered.diagnostics, []);
      assert.deepEqual(discovered.agents.map(({ name }) => name).sort(), ["comment-sicko", "poteto-agent"]);
      for (const agent of discovered.agents) {
        assert.equal(realpathSync(agent.filePath), realpathSync(join(packedRoot, "agents", `${agent.name}.md`)));
      }
      const configDir = join(agentDir, "extensions", "subagent");
      mkdirSync(configDir, { recursive: true });
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
            const result = await request({ type: "prompt", message: `/skill:${name} audit` });
            if (mode === "excluded") {
              assert.equal(result.success, true, JSON.stringify(result));
              assert.equal(result.data.disposition, "handled");
              assert.ok(events.some((event) => event.notifyType === "error" && event.message?.includes(`pi-pstack: /skill:${name}`)));
            } else assertModelValidation(result);
          }
          assertModelValidation(await request({ type: "prompt", message: "/skill:tdd text" }));
          assert.ok(!events.some(({ type }) => type === "agent_start" || type === "tool_execution_start"));
          if (mode !== "excluded") assert.ok(!events.some((event) => event.message?.includes("pi-pstack:")));
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
        await withRpc(cli, [...args, "--exclude-tools", "delegate,agent_runs"], noModel, async (request, events) => {
          const result = await request({ type: "prompt", message: "/skill:how audit" });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.data.disposition, "handled");
          assert.ok(events.some((event) => event.notifyType === "error" && event.message.startsWith("pi-pstack: /skill:how")));
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

    await t.test("a different package's namesake is not intercepted", async () => {
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

    await t.test("print mode reports the missing capability and exits unsuccessfully", () => {
      const result = spawnSync(process.execPath, [cli, ...args, "-p", "/skill:swarm audit"], { cwd, env, encoding: "utf8", timeout: 30000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /pi-pstack: \/skill:swarm requires independent delegated work/);
      assert.match(result.stderr, /pi-subagents/);
      assert.doesNotMatch(result.stderr, /No model|No API key/);
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
