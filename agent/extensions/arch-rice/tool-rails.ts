import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { mixColors, truncateToWidth } from "@earendil-works/pi-tui";

// Preserve original renderers and their per-call component state.
const children = new WeakMap<Component, Component>();
function unwrap(component: Component | undefined): Component | undefined {
  return component ? children.get(component) ?? component : undefined;
}

type Frame = {
  rail: (text: string) => string;
  start?: boolean;
  marker?: string | (() => string);
  finish?: string;
  running?: () => string;
};

function framed(child: Component, frame: Frame): Component {
  const leftPadding = " "; // Match the standard transcript's one-cell inset.
  const inset = leftPadding.length + 2;
  const wrapper: Component = {
    invalidate() { child.invalidate(); },
    render(width) {
      if (width < 1) return [];
      const raw = child.render(Math.max(1, width - inset));
      // Renderer leading/trailing blank rows become rail spacing, not empty bands.
      const isBlank = (line: string) => !line.replace(/\x1b\[[0-9;:]*m/g, "").trim();
      let start = 0;
      let end = raw.length;
      while (start < end && isBlank(raw[start])) start++;
      while (end > start && isBlank(raw[end - 1])) end--;
      const lines = raw.slice(start, end);
      let firstContent = true;
      const output = lines.map(line => {
        if (isBlank(line)) return frame.rail("│");
        const marker = typeof frame.marker === "function" ? frame.marker() : frame.marker;
        const prefix = firstContent ? (frame.start ? frame.rail("┌") : marker ?? frame.rail("│")) : frame.rail("│");
        firstContent = false;
        return truncateToWidth(prefix + " " + line, width);
      });
      if (frame.running) output.push(frame.rail("│"), frame.running());
      if (frame.finish) output.push(frame.rail("└") + " " + frame.finish);
      return output.map(line => truncateToWidth(leftPadding + line, width));
    },
    handleInput: child.handleInput ? data => child.handleInput!(data) : undefined,
    handleMouse: child.handleMouse ? event => {
      if (event.x < inset) return undefined;
      return child.handleMouse!({ ...event, x: event.x - inset, width: Math.max(1, event.width - inset) });
    } : undefined,
  };
  children.set(wrapper, child);
  return wrapper;
}

export function registerToolRails(pi: ExtensionAPI, isEnabled: () => boolean) {
  // Installing a new release does not upgrade the API of an already-running process.
  if (typeof pi.registerToolRenderer !== "function") return;

  // One clock for all live tools, never for replayed history or HTML exports.
  let tuiSession = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const active = new Map<string, (() => void) | undefined>();
  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }
  function reset() {
    stopTimer();
    active.clear();
  }
  pi.on("session_start", (_event, ctx) => {
    reset();
    tuiSession = ctx.mode === "tui";
  });
  pi.on("tool_execution_start", event => {
    if (tuiSession) active.set(event.toolCallId, undefined);
  });
  pi.on("tool_execution_end", event => {
    active.delete(event.toolCallId);
    if (!active.size) stopTimer();
  });
  pi.on("agent_settled", reset);
  pi.on("session_shutdown", () => { tuiSession = false; reset(); });

  function animate(toolCallId: string, invalidate: () => void): boolean {
    if (!tuiSession || !isEnabled() || !active.has(toolCallId)) return false;
    active.set(toolCallId, invalidate);
    if (!timer) {
      timer = setInterval(() => {
        if (!isEnabled()) { stopTimer(); return; }
        for (const redraw of [...active.values()]) redraw?.();
      }, 100);
      timer.unref?.();
    }
    return true;
  }

  pi.registerToolRenderer((name, next) => {
    const base = next();
    // Built-in edit is self-framed (its preview lives in the call component).
    // Decorate it too; leave unrelated custom self-framed tools alone.
    if (!isEnabled() || !base || (base.renderShell === "self" && name !== "edit") || !base.renderCall || !base.renderResult) return base;
    return {
      ...base,
      renderShell: "self",
      renderCall(args, theme, context) {
        const child = base.renderCall!(args, theme, { ...context, lastComponent: unwrap(context.lastComponent) });
        const pulsing = context.isPartial && animate(context.toolCallId, context.invalidate);
        const dot = () => {
          if (!pulsing || !isEnabled() || !active.has(context.toolCallId)) return theme.fg("accent", "•");
          const brightness = (1 - Math.cos(Date.now() * 2 * Math.PI / 1500)) / 2;
          return theme.style("•", { fg: mixColors(theme.colors.dim, theme.colors.accent, brightness) });
        };
        return framed(child, {
          rail: text => theme.fg("dim", text),
          start: true,
          running: context.isPartial ? () => dot() + theme.fg("muted", " running") : undefined,
        });
      },
      renderResult(result, options, theme, context) {
        const child = base.renderResult!(result, options, theme, { ...context, lastComponent: unwrap(context.lastComponent) });
        const details = result.details as { truncation?: { truncated?: boolean }; warning?: unknown; warnings?: unknown[] } | undefined;
        const warning = details?.truncation?.truncated === true || Boolean(details?.warning)
          || (Array.isArray(details?.warnings) && details.warnings.length > 0);
        const partial = options.isPartial;
        const color = context.isError ? "error" : warning ? "warning" : partial ? "accent" : "success";
        const pulsing = partial && !context.isError && !warning && animate(context.toolCallId, context.invalidate);
        const marker = theme.fg(color, context.isError ? "×" : warning ? "▲" : "•");
        const liveMarker = () => {
          if (!pulsing || !isEnabled() || !active.has(context.toolCallId)) return marker;
          const brightness = (1 - Math.cos(Date.now() * 2 * Math.PI / 1500)) / 2;
          return theme.style("•", { fg: mixColors(theme.colors.dim, theme.colors.accent, brightness) });
        };
        const label = context.isError ? "failed" : warning ? "done · warning" : "done";
        return framed(child, {
          rail: text => theme.fg("dim", text),
          marker: pulsing ? liveMarker : marker,
          finish: partial ? undefined : marker + " " + theme.fg("muted", label),
        });
      },
    };
  });
}
