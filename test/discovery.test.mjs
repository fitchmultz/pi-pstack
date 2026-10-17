import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolveHostIndex() {
  if (process.env.PI_HOST_INDEX) {
    return pathToFileURL(process.env.PI_HOST_INDEX).href;
  }
  try {
    return import.meta.resolve("@earendil-works/pi-coding-agent");
  } catch {
    const candidates = [
      process.env.PI_PACKAGE_DIR && join(process.env.PI_PACKAGE_DIR, "dist/index.js"),
      join(
        homedir(),
        ".local/share/npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      ),
    ].filter(Boolean);
    try {
      const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
      candidates.push(join(globalRoot, "@earendil-works/pi-coding-agent/dist/index.js"));
    } catch {
      // Ignore npm root lookup failure.
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return pathToFileURL(candidate).href;
      }
    }
    throw new Error("Could not resolve @earendil-works/pi-coding-agent for discovery test.");
  }
}

const hostIndex = resolveHostIndex();
const { DefaultResourceLoader, SettingsManager } = await import(hostIndex);
const root = fileURLToPath(new URL("..", import.meta.url));

test("native Pi discovery loads all 54 pstack skills and extension with zero diagnostics", async () => {
  const packageDir = fileURLToPath(new URL("..", hostIndex));
  const temp = mkdtempSync(join(tmpdir(), "pi-pstack-discovery-"));
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = join(temp, "project");
  const agentDir = join(temp, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  try {
    const [packed] = Object.values(
      JSON.parse(
        execFileSync(
          "npm",
          ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
          { cwd: root, encoding: "utf8" },
        ),
      ),
    );
    execFileSync("tar", ["-xzf", join(temp, packed.filename), "-C", temp]);

    process.env.HOME = temp;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const settingsManager = SettingsManager.inMemory({ packages: [join(temp, "package")] });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noContextFiles: true,
    });
    await loader.reload();

    const { skills, diagnostics } = loader.getSkills();
    assert.deepEqual(diagnostics, []);
    const expected = readdirSync(join(root, "skills")).sort();
    assert.equal(expected.length, 54);
    assert.deepEqual(skills.map(({ name }) => name).sort(), expected);

    const { extensions, errors } = loader.getExtensions();
    assert.deepEqual(errors, []);
    assert.equal(extensions.length, 1);

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: [join(temp, "package")] }),
    );
    const env = {
      HOME: temp,
      PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_PACKAGE_DIR: packageDir,
    };
    const output = execFileSync(
      process.execPath,
      [
        join(packageDir, "dist/bundle/cli.js"),
        "--offline",
        "--mode",
        "rpc",
        "--no-session",
        "--no-approve",
        "-np",
        "-nc",
        "--no-themes",
      ],
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: 30000,
        input: '{"id":"cmds","type":"get_commands"}\n',
      },
    );
    const response = output
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((event) => event.id === "cmds");
    assert.equal(response?.success, true, output);
    const skillCommands = response.data.commands
      .filter((command) => command.source === "skill")
      .map((command) => command.name)
      .sort();
    assert.deepEqual(
      skillCommands,
      expected.map((name) => `skill:${name}`).sort(),
    );
    const extCommands = response.data.commands
      .filter((command) => command.name === "pstack-status")
      .map((command) => command.name);
    assert.deepEqual(extCommands, ["pstack-status"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(temp, { recursive: true, force: true });
  }
});
