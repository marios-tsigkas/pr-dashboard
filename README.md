# pr-dashboard

A Claude Code mod that shows, above the prompt, your GitHub PRs for the session's repo and your uncommitted changes.

- **PRs:** review requests, your PRs, assigned, approved, changes requested and failing CI, each a link. Refreshed every 15 minutes, or with ↻.
- **New:** review requests, approvals, merges and comments since you last looked. Click one to open it, × to clear it.
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

## Develop

```bash
claude plugin validate .
claude plugin test .
```
