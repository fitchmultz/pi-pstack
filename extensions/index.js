import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_FILE = join(PACKAGE_ROOT, "upstream.json");
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const API_URL = "https://api.github.com/repos/cursor/plugins/commits?path=pstack&per_page=1";
const DELEGATION_SKILLS = new Set([
  "architect",
  "arena",
  "how",
  "interrogate",
  "maintain-verification-skill",
  "no-comments",
  "reflect",
  "show-me-your-work",
  "swarm",
]);

function ownsSkill(command, name) {
  try {
    return (
      command?.source === "skill" &&
      realpathSync(command.sourceInfo.path) ===
        realpathSync(join(PACKAGE_ROOT, "skills", name, "SKILL.md"))
    );
  } catch {
    return false;
  }
}

function getAgentDir() {
  const raw = process.env.PI_CODING_AGENT_DIR;
  if (!raw) return join(homedir(), ".pi", "agent");
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}

function getCachePath() {
  return join(getAgentDir(), "cache", "pi-pstack-upstream.json");
}

function readJsonSafe(filePath) {
  try {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } catch {
    // Cache writes are best-effort.
  }
}

async function fetchLatestUpstreamCommit(signal) {
  try {
    const response = await fetch(API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "pi-pstack-update-checker",
      },
      signal,
    });
    if (!response.ok) return undefined;
    const commits = await response.json();
    if (!Array.isArray(commits) || commits.length === 0) return undefined;
    const latest = commits[0];
    const sha = typeof latest?.sha === "string" ? latest.sha : undefined;
    if (!sha) return undefined;
    const subject =
      typeof latest?.commit?.message === "string"
        ? latest.commit.message.split(/\r?\n/, 1)[0]
        : "upstream update";
    const date = latest?.commit?.committer?.date ?? latest?.commit?.author?.date ?? undefined;
    return { sha, subject, date };
  } catch {
    return undefined;
  }
}

export default function piPstackExtension(pi) {
  let activeController;

  pi.on("input", (event, ctx) => {
    const name = /^\/skill:([a-z0-9-]+)(?: |$)/.exec(event.text)?.[1];
    if (!DELEGATION_SKILLS.has(name)) return;
    const command = pi.getCommands().find((entry) => entry.name === `skill:${name}`);
    if (!ownsSkill(command, name)) return;
    const active = new Set(pi.getActiveTools());
    const scripted = active.has("codemode") || active.has("tool_search");
    // ponytail: group-only deferred delegation stays blocked; revisit when a provider
    // advertises such a group or Pi exposes synchronous group reachability.
    if (
      pi.getAllTools().some(
        ({ name: toolName, exposure }) =>
          ["delegate", "subagent", "load_subagent"].includes(toolName) &&
          (active.has(toolName) ||
            (scripted && (exposure === "codemode" || exposure === "deferred"))),
      )
    ) return;
    const message =
      `pi-pstack: /skill:${name} requires independent delegated work. ` +
      "No supported delegation tool or loader is available in this session. " +
      "Enable a delegation provider such as pi-subagents and discover its profiles and run controls. " +
      "No workers were launched. Inline pstack skills such as /skill:unslop and /skill:tdd remain available.";
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else {
      console.error(message);
      // ponytail: the native SDK shares print mode; embedders must consume the diagnostic and reset exitCode if they continue.
      process.exitCode = 1;
    }
    return { action: "handled" };
  });

  pi.on("session_shutdown", () => {
    activeController?.abort();
    activeController = undefined;
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" || ctx.mode !== "tui" || process.env.PI_OFFLINE === "1") {
      return;
    }
    const upstream = readJsonSafe(UPSTREAM_FILE);
    if (!upstream?.pstackCommitSha) return;

    const cachePath = getCachePath();
    const cached = readJsonSafe(cachePath);
    const now = Date.now();
    if (
      cached &&
      typeof cached.checkedAtMs === "number" &&
      now - cached.checkedAtMs < CHECK_TTL_MS
    ) {
      if (
        cached.latestSha &&
        cached.latestSha !== upstream.pstackCommitSha &&
        cached.notifiedForInstalledSha !== upstream.pstackCommitSha
      ) {
        writeJsonSafe(cachePath, {
          ...cached,
          notifiedForInstalledSha: upstream.pstackCommitSha,
        });
        ctx.ui.notify(
          `pstack upstream has new commits in cursor/plugins (${cached.latestSha.slice(0, 7)}: ${cached.latestSubject ?? "updated"}). Run 'pi update --extensions' (or '/pstack-status' for details).`,
          "info",
        );
      }
      return;
    }

    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    timeout.unref?.();

    void fetchLatestUpstreamCommit(controller.signal)
      .then((latest) => {
        if (!latest || controller.signal.aborted) return;
        const isOutdated = latest.sha !== upstream.pstackCommitSha;
        const alreadyNotified =
          cached?.notifiedSha === latest.sha &&
          cached?.notifiedForInstalledSha === upstream.pstackCommitSha;
        writeJsonSafe(cachePath, {
          checkedAtMs: Date.now(),
          latestSha: latest.sha,
          latestSubject: latest.subject,
          latestDate: latest.date,
          notifiedSha: isOutdated ? latest.sha : cached?.notifiedSha,
          notifiedForInstalledSha: isOutdated
            ? upstream.pstackCommitSha
            : cached?.notifiedForInstalledSha,
        });
        if (isOutdated && !alreadyNotified) {
          ctx.ui.notify(
            `pstack upstream has new commits in cursor/plugins (${latest.sha.slice(0, 7)}: ${latest.subject}). Run 'pi update --extensions' (or '/pstack-status' for details).`,
            "info",
          );
        }
      })
      .catch(() => {
        // Network errors during background check are ignored.
      })
      .finally(() => {
        clearTimeout(timeout);
        if (activeController === controller) {
          activeController = undefined;
        }
      });
  });

  pi.registerCommand("pstack-status", {
    description: "Check installed pi-pstack snapshot against upstream cursor/plugins/pstack",
    handler: async (_args, ctx) => {
      const upstream = readJsonSafe(UPSTREAM_FILE);
      if (!upstream) {
        ctx.ui.notify("pi-pstack: upstream.json is missing.", "warning");
        return;
      }
      if (process.env.PI_OFFLINE === "1") {
        ctx.ui.notify(
          `pi-pstack v${upstream.version} (pstack commit ${upstream.pstackCommitSha?.slice(0, 7)}, tree ${upstream.pstackTreeSha?.slice(0, 7)}). Offline mode active.`,
          "info",
        );
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const latest = await fetchLatestUpstreamCommit(controller.signal);
        if (!latest) {
          ctx.ui.notify(
            `pi-pstack v${upstream.version} (installed pstack commit ${upstream.pstackCommitSha?.slice(0, 7)}). Could not reach GitHub API.`,
            "warning",
          );
          return;
        }
        writeJsonSafe(getCachePath(), {
          checkedAtMs: Date.now(),
          latestSha: latest.sha,
          latestSubject: latest.subject,
          latestDate: latest.date,
          notifiedSha: latest.sha,
          notifiedForInstalledSha: upstream.pstackCommitSha,
        });
        if (latest.sha === upstream.pstackCommitSha) {
          ctx.ui.notify(
            `pi-pstack is up to date with cursor/plugins/pstack (${latest.sha.slice(0, 7)}, v${upstream.version}).`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `pi-pstack upstream update available: installed ${upstream.pstackCommitSha?.slice(0, 7)} -> latest ${latest.sha.slice(0, 7)} (${latest.subject}). Run 'pi update --extensions' or trigger sync-upstream workflow.`,
            "info",
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
