#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = "docs/harness/pi.md";
const GITHUB = "https://github.com/cursor/plugins";
const LINK = /\]\(([^)\s]+)\)/g;
const ADAPTER_LINE =
  `In Pi, read [the Pi adapter](../../${ADAPTER}) before you follow this skill. ` +
  "Its capability checks and Pi tool, profile, model, and path rules override the Cursor assumptions below and in linked playbooks. " +
  "If a required delegation or live-driving capability is unavailable, stop that workflow and explain the missing prerequisite; do not substitute serial self-review.";

const ADVERTISED_SKILLS = new Set(["poteto-mode", "tdd"]);
const DESCRIPTION_IN_BODY_SKILLS = new Set([
  "principle-exhaust-the-design-space",
  "principle-encode-lessons-in-structure",
  "principle-migrate-callers-then-delete-legacy-apis",
  "principle-guard-the-context-window",
]);

const TERMS = [
  { key: "`Task`", re: /`Task`|\bTask (tool|subagent|call)/ },
  { key: "`AskQuestion`", re: /AskQuestion/ },
  { key: "todolist", re: /\btodo ?list\b/i },
  { key: "generalPurpose", re: /generalPurpose/ },
  { key: "poteto-agent", re: /poteto-agent/ },
  { key: "comment-sicko", re: /comment-sicko/ },
  { key: "`readonly: true`", re: /readonly: (true|false)|readonly\/Ask/ },
  { key: '`environment: "cloud"`', re: /environment: "(cloud|local)"/ },
  { key: "cloud_base_branch", re: /cloud_base_branch/ },
  { key: "`run_in_background: true`", re: /run_in_background/ },
  { key: "`resume`", re: /`resume`/ },
  { key: "`file_attachments`", re: /file_attachments/ },
  { key: "claude-", re: /\bclaude-[a-z]+-\d/ },
  { key: "grok-", re: /\bgrok-\d/ },
  { key: "gpt-", re: /\bgpt-\d/ },
  { key: "inherit-parent", re: /inherit-parent/ },
  { key: "pstack-models.mdc", re: /pstack-models\.mdc/ },
  { key: ".cursor/skills/", re: /\.cursor\/skills/ },
  { key: "~/.cursor/plugins/", re: /\.cursor\/plugins|\.cursor-plugin/ },
  { key: ".cursor/rules/", re: /\.cursor\/rules|always-applied rule/ },
  { key: "agent-transcripts", re: /agent-transcripts|\.cursor\/projects/ },
  {
    key: "Cursor-only features",
    re: /Bugbot|Cursor [Aa]utomation|cursor\.(sh|com)\/automations|[Cc]loud [Aa]gent/,
  },
];
const ROUTE_KEY = "Run another pstack skill";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".DS_Store" || name === "node_modules") return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function readFileEntry(fullPath) {
  return {
    bytes: readFileSync(fullPath),
    executable: (statSync(fullPath).mode & 0o111) !== 0,
  };
}

