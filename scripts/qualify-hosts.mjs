#!/usr/bin/env node
// Qualifies packed pstack on official Pi, Mitch's fitchmultz/pi fork, and his configured
// fitchmultz/pi-subagents. PR CI and the upstream sync gate both run it; change pins only here.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const officialVersion = "1.5.2";
const forkCommit = "87d3b99e642df9ce60ff985bad2e9b81fd4ff167";
const provider = "git:github.com/fitchmultz/pi-subagents@8ae797450349e428ebb432b002a90cb0e7c2352e";
// The profile-based provider's existing regression also runs on these hosts.
const profileProvider = "pi-subagents@0.86.0";
const OWNER_MARKER = ".pi-pstack-hosts-owner";

const root = join(import.meta.dirname, "..");
const configuredCacheDir = process.env.PI_PSTACK_HOSTS_CACHE_DIR?.trim();
const piPackage = (prefix) => join(prefix, "node_modules/@earendil-works/pi-coding-agent");

function run(command, args, options) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function stagedForkRelease(releasesDir) {
  if (!existsSync(releasesDir)) return undefined;
  const [release, ...others] = readdirSync(releasesDir).filter((name) => name.startsWith(`${forkCommit}-`));
  return release && others.length === 0 ? join(releasesDir, release) : undefined;
}

function readyCache(dir) {
  const markerPath = join(dir, ".ready.json");
  if (!existsSync(markerPath)) return undefined;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      marker?.dir !== dir ||
      marker?.officialVersion !== officialVersion ||
      marker?.forkCommit !== forkCommit ||
      marker?.provider !== provider ||
      marker?.profileProvider !== profileProvider
    ) {
      return undefined;
    }
    const official = join(dir, "official");
    const profiles = join(dir, "profile-provider");
    const fork = stagedForkRelease(join(dir, "fork-releases"));
    const providerIndex = join(dir, "provider-home/agent/git/github.com/fitchmultz/pi-subagents/dist/index.js");
    const profileIndex = join(profiles, "node_modules/pi-subagents/bundle/index.js");
    if (
      !fork ||
      !existsSync(join(piPackage(official), "dist/index.js")) ||
      !existsSync(join(piPackage(fork), "dist/index.js")) ||
      !existsSync(providerIndex) ||
      !existsSync(profileIndex)
    ) {
      return undefined;
    }
    return { official, fork, providerIndex, profileIndex };
  } catch {
    return undefined;
  }
}

function prepareOwnedCacheDir(dir) {
  if (existsSync(dir)) {
    if (!lstatSync(dir).isDirectory()) {
      throw new Error(`Refusing non-directory PI_PSTACK_HOSTS_CACHE_DIR: ${dir}`);
    }
    const entries = readdirSync(dir);
    if (entries.length > 0 && !entries.includes(OWNER_MARKER) && !entries.includes(".ready.json")) {
      throw new Error(
        `Refusing to replace non-empty unowned directory ${dir}; pass a dedicated empty or previous PI_PSTACK_HOSTS_CACHE_DIR path.`,
      );
    }
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  if (configuredCacheDir) {
    writeFileSync(join(dir, OWNER_MARKER), "pi-pstack qualify-hosts cache\n");
  }
}

function buildHosts(dir) {
  prepareOwnedCacheDir(dir);

  const official = join(dir, "official");
  run("npm", ["install", "--prefix", official, "--no-save", "--ignore-scripts", `@earendil-works/pi-coding-agent@${officialVersion}`]);
  // Its Pi peers are optional, so npm installs no second Pi here; each host supplies them.
  const profiles = join(dir, "profile-provider");
  run("npm", ["install", "--prefix", profiles, "--no-save", "--ignore-scripts", profileProvider]);

  // The fork's documented release build (FORK.md, "Install and activate"), staged without selecting it.
  const source = join(dir, "fork-source");
  const forkCache = join(dir, "fork-cache");
  run("git", ["init", "--quiet", source]);
  run("git", ["fetch", "--quiet", "--depth=1", "https://github.com/fitchmultz/pi.git", forkCommit], { cwd: source });
  run("git", ["checkout", "--quiet", "--detach", forkCommit], { cwd: source });
  run("npm", ["ci", "--ignore-scripts"], { cwd: source });
  run("npm", ["run", "hydrate:model-data"], { cwd: source });
  const releases = join(dir, "fork-releases");
  run(process.execPath, ["scripts/install-fork.mjs", "--ref", forkCommit, "--stage", "--releases", releases,
    "--selector", join(dir, "fork-selector", "pi-coding-agent"), "--cache-dir", forkCache], { cwd: source });
  rmSync(source, { recursive: true, force: true });
  rmSync(forkCache, { recursive: true, force: true });
  const fork = stagedForkRelease(releases);
  if (!fork) throw new Error(`Expected one staged fork release in ${releases}`);

  // Pi's own git package installer, as Mitch installed the provider. It keeps the caller's network
  // settings, such as the npm registry and CA certificates. The private cwd, HOME, and agent directory
  // isolate the settings and state Pi uses; PATH selects the caller's Node and npm for the provider
  // build; PI_PACKAGE_DIR keeps an inherited override from pointing Pi at another installation.
  const home = join(dir, "provider-home");
  mkdirSync(home);
  run(process.execPath, [join(piPackage(fork), "dist/bundle/cli.js"), "install", provider], {
    cwd: home,
    env: { ...process.env, HOME: home, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
      PI_CODING_AGENT_DIR: join(home, "agent"), PI_PACKAGE_DIR: piPackage(fork), PI_TELEMETRY: "0" },
  });
  const providerIndex = join(home, "agent/git/github.com/fitchmultz/pi-subagents/dist/index.js");
  const profileIndex = join(profiles, "node_modules/pi-subagents/bundle/index.js");

  if (configuredCacheDir) {
    writeFileSync(
      join(dir, ".ready.json"),
      `${JSON.stringify({ dir, officialVersion, forkCommit, provider, profileProvider }, null, 2)}\n`,
    );
  }
  return { official, fork, providerIndex, profileIndex };
}

if (process.argv.includes("--check-cache")) {
  process.exit(configuredCacheDir && readyCache(resolve(configuredCacheDir)) ? 0 : 1);
}

const work = configuredCacheDir
  ? resolve(configuredCacheDir)
  : mkdtempSync(join(tmpdir(), "pi-pstack-hosts-"));

try {
  const cached = configuredCacheDir ? readyCache(work) : undefined;
  if (cached) {
    console.log(`Reusing cached exact hosts from ${work}`);
  }
  const { official, fork, providerIndex, profileIndex } = cached ?? buildHosts(work);

  for (const host of [official, fork]) {
    run("npm", ["run", "smoke"], {
      cwd: root,
      env: { ...process.env, PI_HOST_INDEX: join(piPackage(host), "dist/index.js"), PI_PACKAGE_DIR: piPackage(host),
        PI_FITCH_SUBAGENTS_INDEX: providerIndex,
        PI_SUBAGENTS_INDEX: profileIndex },
    });
  }
} finally {
  if (!configuredCacheDir) {
    rmSync(work, { recursive: true, force: true });
  }
}
