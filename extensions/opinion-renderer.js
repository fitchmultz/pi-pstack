import { getMarkdownTheme, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, MouseRegion, TruncatedText, truncateToWidth } from "@earendil-works/pi-tui";

// Pi 1.5.0 tool-execution.ts: FALLBACK_PREVIEW_LINES; the fork's compact view keeps two rows.
const PREVIEW_LINES = 10;

export function registerOpinionRenderer(pi) {
  let ui;
  pi.on("session_start", (_event, ctx) => {
    ui = ctx.mode === "tui" ? ctx.ui : undefined;
  });
  pi.on("session_shutdown", () => {
    ui = undefined;
  });
  pi.registerMessageRenderer("pstack-opinion", (message, options, theme) => {
    const { expanded, outputPad, compactView = false } = options;
    const compact = compactView && !expanded;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    const outcome = message.details?.isError
      ? theme.fg("error", "failed")
      : theme.fg("success", "completed");
    const hint = options.keyHint("app.tools.expand", expanded ? "to collapse" : "to expand");
    const label = `${theme.fg("customMessageLabel", theme.bold("Pstack opinion"))} ${outcome} · ${hint}`;
    const box = new Box(outputPad, compact ? 0 : 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(new TruncatedText(label, 0, 0));
    const markdown = new Markdown(text, 0, 0, getMarkdownTheme(), {
      color: (line) => theme.fg("customMessageText", line),
    });
    let cache;
    box.addChild(
      expanded
        ? markdown
        : {
            render(width) {
              if (cache?.width !== width) {
                const { visualLines, skippedCount } = truncateToVisualLines(
                  markdown.render(width).join("\n"),
                  compact ? 1 : PREVIEW_LINES,
                  width,
                  0,
                  "start",
                );
                const lines = [...visualLines];
                if (skippedCount > 0 && !compact) {
                  lines.push(
                    truncateToWidth(
                      `${hint} · ${theme.fg("dim", `${skippedCount} more lines`)}`,
                      width,
                    ),
                  );
                }
                cache = { width, lines };
              }
              return cache.lines;
            },
            invalidate() {
              cache = undefined;
              markdown.invalidate();
            },
          },
    );
    return new MouseRegion(box, (event) => {
      if (!ui || event.type !== "click" || event.button !== "left") return;
      ui.setToolsExpanded(!expanded);
      return { handled: true };
    });
  });
}
