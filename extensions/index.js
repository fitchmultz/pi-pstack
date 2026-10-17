import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_FILE = join(PACKAGE_ROOT, "upstream.json");
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const API_URL = "https://api.github.com/repos/cursor/plugins/commits?path=pstack&per_page=1";

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
