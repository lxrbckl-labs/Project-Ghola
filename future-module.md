TorchView — Agent-Controlled Browser Tab for VS Code
A VS Code extension that embeds a real Chromium instance as an editor tab and
exposes it to AI agents (Claude Code, Copilot, anything that speaks MCP) as a
controllable browser. You see the page, the agent sees the page, you both work
on the same session.
Working name picks up from your existing TorchPass project for naming
consistency. Rename if it doesn't fit.

The Goal
One sentence: an editor tab that is a real browser, and an agent that can
drive that browser from the same VS Code window.
Why this is worth building rather than using Playwright MCP with a windowed
browser:

The browser lives in your editor tab strip, not your taskbar
Same authentication session for you and the agent — log in once, both use it
The agent can "see what you're seeing" because it literally is what you're
seeing
Workflow handoff: you click around, hand the session to the agent, it
continues from where you left off

Why this is worth building rather than the VS Code integrated browser plus
Copilot agent tools:

Works with Claude Code (and any MCP client), not just Copilot
Real Chromium with extensions, real auth flows, full Chrome compatibility
No org-level policy gates — you own the setting surface
Open and extendable, not a black box