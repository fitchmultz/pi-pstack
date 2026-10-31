#!/usr/bin/env node
// Qualifies packed pstack on official Pi, Mitch's fitchmultz/pi fork, and his configured
// fitchmultz/pi-subagents. PR CI and the upstream sync gate both run it; change pins only here.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const officialVersion = "1.4.0";
const forkCommit = "9e0674ef667e90a63a5fb64f18fbb476cd1b8a3f";
const provider = "git:github.com/fitchmultz/pi-subagents@3676214592a883efdfc3cf99e89314b20070d043";
// The profile-based provider's existing regression also runs on these hosts.
const profileProvider = "pi-subagents@0.84.0";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "pi-pstack-hosts-"));
const piPackage = (prefix) => join(prefix, "node_modules/@earendil-works/pi-coding-agent");

function run(command, args, options) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

try {
  const official = join(work, "official");
  run("npm", ["install", "--prefix", official, "--no-save", "--ignore-scripts", `@earendil-works/pi-coding-agent@${officialVersion}`]);
  // Its Pi peers are optional, so npm installs no second Pi here; each host supplies them.
  const profiles = join(work, "profile-provider");
  run("npm", ["install", "--prefix", profiles, "--no-save", "--ignore-scripts", profileProvider]);

  // The fork's documented release build (FORK.md, "Install and activate"), staged without selecting it.
  const source = join(work, "fork-source");
  run("git", ["init", "--quiet", source]);
  run("git", ["fetch", "--quiet", "--depth=1", "https://github.com/fitchmultz/pi.git", forkCommit], { cwd: source });
  run("git", ["checkout", "--quiet", "--detach", forkCommit], { cwd: source });
  run("npm", ["ci", "--ignore-scripts"], { cwd: source });
  run("npm", ["run", "hydrate:model-data"], { cwd: source });
  const releases = join(work, "fork-releases");
  run(process.execPath, ["scripts/install-fork.mjs", "--ref", forkCommit, "--stage", "--releases", releases,
    "--selector", join(work, "fork-selector", "pi-coding-agent"), "--cache-dir", join(work, "fork-cache")], { cwd: source });
  const [release, ...others] = readdirSync(releases).filter((name) => name.startsWith(`${forkCommit}-`));
  if (!release || others.length) throw new Error(`Expected one staged fork release in ${releases}`);
  const fork = join(releases, release);

  // Pi's own git package installer, as Mitch installed the provider. It keeps the caller's network
  // settings, such as the npm registry and CA certificates. The private cwd, HOME, and agent directory
  // isolate the settings and state Pi uses; PATH selects the caller's Node and npm for the provider
  // build; PI_PACKAGE_DIR keeps an inherited override from pointing Pi at another installation.
  const home = join(work, "provider-home");
  mkdirSync(home);
  run(process.execPath, [join(piPackage(fork), "dist/bundle/cli.js"), "install", provider], {
    cwd: home,
    env: { ...process.env, HOME: home, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
      PI_CODING_AGENT_DIR: join(home, "agent"), PI_PACKAGE_DIR: piPackage(fork), PI_TELEMETRY: "0" },
  });
  const providerIndex = join(home, "agent/git/github.com/fitchmultz/pi-subagents/dist/index.js");

  for (const host of [official, fork]) {
    run("npm", ["run", "smoke"], {
      cwd: root,
      env: { ...process.env, PI_HOST_INDEX: join(piPackage(host), "dist/index.js"), PI_PACKAGE_DIR: piPackage(host),
        PI_FITCH_SUBAGENTS_INDEX: providerIndex,
        PI_SUBAGENTS_INDEX: join(profiles, "node_modules/pi-subagents/bundle/index.js") },
    });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
