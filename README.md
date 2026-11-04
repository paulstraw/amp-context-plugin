# amp-context-plugin

An Amp plugin that shows each thread's context window usage as a button above the composer, e.g. `ctx 68k / 872k (8%)`. Works for Claude Code threads in the macOS app.

- Reads `amp threads context <thread>` and refreshes when a thread session starts, at the end of each turn, and after tool results (at most every 30s per thread).
- Prefixes `⚠` at 80% and appends `· N×` after compactions.
- Click the button (or run **context-usage: Show context details** from ⌘K) to open a dialog with the per-section breakdown and the cache-read share of the latest turn, parsed from `amp threads usage --details`. The cache line needs the plugin to have seen the turn start; those times are saved under `~/.cache/amp/plugin-cache/`, so they survive reloads.

## Install

```sh
mkdir -p ~/.config/amp/plugins
ln -s "$PWD/context-usage.ts" ~/.config/amp/plugins/context-usage.ts
```

Then run **plugins: reload** from the command palette (⌘K).
