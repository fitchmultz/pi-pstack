import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM_FILE = join(PACKAGE_ROOT, "upstream.json");
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const API_URL = "https://api.github.com/repos/cursor/plugins/commits?path=pstack&per_page=1";
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
  let modeEnabled = false;
  let modeRequested = false;
  let runOptions;
  let turnCount = 0;

  const modeAvailable = () => ownsSkill(
    pi.getCommands().find((entry) => entry.name === "skill:poteto-mode"),
    "poteto-mode",
  );
  const restoreMode = (ctx) => {
    modeEnabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "pstack-mode" &&
          typeof entry.data?.enabled === "boolean") {
        modeEnabled = entry.data.enabled;
      }
    }
  };

  pi.on("session_start", (_event, ctx) => restoreMode(ctx));
  pi.on("session_tree", (_event, ctx) => restoreMode(ctx));

  pi.registerCommand("pstack-mode", {
    description: "Turn persistent poteto mode on or off, or show its status",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "status") {
        const availability = modeEnabled && !modeAvailable() ? " (poteto-mode is excluded or unavailable)" : "";
        ctx.ui.notify(`pstack mode is ${modeEnabled ? "on" : "off"}${availability}.`, "info");
        return;
      }
      if (action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /pstack-mode on|off|status", "warning");
        return;
      }
      if (action === "on" && !modeAvailable()) {
        ctx.ui.notify("pstack mode cannot start: this package's poteto-mode skill is excluded or unavailable.", "warning");
        return;
      }
      modeEnabled = action === "on";
      pi.appendEntry("pstack-mode", { enabled: modeEnabled });
      ctx.ui.notify(`pstack mode is ${modeEnabled ? "on" : "off"}.`, "info");
    },
  });

  pi.on("before_agent_start", (event) => {
    // Pi finishes the first request's loadout after this event and updates this
    // options object. Later turns use a new object, so their visibility is unknown here.
    runOptions = event.systemPromptOptions;
    turnCount = 0;
    modeRequested = modeEnabled && modeAvailable();
    if (!modeRequested) {
      delete event.systemPromptOptions.sections.pstack_mode;
      return;
    }
    if (event.systemPromptOptions.forceSystemPrompt !== undefined) return;
    const path = join(PACKAGE_ROOT, "skills", "poteto-mode", "SKILL.md");
    event.systemPromptOptions.sections.pstack_mode =
      `Persistent pstack mode is on. Follow the installed skill at ${path}:\n\n${readFileSync(path, "utf8")}`;
  });
  pi.on("turn_start", (_event, ctx) => {
    turnCount += 1;
    if (turnCount === 1 && modeRequested && runOptions.forceSystemPrompt !== undefined) {
      ctx.ui.notify("pstack mode is on, but another extension forces the system prompt; its mode section cannot be applied.", "warning");
    }
  });

  pi.registerTool({
    name: "pstack_capabilities",
    label: "Pstack capabilities",
    description: "Inspect the current Pi tool loadout for a pstack workflow.",
    promptSnippet: "Check pstack workflow capabilities and session mode before choosing a route.",
    parameters: Type.Object({ names: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
    async execute(_id, { names = [] }, _signal, _onUpdate, ctx) {
      const active = new Set(pi.getActiveTools());
      const selected = new Set(runOptions?.selectedTools);
      const hidden = new Set(runOptions?.hiddenTools);
      const unchanged = runOptions && turnCount === 1 && active.size === selected.size &&
        [...active].every((name) => selected.has(name));
      const callable = new Set(ctx.tools.map(({ name }) => name));
      const tools = unchanged ? pi.getAllTools()
        .filter(({ name, exposure }) => active.has(name) && !hidden.has(name) && exposure !== "hidden")
        .map(({ name, exposure, sourceInfo, description, parameters }) => ({
          name, exposure, callable: callable.has(name),
          ...(names.includes(name) ? { sourceInfo, description, parameters } : {}),
        })) : [];
      const details = {
        mode: ctx.mode,
        visibility: unchanged ? "current request's declared loadout" : "unknown: Pi refreshed or changed the loadout",
        tools,
        guidance: "Presence does not prove permission, provider readiness, model access, or successful execution. Use advertised discovery and provider controls; inspect uncertain launches before retrying.",
      };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });

  pi.registerTool({
    name: "pstack_opinion",
    label: "Pstack text opinion",
    description: "Ask one configured Pi model for a text-only opinion.",
    promptSnippet: "Request an optional text-only model opinion, not a tool-using review.",
    parameters: Type.Object({
      model: Type.String({ description: "Configured provider/model ID." }),
      question: Type.String({ description: "Question for the model." }),
      context: Type.Optional(Type.String({ description: "Explicit material the model should consider." })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const separator = params.model.indexOf("/");
      if (separator <= 0 || separator === params.model.length - 1) throw new Error("Use a configured provider/model ID.");
      const model = ctx.modelRegistry.find(params.model.slice(0, separator), params.model.slice(separator + 1));
      if (!model) throw new Error(`Pi has no configured model ${params.model}. Choose an available model without changing global settings.`);
      const input = params.context ? `${params.question}\n\nMaterial:\n${params.context}` : params.question;
      const response = await ctx.modelRegistry.streamSimple(model, {
        systemPrompt: "Give a text-only opinion on the supplied material. You have no tools and cannot independently inspect files, run checks, or verify an application. Distinguish observations from uncertainty.",
        messages: [{ role: "user", content: input, timestamp: Date.now() }],
      }, { signal }).result();
      const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const details = { model: params.model, stopReason: response.stopReason, kind: "text-only opinion" };
      if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "toolUse") {
        return { content: [{ type: "text", text: response.errorMessage || `Opinion did not complete (${response.stopReason}).` }],
          details, usage: response.usage, isError: true };
      }
      return { content: [{ type: "text", text: `Text-only opinion from ${params.model} (${response.stopReason}):\n${text}` }],
        details, usage: response.usage };
    },
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
