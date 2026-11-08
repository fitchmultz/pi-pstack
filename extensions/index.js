import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerOpinionRenderer } from "./opinion-renderer.js";

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

/** Replays the branch's recorded tool loadout (Pi docs/session-format.md) for one tool. */
function removedOnBranch(ctx, name) {
  let removed = false;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "system") continue;
    if (entry.message.toolsRemoved?.some((tool) => tool.name === name)) removed = true;
    if (entry.message.toolsAdded?.some((tool) => tool.name === name)) removed = false;
  }
  return removed;
}

/**
 * Pi's own MCP extension activates tool_search when it registers deferred tools, since only
 * tool_search declares them. Only a registered tool_search that reaches other tools qualifies.
 * Pi restores each branch's recorded loadout before session_start and session_tree; a branch
 * that recorded removing tool_search keeps it off, as Pi keeps any recorded removal.
 */
function activateToolSearch(pi, ctx) {
  const active = pi.getActiveTools();
  if (!active.includes("tool_search") &&
      pi.getAllTools().some((tool) => tool.name === "tool_search" && tool.reachesTools !== undefined) &&
      !removedOnBranch(ctx, "tool_search")) {
    pi.setActiveTools([...active, "tool_search"]);
  }
}

/** Whether the agent can call pstack_opinion: it is declared, or an active tool_search or codemode reaches it. */
function opinionReachable(pi) {
  const tools = pi.getAllTools();
  const active = pi.getActiveTools();
  return !tools.some((tool) => tool.name === "pstack_opinion") || active.includes("pstack_opinion") ||
    tools.some((tool) => (tool.name === "tool_search" || tool.name === "codemode") &&
      tool.reachesTools !== undefined && active.includes(tool.name));
}