function normalizeFrontmatter(skillName, rawText) {
  const match = rawText.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return rawText;
  let [, fm, body] = match;

  // Normalize `name:` to match directory name (fixes `Poteto Mode` and `Make Bot UI`).
  fm = fm.replace(/^name:\s*.+$/m, `name: ${skillName}`);

  // Advertise only selected entry-point skills; hide the rest so startup prompt stays tiny.
  const shouldAdvertise = ADVERTISED_SKILLS.has(skillName);
  const hasDisable = /^disable-model-invocation:\s*(true|false)\s*$/m.test(fm);
  if (shouldAdvertise) {
    fm = fm.replace(/\n?^disable-model-invocation:\s*(true|false)\s*$/m, "");
  } else if (hasDisable) {
    fm = fm.replace(
      /^disable-model-invocation:\s*(true|false)\s*$/m,
      "disable-model-invocation: true",
    );
  } else {
    fm = `${fm}\ndisable-model-invocation: true`;
  }

  // Strip non-portable Cursor UI frontmatter keys (`icon`, `color`).
  fm = fm.replace(/\n?^(?:icon|color):\s*.+$/gm, "");

  // Extract description for principles whose primary rule is only in frontmatter.
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  const rawDesc = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "";
  if (DESCRIPTION_IN_BODY_SKILLS.has(skillName) && rawDesc && !body.includes(rawDesc)) {
    body = body.replace(/^(# .+)\n+/m, `$1\n\n${rawDesc}\n\n`);
  }

  return `---\n${fm.trim()}\n---\n${body}`;
}

function adaptPotetoAgent() {
  return `---
name: poteto-agent
description: Delegate subagent for code-writing and helper tasks spawned during a /skill:poteto-mode run. Reads poteto-mode SKILL.md and the Pi harness adapter in full before any work.
thinking: xhigh
systemPromptMode: append
inheritProjectContext: true
inheritSkills: true
defaultContext: fresh
allowSubagents: false
maxSubagentDepth: 0
---

# Poteto subagent

You are operating as poteto-mode's full agent style inside Pi. The parent session that receives \`/skill:poteto-mode\` owns the playbook, the checklist, and every subagent spawn. You are one of its delegates.

1. Read the \`poteto-mode\` skill's \`SKILL.md\` in full before doing any work, including its inline Principles index, and read \`docs/harness/pi.md\` in the same \`pi-pstack\` package. Use the absolute path your parent gave you, or derive the package root from \`poteto-mode\` in \`<available_skills>\`. If neither identifies the resource, ask the parent for its path rather than assuming a git install location.
2. Navigate to a leaf \`principle-*\` skill in sibling \`../principle-*/SKILL.md\` whenever you apply that principle.
3. Follow project \`AGENTS.md\` and Ponytail constraints (including preserving \`ponytail:\` ceiling comments and mandatory evidence/pushback gates).
`;
}

function adaptCommentSicko(upstreamText) {
  const bodyMatch = upstreamText.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  let body = bodyMatch ? bodyMatch[1].trimStart() : upstreamText;
  body = body.replace(
    /^# Comment Sicko\n+/m,
    `# Comment Sicko\n\nIn Pi, use the absolute package root supplied by the parent, or derive it from the loaded \`poteto-mode\` skill's location. Ask the parent if it cannot be resolved; do not assume a git install path. Read \`docs/harness/pi.md\` there before following \`/how\` or \`/why\`, and read \`skills/how/SKILL.md\` or \`skills/why/SKILL.md\` from that same package root when needed.\n\n`,
  );
  body = body.replace(
    "- Issue or RFC links that explain a constraint code cannot express.",
    "- Issue or RFC links that explain a constraint code cannot express.\n- Deliberate-shortcut ceiling comments marked with `ponytail:` and required repository policy comments (such as issue links on regression tests).",
  );
  body = body.replace(
    "I touch comments and identify refactor targets. I never write application code.",
    "I identify comments to delete and refactor targets. I never mutate files or write application code; the parent or worker applies accepted deletions.",
  );
  return `---
name: comment-sicko
description: A deranged comment-hater that savors deletion and condemns workaround code (report-only).
thinking: xhigh
systemPromptMode: append
inheritProjectContext: true
inheritSkills: true
defaultContext: fresh
output: false
allowSubagents: false
maxSubagentDepth: 0
---

${body}`;
}

function adaptNoCommentsSkill(text) {
  return text.replace(
    "Restore deletions only with exact exceptions and scoped proof.",
    "Restore deletions only with exact exceptions (including `ponytail:` ceiling comments and required project policy comments) and scoped proof.",
  );
}

function adaptCheckPlan(text) {
  return text.replace(
    'for (const marker of PROGRAM_MARKERS) {\n\t\tif (!bodyText(program).includes(marker)) fail(program.n, `Program checklist lacks "${marker}"`);\n\t}',
    'for (const marker of PROGRAM_MARKERS) {\n\t\tconst text = bodyText(program);\n\t\tconst ok = marker === "/loop 1h" ? (text.includes("/loop 1h") || text.includes("background_command") || text.includes("watch-pr")) : text.includes(marker);\n\t\tif (!ok) fail(program.n, `Program checklist lacks "${marker}"`);\n\t}',
  );
}

function adaptWatchPrGitHub(text) {
  const runner = '    const child = spawn(argv[0], argv.slice(1), {';
  if (!text.includes(runner)) {
    throw new Error("watch-pr command runner changed upstream; review the WATCH_PR_GH adaptation.");
  }
  return text.replace(runner,
    '    const executable = argv[0] === "gh" ? process.env.WATCH_PR_GH || "gh" : argv[0];\n' +
    '    const child = spawn(executable, argv.slice(1), {');
}

function adaptWorktreeAudit(text) {
  const oldBlock = `# Transcripts dir: ~/.cursor/projects/<slugified-repo-path>/agent-transcripts.
slug=$(printf '%s' "$main_wt" | sed 's#^/##; s#/#-#g')
transcripts="$HOME/.cursor/projects/$slug/agent-transcripts"`;
  const newBlock = `# Transcripts dirs: Cursor workspace transcripts and Pi sessions.
slug=$(printf '%s' "$main_wt" | sed 's#^/##; s#/#-#g')
transcripts="$HOME/.cursor/projects/$slug/agent-transcripts"
pi_sessions="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"`;

  const oldStatBlock = `\tlast="-"; last_ts=0
\tif [ -d "$transcripts" ]; then
\t\tf=$(rg -l -e "\${wt}/" -e "\${wt}\\"" "$transcripts" 2>/dev/null \\
\t\t\t| xargs stat "\${stat_fmt[@]}" 2>/dev/null | sort -rn | head -1)
\t\tif [ -n "$f" ]; then last_ts=$(echo "$f" | awk '{print $1}')
\t\t\tlast=$(fmt_day "$last_ts" 2>/dev/null); fi
\tfi`;
  const newStatBlock = `\tlast="-"; last_ts=0
\tsearch_dirs=()
\t[ -d "$transcripts" ] && search_dirs+=("$transcripts")
\t[ -d "$pi_sessions" ] && search_dirs+=("$pi_sessions")
\tif [ "\${#search_dirs[@]}" -gt 0 ]; then
\t\tf=$(rg -l -e "\${wt}/" -e "\${wt}\\"" "\${search_dirs[@]}" 2>/dev/null \\
\t\t\t| while IFS= read -r match; do
\t\t\t\tstat "\${stat_fmt[@]}" "$match" 2>/dev/null
\t\t\tdone | sort -rn | head -1)
\t\tif [ -n "$f" ]; then last_ts=$(echo "$f" | awk '{print $1}')
\t\t\tlast=$(fmt_day "$last_ts" 2>/dev/null); fi
\tfi`;

  if (!text.includes(oldBlock) || !text.includes(oldStatBlock)) {
    throw new Error("worktree-audit transcript lookup changed upstream; review the Pi session adaptation.");
  }
  return text.replace(oldBlock, newBlock).replace(oldStatBlock, newStatBlock);
}

function classifySkills(skillsRoot) {
  const skills = readdirSync(skillsRoot).filter((name) =>
    existsSync(join(skillsRoot, name, "SKILL.md")),
  );
  const classes = new Map();
  for (const skill of skills) {
    const dir = join(skillsRoot, skill);
    const others = skills.filter((name) => name !== skill).join("|");
    const route = new RegExp(`the \\*\\*(?<bold>${others})\\*\\* skill|\`/(?<command>${others})\``, "g");
    const linksToSkill = (line, name) => line.includes(`(../${name}/`);
    const namesBareSkill = (line) =>
      [...line.matchAll(route)].some(
        ({ groups }) => !linksToSkill(line, groups.bold ?? groups.command),
      );
    const usesCursorNames = new Set();
    for (const filePath of walk(dir).filter((p) => p.endsWith(".md"))) {
      const text = readFileSync(filePath, "utf8");
      for (const term of TERMS) {
        if (term.re.test(text)) usesCursorNames.add(term.key);
      }
      if (text.split("\n").some(namesBareSkill)) usesCursorNames.add(ROUTE_KEY);
    }
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");
    const wrap = usesCursorNames.size > 0 && /^# /m.test(text);
    classes.set(skill, { usesCursorNames, wrap });
  }
  return { skills, classes };
}

function validateAdapterCoverage(classes, adapterText) {
  const problems = [];
  const users = new Map();
  for (const [skill, { usesCursorNames, wrap }] of classes) {
    if (usesCursorNames.size > 0 && !wrap) {
      problems.push(`skills/${skill}/SKILL.md uses Cursor names but has no H1`);
    }
    for (const key of usesCursorNames) {
      users.set(key, [...(users.get(key) ?? []), skill]);
    }
  }
  for (const [key, using] of users) {
    if (!adapterText.includes(key)) {
      problems.push(`Pi adapter (${ADAPTER}) has no row for ${key}, used by ${using.join(", ")}`);
    }
  }
  return problems;
}

function resolvePstackLink(pstackRoot, from, href) {
  const target = href.replace(/[#?].*/, "");
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  const normalized = posix.join(posix.dirname(from), target).replace(/\/$/, "");
  return existsSync(join(pstackRoot, normalized)) ? normalized : undefined;
}

function hasPath(files, relPath) {
  return files.has(relPath) || [...files.keys()].some((key) => key.startsWith(`${relPath}/`));
}

function renderFromUpstream(sourceRepoRoot) {
  const pstackRoot = join(sourceRepoRoot, "pstack");
  const skillsRoot = join(pstackRoot, "skills");
  const adapterText = readFileSync(join(ROOT, ADAPTER), "utf8");
  const { skills, classes } = classifySkills(skillsRoot);
  const problems = validateAdapterCoverage(classes, adapterText);
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }

  const files = new Map();
  for (const fullPath of walk(skillsRoot)) {
    const rel = relative(pstackRoot, fullPath);
    files.set(rel, readFileEntry(fullPath));
  }
  files.set(ADAPTER, readFileEntry(join(ROOT, ADAPTER)));
  files.set("LICENSE", readFileEntry(join(pstackRoot, "LICENSE")));
  files.set("plugin.json", readFileEntry(join(pstackRoot, "plugin.json")));

  // Adapt agents for pi-subagents.
  files.set("agents/poteto-agent.md", {
    bytes: Buffer.from(adaptPotetoAgent(), "utf8"),
    executable: false,
  });
  const upstreamSicko = readFileSync(join(pstackRoot, "agents", "comment-sicko.md"), "utf8");
  files.set("agents/comment-sicko.md", {
    bytes: Buffer.from(adaptCommentSicko(upstreamSicko), "utf8"),
    executable: false,
  });

  // Normalize frontmatter and inject Pi adapter line into skills.
  for (const [skill, { wrap }] of classes) {
    const rel = `skills/${skill}/SKILL.md`;
    let text = files.get(rel).bytes.toString("utf8");
    text = normalizeFrontmatter(skill, text);
    if (skill === "no-comments") {
      text = adaptNoCommentsSkill(text);
    }
    if (wrap && !text.includes(ADAPTER_LINE)) {
      text = text.replace(/^(# .+)\n+/m, `$1\n\n${ADAPTER_LINE}\n\n`);
    }
    files.get(rel).bytes = Buffer.from(text, "utf8");
  }

  // Adapt helper scripts for Pi.
  const checkPlanKey = "skills/poteto-mode/scripts/check-plan.mjs";
  if (files.has(checkPlanKey)) {
    files.get(checkPlanKey).bytes = Buffer.from(
      adaptCheckPlan(files.get(checkPlanKey).bytes.toString("utf8")),
      "utf8",
    );
  }
  const watchPrGitHubKey = "skills/poteto-mode/scripts/watch-pr/github.ts";
  if (files.has(watchPrGitHubKey)) {
    files.get(watchPrGitHubKey).bytes = Buffer.from(
      adaptWatchPrGitHub(files.get(watchPrGitHubKey).bytes.toString("utf8")),
      "utf8",
    );
  }
  const worktreeAuditKey = "skills/poteto-mode/scripts/worktree-audit.sh";
  if (files.has(worktreeAuditKey)) {
    files.get(worktreeAuditKey).bytes = Buffer.from(
      adaptWorktreeAudit(files.get(worktreeAuditKey).bytes.toString("utf8")),
      "utf8",
    );
  }

  // Rewrite relative links that point to omitted pstack docs/assets to GitHub main.
  for (const [rel, entry] of files) {
    if (!rel.endsWith(".md")) continue;
    const text = entry.bytes.toString("utf8").replace(LINK, (link, href) => {
      const target = resolvePstackLink(pstackRoot, rel, href);
      if (!target || target.split("/")[0] === ".." || hasPath(files, target)) return link;
      const kind = statSync(join(pstackRoot, target)).isDirectory() ? "tree" : "blob";
      return `](${GITHUB}/${kind}/main/pstack/${target}${href.slice(href.search(/[#?]|$/))})`;
    });
    entry.bytes = Buffer.from(text, "utf8");
  }

  // Check for dangling internal links.
  const dangling = [];
  for (const [rel, entry] of files) {
    if (!rel.endsWith(".md")) continue;
    for (const [, href] of entry.bytes.toString("utf8").matchAll(LINK)) {
      const target = resolvePstackLink(pstackRoot, rel, href);
      if (target && !hasPath(files, target)) {
        dangling.push(`${rel} links to ${href}, which is not in the package tree`);
      }
    }
  }
  if (dangling.length > 0) {
    throw new Error(dangling.join("\n"));
  }

  const repoCommitSha = execFileSync("git", ["-C", sourceRepoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const pstackCommitSha = execFileSync(
    "git",
    ["-C", sourceRepoRoot, "log", "-1", "--format=%H", "--", "pstack"],
    { encoding: "utf8" },
  ).trim();
  const pstackTreeSha = execFileSync("git", ["-C", sourceRepoRoot, "rev-parse", "HEAD:pstack"], {
    encoding: "utf8",
  }).trim();
  const pluginManifest = JSON.parse(readFileSync(join(pstackRoot, "plugin.json"), "utf8"));

  const upstreamMeta = {
    repository: GITHUB,
    subpath: "pstack",
    version: pluginManifest.version,
    repoCommitSha,
    pstackCommitSha,
    pstackTreeSha,
  };

  return { files, skills, classes, upstreamMeta };
}

function checkOnDiskInvariants(sourceRepoRoot) {
  const skillsRoot = join(ROOT, "skills");
  if (!existsSync(skillsRoot)) {
    throw new Error("skills/ directory does not exist. Run sync-pstack.mjs first.");
  }
  const adapterText = readFileSync(join(ROOT, ADAPTER), "utf8");
  const { skills, classes } = classifySkills(skillsRoot);
  const problems = validateAdapterCoverage(classes, adapterText);

  for (const skill of skills) {
    const skillPath = join(skillsRoot, skill, "SKILL.md");
    const text = readFileSync(skillPath, "utf8");
    if (!new RegExp(`^---\\n[\\s\\S]*?^name: ${skill}$[\\s\\S]*?\\n---\\n`, "m").test(text)) {
      problems.push(`skills/${skill}/SKILL.md frontmatter name does not match '${skill}'`);
    }
    const { wrap } = classes.get(skill);
    if (wrap && !text.includes(ADAPTER_LINE)) {
      problems.push(`skills/${skill}/SKILL.md is missing the Pi adapter instruction line`);
    }
  }

  for (const agent of ["poteto-agent.md", "comment-sicko.md"]) {
    const agentPath = join(ROOT, "agents", agent);
    if (!existsSync(agentPath)) {
      problems.push(`Missing agents/${agent}`);
    }
  }

  if (sourceRepoRoot) {
    const { files, upstreamMeta } = renderFromUpstream(sourceRepoRoot);
    for (const [rel, want] of files) {
      const diskPath = join(ROOT, rel);
      if (!existsSync(diskPath)) {
        problems.push(`Missing generated file: ${rel}`);
        continue;
      }
      const have = readFileEntry(diskPath);
      if (!want.bytes.equals(have.bytes) || want.executable !== have.executable) {
        problems.push(`Drifted generated file: ${rel}`);
      }
    }
    const diskUpstream = JSON.parse(readFileSync(join(ROOT, "upstream.json"), "utf8"));
    if (diskUpstream.pstackTreeSha !== upstreamMeta.pstackTreeSha) {
      problems.push(
        `upstream.json pstackTreeSha (${diskUpstream.pstackTreeSha}) != source (${upstreamMeta.pstackTreeSha})`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  console.log(`pi-pstack check passed (${skills.length} skills, 2 agents).`);
}

function writeSyncedTree(sourceRepoRoot) {
  const { files, skills, classes, upstreamMeta } = renderFromUpstream(sourceRepoRoot);
  // The checked-out skills tree is the persistent inventory, including additions
  // shipped by earlier automatic syncs. Reject removals before any generated write.
  const skillsRoot = join(ROOT, "skills");
  const removed = existsSync(skillsRoot)
    ? readdirSync(skillsRoot).filter((name) =>
      existsSync(join(skillsRoot, name, "SKILL.md")) && !skills.includes(name))
    : [];
  if (removed.length > 0) {
    throw new Error(`Refusing upstream sync: would remove shipped skills: ${removed.join(", ")}. Review removals or renames as an explicit local change.`);
  }
  rmSync(join(ROOT, "skills"), { recursive: true, force: true });
  rmSync(join(ROOT, "agents"), { recursive: true, force: true });

  for (const [rel, { bytes, executable }] of files) {
    if (rel === ADAPTER) continue;
    const outPath = join(ROOT, rel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, bytes);
    chmodSync(outPath, executable ? 0o755 : 0o644);
  }

  writeFileSync(join(ROOT, "upstream.json"), `${JSON.stringify(upstreamMeta, null, 2)}\n`, "utf8");

  const pkgPath = join(ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.version !== upstreamMeta.version) {
    pkg.version = upstreamMeta.version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }

  const wrappedCount = [...classes.values()].filter(({ wrap }) => wrap).length;
  console.log(
    `Synced ${skills.length} skills (${wrappedCount} with Pi adapter line) and 2 agents from cursor/plugins@${upstreamMeta.pstackCommitSha.slice(0, 7)} (tree ${upstreamMeta.pstackTreeSha.slice(0, 7)}, v${upstreamMeta.version}).`,
  );
}

const args = process.argv.slice(2);
const isCheck = args.includes("--check");
const isFetch = args.includes("--fetch");
const explicitSource = args.find((arg) => !arg.startsWith("--"));

let tempCloneDir;
try {
  let sourceDir = explicitSource ? resolvePath(explicitSource) : undefined;
  if (!sourceDir && isFetch) {
    tempCloneDir = mkdtempSync(join(tmpdir(), "pi-pstack-upstream-"));
    execFileSync(
      "git",
      ["clone", "--depth", "50", `${GITHUB}.git`, tempCloneDir],
      { stdio: "inherit" },
    );
    sourceDir = tempCloneDir;
  }

  if (isCheck) {
    checkOnDiskInvariants(sourceDir);
  } else {
    if (!sourceDir) {
      console.error("Usage: node scripts/sync-pstack.mjs <cursor-plugins-dir> | --fetch | --check [cursor-plugins-dir]");
      process.exit(2);
    }
    writeSyncedTree(sourceDir);
  }
} finally {
  if (tempCloneDir) {
    rmSync(tempCloneDir, { recursive: true, force: true });
  }
}
