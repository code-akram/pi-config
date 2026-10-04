# Blue Rails / Arch Ice

Personal Pi TUI rice backed by `~/.pi/agent/themes/arch-ice.json`.

## Footer

One left-aligned row, all in the active theme's accent blue:
- model ID, reasoning level, eight-cell context gauge
- cwd, git branch, optional session name

The cwd keeps its last two directory components, with `…/` replacing earlier parents. Home is abbreviated to `~`. Paths are capped at 40 terminal columns (or the terminal width if narrower), truncating from the left to preserve the end.

Single-space dot separators. No provider, context numbers, telemetry row, READY/RUN label, or extra horizontal rule. Other extension statuses are preserved and recolored blue.

## Transcript

User, custom-message, and tool background fills use the terminal default (no colored bands). User text is blue; assistant prose stays unboxed. `tool-rails.ts` decorates existing default-framed tool renderers with muted connected rails, ┌/└ endpoints, blue progress dots, orange warning triangles, red error markers, and green success dots. Warnings use explicit warning/truncation metadata, not output-text guessing. Running `•` markers gently pulse from dim to accent blue and back over 1.5 seconds, without changing shape. Completed, warning, and error markers remain solid. One shared 100 ms redraw timer runs only for live, decorated TUI tool calls; it stops after the last tool finishes, when disabled, or on session cleanup. History and HTML exports stay static. Tools and their execution are unchanged. Existing renderer state, content, diffs, expansion and input/mouse handlers are delegated. Pi retains its separate inline-image rendering. Rendererless tools and specialized self-framed tools are left alone. No native user-message rail: Pi has no public replacement hook for that component.

## Controls

- `/rice off`: default footer and previous theme (initial fallback: thinking-spectrum); disables rail decoration for subsequently resolved renderers.
- `/rice on`: Arch Ice palette + Blue Rails footer; enables rail decoration.
- `/rice`: toggle.
- Runtime toggles are not persisted; reload starts with the custom footer enabled.
- Existing tool renderer instances may require `/reload` to change their framing.
- `/settings` selects themes independently. Footer/rails use the active theme.

Tested against Pi 1.0.1 renderer API. No processes, custom editor, installation patches, or transcript/context mutation. The only timer is the live tool-marker pulse. Pi themes do not set the terminal's overall canvas or font. Set terminal background to `#0B1018` separately if desired; this extension does not change terminal configuration.
