---
name: enable-calendar
description: Turn on pr-dashboard's calendar row - check the Google Calendar connector is connected and allow its list_events tool so the mod can read today's meetings in the background. Use when the user asks to enable, set up or fix the pr-dashboard calendar.
---

# Enable the pr-dashboard calendar

The band's calendar row reads today's meetings from the Google Calendar connector's `list_events` tool. The mod calls it in the background, so in auto mode the call needs an allow rule; without one it is refused and the row stays hidden.

1. Find the connector's tool among your tools: an MCP tool named `mcp__<id>__list_events` whose description mentions a calendar. If there is none, the connector is not connected: suggest connecting Google Calendar (claude.ai connectors, then `/mcp` to sign in) and stop.
2. Tell the user the exact rule you will add, `mcp__<id>__list_events`, and that it lets any session read their calendar without asking. Add it only once they agree.
3. Add the rule to `permissions.allow` in `~/.claude/settings.json`. Keep every other setting; don't add it twice.
4. Tell the user to run `/reload-plugins`. The row appears within a few seconds when meetings are left today.

Only `list_events` is needed. Never allow the connector's tools that write (create, update, delete or respond to events).
