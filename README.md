# pr-dashboard

A Claude Code mod that shows, above the prompt, your GitHub PRs for the session's repo and your uncommitted changes.

- **PRs:** review requests, your PRs, assigned, approved, changes requested and failing CI, each a link. Refreshed every 15 minutes, or with ↻.
- **New:** review requests, approvals, merges and comments since you last looked. Click one to open it, × to clear it.
- **Calendar:** today's next meetings (up to three, then "+N more"), each with its video link (↗), the next one amber within 15 minutes. Refreshed every 5 minutes. Needs the Google Calendar connector; see [Calendar](#calendar).
- **Links:** Asana (☑), Figma (🎨), Confluence (📘) and Claude artifact (✳️) links from this chat and from the branch PR's description, newest first.
- **Uncommitted:** changed files with +/− lines. Click a file, ⧉ or `/changes` for a side pane with each file's diff.

## Install

Needs Claude Code 2.1.299 or later (`claude --version`; `claude update` to upgrade). Older versions install it but it fails to load or draws nothing.

Type at a Claude Code terminal prompt:

```
/plugin install pr-dashboard --marketplace marios-tsigkas/pr-dashboard
```

Answer `y` to add the marketplace, then pick a scope (user is first). Or from a shell:

```bash
claude plugin marketplace add marios-tsigkas/pr-dashboard
claude plugin install pr-dashboard@marios-tsigkas
```

It needs the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`) and `git`.

## Calendar

1. In claude.ai, go to **Settings → Connectors**, add **Google Calendar** and sign in with your Google account.
2. In Claude Code, type `/mcp` and check Google Calendar is listed; sign in there if it asks.
3. Ask Claude to enable it: type `/pr-dashboard:enable-calendar`. It finds your connector and, once you agree, adds its read-only `list_events` tool to `permissions.allow` in `~/.claude/settings.json`. The mod reads the calendar in the background, so in auto mode the call is refused without that rule.
4. Run `/reload-plugins`.

Without the connector, or when it fails, the row stays hidden. All-day, cancelled and declined events are left out.

## Develop

```bash
claude plugin validate .
claude plugin test .
```
