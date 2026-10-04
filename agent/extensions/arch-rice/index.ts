import os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { registerToolRails } from "./tool-rails.ts";

// Theme owns built-in surfaces; this extension owns only the footer.
export default function archRice(pi: ExtensionAPI) {
  let enabled = true;
  let restoreTheme = "thinking-spectrum";
  registerToolRails(pi, () => enabled);
  pi.registerMarkdownTransformer((markdown, context) => {
    if (!enabled || context.messageType !== "user") return markdown;
    // Hanging indent for ordinary prose, including explicit and soft line wraps.
    // Keep block Markdown intact rather than turning fences/lists into paragraphs.
    const anchor = "**❯**";
    if (/^(?: {0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|`{3}|~{3})| {4}|\t)/m.test(markdown)) {
      return anchor + "\n\n" + markdown;
    }
    const indent = 2; // Chevron + space.
    if (context.availableWidth <= indent + 1) return anchor + "\n\n" + markdown;
    return wrapTextWithAnsi(markdown, context.availableWidth - indent)
      .map((line, i) => (i === 0 ? anchor + " " : "\u200B" + "\u00A0".repeat(indent)) + line)
      .join("  \n");
  });

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      const clean = (s: string) => s.replace(/[\r\n\t]/g, " ");
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          if (width < 1) return [];
          const home = os.homedir();
          let cwd = clean(ctx.cwd === home ? "~" : ctx.cwd.startsWith(home + "/")
            ? "~" + ctx.cwd.slice(home.length) : ctx.cwd);
          const parts = cwd.split("/").filter(Boolean);
          if (parts.length > 2) cwd = "…/" + parts.slice(-2).join("/");
          const pathWidth = Math.min(40, width);
          const cwdWidth = visibleWidth(cwd);
          if (cwdWidth > pathWidth) {
            cwd = "…" + sliceByColumn(cwd, cwdWidth - pathWidth + 1, pathWidth - 1, true);
          }
          const branch = footerData.getGitBranch();
          const usage = ctx.getContextUsage();
          const percent = usage?.percent;
          const sep = theme.fg("accent", " · ");
          const session = ctx.sessionManager.getSessionName();
          const location = [theme.fg("accent", clean(cwd)), branch ? theme.fg("accent", clean(branch)) : "",
            session ? theme.fg("accent", clean(session)) : ""].filter(Boolean).join(sep);
          const model = theme.fg("accent", ctx.model?.id ?? "none");
          const effort = theme.fg("accent", pi.getThinkingLevel());
          const filled = percent == null ? 0 : Math.round(Math.max(0, Math.min(100, percent)) / 100 * 8);
          const gauge = theme.fg("accent", "▰".repeat(filled) + "▱".repeat(8 - filled));
          const engine = model + sep + effort + sep + gauge;
          // Append other extension statuses to the same single-line footer.
          const statuses = [...footerData.getExtensionStatuses().entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => theme.fg("accent", clean(text).replace(/\x1b\[[0-9;:]*m/g, "")));
          return [truncateToWidth([engine, location, ...statuses].filter(Boolean).join(sep), width)];
        },
      };
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const current = ctx.ui.theme.name;
    if (current && current !== "arch-ice") restoreTheme = current;
    if (enabled) install(ctx);
  });

  pi.registerCommand("rice", {
    description: "Blue Rails appearance: /rice on, off, or toggle",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const action = args.trim().toLowerCase() || "toggle";
      if (!["on", "off", "toggle"].includes(action)) {
        ctx.ui.notify("Usage: /rice [on|off|toggle]", "warning");
        return;
      }
      const next = action === "toggle" ? !enabled : action === "on";
      if (next) {
        if (ctx.ui.theme.name && ctx.ui.theme.name !== "arch-ice") restoreTheme = ctx.ui.theme.name;
        const result = ctx.ui.setTheme("arch-ice");
        if (!result.success) {
          ctx.ui.notify(result.error ?? "Could not load arch-ice theme", "error");
          return;
        }
        enabled = true;
        install(ctx);
      } else {
        enabled = false;
        ctx.ui.setFooter(undefined);
        if (ctx.ui.theme.name === "arch-ice") {
          const result = ctx.ui.setTheme(restoreTheme);
          if (!result.success) ctx.ui.notify(result.error ?? "Could not restore theme", "warning");
        }
      }
    },
  });
}
