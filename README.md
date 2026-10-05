# Pi configuration

Personal themes, extensions, and a web-research skill for [Pi](https://pi.dev).

## Contents

- `agent/extensions/arch-rice/` — custom footer, tool-call rails, and user-message formatting.
- `agent/extensions/remote-control/` — opt-in Pi-to-Pi messaging through your own Cloudflare Worker and SQLite Durable Object; see its `README.md` for deployment and security.
- `agent/skills/codex-web/` — public web research through an authenticated Codex CLI; see its `SKILL.md` for requirements and usage.
- `agent/themes/arch-ice.json` — muted Arch blue / ice palette.
- `agent/themes/thinking-spectrum.json` — colorful thinking-level palette.

## Installation

Install Pi separately. Copy the desired directories into `~/.pi/agent/`, preserving their layout. Back up existing files before replacing them. Review extensions before loading them: they execute with your user's permissions.

Run `/reload` in Pi, then select a theme using `/settings`. The Arch Rice extension supports `/rice on`, `/rice off`, and `/rice` to toggle its appearance. The renderer integration targets Pi 1.0.1.

The Codex web skill requires Python 3 and an authenticated `codex` CLI with access to the configured model and web search. It uses your existing Codex quota.

## Privacy

This repository intentionally tracks only the directories above and repository metadata. The allowlist `.gitignore` excludes authentication, sessions, personal settings, provider configuration, installed dependencies, and model caches. Do not force-add those files.

## License

MIT — see [LICENSE](LICENSE).
