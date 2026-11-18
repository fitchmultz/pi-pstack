import { getMarkdownTheme, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Markdown,
  TruncatedText,
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";

const PREVIEW_LINES = 5;
const UNSAFE_MARKDOWN_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function sanitizeOpinionMarkdown(text) {
  return stripTerminalSequences(text).replace(UNSAFE_MARKDOWN_CONTROLS, "");
}

export function registerOpinionRenderer(pi) {
  pi.registerMessageRenderer("pstack-opinion", (message, options, theme) => {
    const { expanded, outputPad } = options;
    const rawText =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    const text = sanitizeOpinionMarkdown(rawText);
    const outcome = message.details?.isError
      ? theme.fg("error", "failed")
      : theme.fg("success", "completed");
    const label = `${theme.fg("customMessageLabel", theme.bold("Pstack opinion"))} ${outcome}`;
    const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
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
                  PREVIEW_LINES,
                  width,
                  0,
                  "start",
                );
                const lines = [...visualLines];
                if (skippedCount > 0) {
                  const hint = options.keyHint("app.tools.expand", "to expand");
                  lines.push(
                    truncateToWidth(
                      `${hint} ${theme.fg("muted", `(${skippedCount} more lines)`)}`,
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
    return box;
  });
}
