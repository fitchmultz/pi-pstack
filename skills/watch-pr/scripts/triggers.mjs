// Decides from a workflow file whether GitHub starts that workflow when a commit
// is pushed to a pull request. Trigger and filter rules:
// https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#on

const PR_EVENTS = ["pull_request", "pull_request_target"];
// GitHub's default activity types for both pull request events.
const DEFAULT_TYPES = ["opened", "synchronize", "reopened"];
const FILTER_KEYS = ["branches-ignore", "paths", "paths-ignore"];
const GLOB = /[*?+[\]!]/;

class Unreadable extends Error {}

/**
 * Classifies one workflow file for a pull request into `baseRef`.
 *
 * - `always`: a push to the pull request starts it, so the head commit must have a run.
 * - `filtered`: a branch or path filter decides, so a missing run proves nothing.
 * - `never`: a push to this pull request does not start it.
 * - `unreadable`: the `on:` section uses YAML this reader does not support.
 *
 * `events` lists the pull request events that can start the workflow.
 *
 * @param {string} text Workflow file content.
 * @param {string} baseRef Pull request base branch.
 * @returns {{ kind: "always" | "filtered" | "never" | "unreadable", events: string[] }}
 */
export function classifyWorkflow(text, baseRef) {
  let on;
  try {
    on = readOn(text);
  } catch (error) {
    if (error instanceof Unreadable) return { kind: "unreadable", events: [] };
    throw error;
  }
  const events = [];
  let always = false;
  for (const event of PR_EVENTS) {
    if (!on.has(event)) continue;
    const filters = on.get(event) ?? {};
    if (!strings(filters.types, DEFAULT_TYPES).includes("synchronize")) continue;
    let filtered = FILTER_KEYS.some((key) => key in filters);
    if ("branches" in filters) {
      const branches = strings(filters.branches, []);
      if (!branches.includes(baseRef)) {
        if (!branches.some((branch) => GLOB.test(branch))) continue;
        filtered = true;
      }
    }
    events.push(event);
    if (!filtered) always = true;
  }
  return { kind: always ? "always" : events.length ? "filtered" : "never", events };
}

function strings(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((item) => typeof item === "string")) throw new Unreadable("filter is not a list of strings");
  return list;
}

function eventsOf(on) {
  if (typeof on === "string") return new Map([[on, null]]);
  if (Array.isArray(on)) return new Map(strings(on, []).map((event) => [event, null]));
  if (on === null) throw new Unreadable("empty on");
  return new Map(Object.entries(on).map(([event, filters]) => [event, filtersOf(event, filters)]));
}

function filtersOf(event, filters) {
  if (filters !== null && (typeof filters !== "object" || Array.isArray(filters))) {
    throw new Unreadable(`unexpected value for ${event}`);
  }
  return filters;
}

// The reader below covers the YAML that pull request triggers use: block and
// flow mappings and sequences, and plain or quoted scalars. Anchors, aliases,
// tags, block scalars and tabs raise Unreadable so the caller never guesses.
// Other events' settings are skipped, not parsed: they can hold any YAML.

const KEY = /^("[^"]*"|'[^']*'|[^\s:'"&*!|>{[-][^:]*?)\s*:(?:\s+(.*))?$/;
const isItem = (text) => /^-(\s|$)/.test(text);

function readOn(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trimEnd();
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (line.slice(0, indent).includes("\t")) throw new Unreadable("tab indentation");
    lines.push({ indent, text: line.slice(indent) });
  }
  const start = lines.findIndex(({ indent, text }) => indent === 0 && /^(?:on|"on"|'on')\s*:/.test(text));
  if (start === -1) throw new Unreadable("no on key");
  let end = start + 1;
  while (end < lines.length && (lines[end].indent > 0 || isItem(lines[end].text))) end++;
  const section = lines.slice(start, end);
  const rest = section[0].text.replace(/^[^:]*:/, "").trim();
  if (rest !== "" || section.length === 1 || isItem(section[1].text)) {
    const [value, next] = mappingValue(section, 0, rest);
    if (next !== section.length) throw new Unreadable("unexpected indentation");
    return eventsOf(value);
  }
  const events = new Map();
  const indent = section[1].indent;
  for (let index = 1; index < section.length;) {
    const entry = section[index].indent === indent ? KEY.exec(section[index].text) : null;
    if (!entry) throw new Unreadable(`unsupported line: ${section[index].text}`);
    const event = scalar(entry[1]);
    if (PR_EVENTS.includes(event)) {
      let value;
      [value, index] = mappingValue(section, index, (entry[2] ?? "").trim());
      events.set(event, filtersOf(event, value));
    } else {
      events.set(event, null);
      index++;
      while (index < section.length &&
        (section[index].indent > indent || (section[index].indent === indent && isItem(section[index].text)))) index++;
    }
  }
  return events;
}

