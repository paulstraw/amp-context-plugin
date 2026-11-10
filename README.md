# amp-context-plugin

An [Amp](https://ampcode.com) plugin that shows each thread's context window usage as a button above the composer, e.g. `ctx 68k / 872k (8%)`. Works in the macOS app, including for Claude Code threads.

- Reads `amp threads context <thread>` and refreshes when a thread session starts, at the end of each turn, and after tool results (at most every 30s per thread).
- Prefixes `⚠` at 80% and appends `· N×` after compactions.
- Click the button (or run **context-usage: Show context details** from ⌘K) to open a dialog with the per-section breakdown and the cache-read share of the latest turn, parsed from `amp threads usage --details`. The cache line needs the plugin to have seen the turn start; those times are saved under `~/.cache/amp/plugin-cache/`, so they survive reloads.

## Requirements

- The `amp` CLI, on your `PATH` or at `~/.local/bin/amp`. The plugin shells out to it.
- No other dependencies: Amp runs plugins with Bun, and this is a single file.

## Install

Clone the repo and symlink the plugin into your system plugins directory, so `git pull` updates it:

```sh
git clone https://github.com/paulstraw/amp-context-plugin.git
cd amp-context-plugin
mkdir -p ~/.config/amp/plugins
ln -s "$PWD/context-usage.ts" ~/.config/amp/plugins/context-usage.ts
```

Or download just the file:

```sh
mkdir -p ~/.config/amp/plugins
curl -fsSL https://raw.githubusercontent.com/paulstraw/amp-context-plugin/main/context-usage.ts \
  -o ~/.config/amp/plugins/context-usage.ts
```

Then run **plugins: reload** from the command palette (⌘K).

To uninstall, delete `~/.config/amp/plugins/context-usage.ts` and reload plugins.

## License

[MIT](LICENSE)
