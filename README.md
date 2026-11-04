# amp-context-plugin

An Amp plugin that shows the active thread's context window usage in the desktop app's status bar, e.g. `ctx 68k / 872k (8%)`. Works for Claude Code threads.

- Reads `amp threads context <thread>` and refreshes at the end of each turn, after tool results (at most every 30s), and when you switch threads.
- Prefixes `⚠` at 80% and appends `· N×` after compactions.
- Click it (or run **context-usage: Show context details** from ⌘K) for the per-section breakdown and the cache-read share of the latest turn, parsed from `amp threads usage --details`.

Uses the experimental `createStatusItem` API, so it may break with Amp updates.

## Install

```sh
mkdir -p ~/.config/amp/plugins
ln -s "$PWD/context-usage.ts" ~/.config/amp/plugins/context-usage.ts
```

Then run **plugins: reload** from the command palette (⌘K).