export default function piPstackExtension(pi) {
  registerOpinionRenderer(pi);
  let activeController;
  let modeEnabled = false;
  let modeRequested = false;
  let runOptions;
  let turnCount = 0;

  const modeAvailable = () => ownsSkill(
    pi.getCommands().find((entry) => entry.name === "skill:poteto-mode"),
    "poteto-mode",
  );
  const updateModeStatus = (ctx) => {
    if (!ctx.hasUI) return;
    const status = !modeEnabled ? undefined : !modeAvailable() ? "pstack: unavailable" :
      runOptions?.forceSystemPrompt !== undefined ? "pstack: prompt overridden" : "pstack: on";
    ctx.ui.setStatus("pstack-mode", status);
  };
  const restoreMode = (ctx) => {
    modeEnabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "pstack-mode" &&
          typeof entry.data?.enabled === "boolean") {
        modeEnabled = entry.data.enabled;
      }
    }
    updateModeStatus(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    restoreMode(ctx);
    activateToolSearch(pi, ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreMode(ctx);
    activateToolSearch(pi, ctx);
  });

  // Like Pi's own MCP extension, warn once when nothing can reach the deferred tool. Check as a run
  // starts: extensions that load later, such as Pi's MCP extension, can still activate tool_search
  // or codemode in their own session_start handlers.
  let warnedUnreachable = false;
  pi.on("before_agent_start", (_event, ctx) => {
    if (warnedUnreachable || opinionReachable(pi)) return;
    warnedUnreachable = true;
    ctx.ui.notify("pstack_opinion is only reachable from the tool_search or codemode tool, but neither is active; it cannot be called.", "warning");
  });

  pi.registerCommand("pstack-mode", {
    description: "Manage persistent poteto mode for this session branch",
    getArgumentCompletions: (prefix) => {
      const items = ["on", "off", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      let action = args.trim();
      if (!action && ctx.hasUI) {
        action = await ctx.ui.select(`Pstack mode is ${modeEnabled ? "on" : "off"}`, [
          modeEnabled ? "off" : "on", "status",
        ]);
        if (!action) return;
      }
      if (action === "status") {
        const availability = modeEnabled && !modeAvailable() ? " (poteto-mode is excluded or unavailable)" :
          modeEnabled && runOptions?.forceSystemPrompt !== undefined ? " (system prompt is overridden)" : "";
        updateModeStatus(ctx);
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
      updateModeStatus(ctx);
      ctx.ui.notify(`pstack mode is ${modeEnabled ? "on" : "off"}.`, "info");
    },
  });

  pi.on("before_agent_start", (event) => {
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
    if (turnCount === 1) updateModeStatus(ctx);
    if (turnCount === 1 && modeRequested && runOptions.forceSystemPrompt !== undefined) {
      ctx.ui.notify("pstack mode is on, but another extension forces the system prompt; its mode section cannot be applied.", "warning");
    }
  });

  pi.registerTool({
    name: "pstack_opinion",
    label: "Pstack text opinion",
    exposure: "deferred",
    description: "Ask one configured Pi model for a text-only opinion. Runs in the background by default in persistent Pi fork sessions; the answer arrives automatically.",
    promptSnippet: "Request a background text-only model opinion, not a tool-using review.",
    promptGuidelines: [
      "Call pstack_opinion directly for background work, then continue independent work. Its receipt is not the opinion. Pi delivers the answer automatically; stopping the session cancels pending opinions.",
      "Use pstack_opinion with background:false when a script must await the answer. Nested callers must own background execution themselves. Official Pi and one-shot print/JSON sessions default to foreground.",
    ],
    parameters: Type.Object({
      model: Type.String({ description: "Exact configured provider/model ID. Pass reasoning in the separate reasoning field." }),
      reasoning: Type.Optional(StringEnum(["minimal", "low", "medium", "high", "xhigh", "max"], {
        description: "Reasoning level for this request. Pi handles model support.",
      })),
      question: Type.String({ description: "Question for the model." }),
      context: Type.Optional(Type.String({ description: "Explicit material the model should consider." })),
      background: Type.Optional(Type.Boolean({
        description: "Default true in persistent Pi fork sessions. False waits for the answer. Background runs require a direct tool call and end with the session/process.",
      })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const separator = params.model.indexOf("/");
      if (separator <= 0 || separator === params.model.length - 1) throw new Error("Use a configured provider/model ID.");
      const model = ctx.modelRegistry.find(params.model.slice(0, separator), params.model.slice(separator + 1));
      if (!model) throw new Error(`Pi has no configured model ${params.model}. Use an exact provider/model ID. Pass reasoning separately, for example reasoning: "max". Choose an available model without changing global settings.`);
      const input = params.context ? `${params.question}\n\nMaterial:\n${params.context}` : params.question;
      const run = async (runSignal) => {
        const response = await ctx.modelRegistry.streamSimple(model, {
          systemPrompt: "Give a text-only opinion on the supplied material. You have no tools and cannot independently inspect files, run checks, or verify an application. Distinguish observations from uncertainty.",
          messages: [{ role: "user", content: input, timestamp: Date.now() }],
        }, { signal: runSignal, reasoning: params.reasoning }).result();
        const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        const details = { model: params.model, stopReason: response.stopReason, kind: "text-only opinion" };
        if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "toolUse") {
          return { content: [{ type: "text", text: response.errorMessage || `Opinion did not complete (${response.stopReason}).` }],
            details, usage: response.usage, isError: true };
        }
        return { content: [{ type: "text", text: `Text-only opinion from ${params.model} (${response.stopReason}):\n${text}` }],
          details, usage: response.usage };
      };
      const background = params.background ??
        (typeof ctx.runInBackground === "function" && (ctx.mode === "tui" || ctx.mode === "rpc"));
      if (!background) return run(signal);
      if (typeof ctx.runInBackground !== "function") {
        throw new Error("This Pi host has no background tool runs. Use background:false to wait for the opinion.");
      }
      const runId = ctx.runInBackground("pstack-opinion", run);
      return {
        content: [{ type: "text", text: `Opinion from ${params.model} started in the background. Run ${runId}. Continue independent work; Pi will deliver the answer automatically. Stopping, reloading, leaving the session branch, or exiting cancels it.` }],
        details: { runId, model: params.model, kind: "text-only opinion", background: true },
      };
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
          `pstack upstream has new commits in cursor/plugins (${cached.latestSha.slice(0, 7)}: ${cached.latestSubject ?? "updated"}). These changes may not be packaged for Pi yet. Use /pstack-status for details.`,
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
            `pstack upstream has new commits in cursor/plugins (${latest.sha.slice(0, 7)}: ${latest.subject}). These changes may not be packaged for Pi yet. Use /pstack-status for details.`,
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
            `pi-pstack upstream update available: installed ${upstream.pstackCommitSha?.slice(0, 7)} -> latest ${latest.sha.slice(0, 7)} (${latest.subject}). These changes need a reviewed Pi sync before they are installable. Check https://github.com/fitchmultz/pi-pstack/pulls. Pi's package update notice reports installable fork updates.`,
            "info",
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