function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

// Value of the mapping entry or sequence item on lines[at], whose text after
// the key or dash is `rest`. Returns [value, index of the next sibling line].
function mappingValue(lines, at, rest) {
  let next = at + 1;
  if (rest === "") {
    const child = lines[next];
    // YAML lets a sequence under a mapping key start at the key's own indentation.
    const nested = child !== undefined && (child.indent > lines[at].indent ||
      (child.indent === lines[at].indent && isItem(child.text) && !isItem(lines[at].text)));
    return nested ? block(lines, next) : [null, next];
  }
  if (rest[0] === "[" || rest[0] === "{") {
    // A flow collection may continue on the following lines.
    while (!balanced(rest) && next < lines.length) {
      rest += ` ${lines[next].text}`;
      next++;
    }
  }
  return [flow(rest), next];
}

function block(lines, at) {
  const indent = lines[at].indent;
  const sequence = isItem(lines[at].text);
  const result = sequence ? [] : {};
  let index = at;
  while (index < lines.length && lines[index].indent === indent) {
    const { text } = lines[index];
    let value;
    if (sequence) {
      if (!isItem(text)) break;
      [value, index] = mappingValue(lines, index, text.slice(1).trim());
      result.push(value);
    } else {
      const entry = KEY.exec(text);
      if (!entry) throw new Unreadable(`unsupported line: ${text}`);
      [value, index] = mappingValue(lines, index, (entry[2] ?? "").trim());
      result[scalar(entry[1])] = value;
    }
  }
  if (index < lines.length && lines[index].indent > indent) throw new Unreadable("unexpected indentation");
  return [result, index];
}

function balanced(text) {
  let depth = 0;
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
  }
  return depth === 0 && quote === null;
}

function flow(text) {
  let position = 0;
  const skip = () => {
    while (text[position] === " ") position++;
  };
  const token = (stops) => {
    skip();
    const start = position;
    const quote = text[position] === '"' || text[position] === "'" ? text[position] : null;
    if (quote) {
      position = text.indexOf(quote, start + 1) + 1;
      if (position === 0) throw new Unreadable("unterminated quote");
    } else {
      while (position < text.length && !stops.includes(text[position])) position++;
    }
    return scalar(text.slice(start, position).trim());
  };
  const value = (stops) => {
    skip();
    if (text[position] === "[") {
      position++;
      const items = [];
      for (skip(); text[position] !== "]"; skip()) {
        if (position >= text.length) throw new Unreadable("unterminated sequence");
        items.push(value(",]"));
        skip();
        if (text[position] === ",") position++;
      }
      position++;
      return items;
    }
    if (text[position] === "{") {
      position++;
      const entries = {};
      for (skip(); text[position] !== "}"; skip()) {
        if (position >= text.length) throw new Unreadable("unterminated mapping");
        const key = token(":,}");
        skip();
        if (text[position] === ":") {
          position++;
          entries[key] = value(",}");
        } else entries[key] = null;
        skip();
        if (text[position] === ",") position++;
      }
      position++;
      return entries;
    }
    return token(stops);
  };
  const result = value("");
  skip();
  if (position !== text.length) throw new Unreadable(`unsupported value: ${text}`);
  return result;
}

function scalar(text) {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) return text.slice(1, -1);
  if (/^[&*!|>'"%@`]|:(\s|$)|\s#/.test(text)) throw new Unreadable(`unsupported scalar: ${text}`);
  return text === "" || text === "~" || text === "null" ? null : text;
}
