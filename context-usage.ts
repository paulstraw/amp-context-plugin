import type { PluginAPI, PluginThread, QuickAction } from '@ampcode/plugin'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const description =
	'Shows each thread’s context window usage as a button above the composer, from `amp threads context`.'

const WARN_AT = 0.8
const TOOL_REFRESH_MS = 30_000
const DETAILS_COMMAND = 'context-usage-details'
const MAX_SAVED_TURN_STARTS = 200

interface ContextReport {
	totalTokens: number
	maxContextTokens: number
	compactionCount: number
	sections: { id: string; name: string; tokens: number }[]
}

// Plugins launched by the desktop app may not inherit the shell PATH.
const AMP = Bun.which('amp') ?? join(homedir(), '.local/bin/amp')

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`
	return String(n)
}

export function formatLabel(r: ContextReport): string {
	const ratio = r.totalTokens / r.maxContextTokens
	const label = `ctx ${formatTokens(r.totalTokens)} / ${formatTokens(r.maxContextTokens)} (${Math.round(ratio * 100)}%)`
	const compacted = r.compactionCount > 0 ? ` · ${r.compactionCount}×` : ''
	return `${ratio >= WARN_AT ? '⚠ ' : ''}${label}${compacted}`
}

// Short section names keep the breakdown on one line.
const SHORT_SECTION_NAMES: Record<string, string> = {
	'system-prompt': 'System',
	'builtin-tools': 'Tools',
	'mcp-tools': 'MCP',
	'loaded-skills': 'Skills',
	messages: 'Messages',
}

export function formatSections(r: ContextReport): string {
	return r.sections
		.map((s) => `${SHORT_SECTION_NAMES[s.id] ?? s.name} ${formatTokens(s.tokens)}`)
		.join(' · ')
}

/**
 * Parses the cache share from `amp threads usage --details`, which only prints Markdown,
 * e.g. "Input tokens: 808,103 (760,444 cache reads)". Returns null when the line is missing.
 */
export function parseCacheShare(usageMarkdown: string): { input: number; cacheReads: number } | null {
	const match = usageMarkdown.match(/^Input tokens: ([\d,]+)(?: \(([\d,]+) cache reads\))?/m)
	if (!match) return null
	const input = Number(match[1].replaceAll(',', ''))
	const cacheReads = match[2] ? Number(match[2].replaceAll(',', '')) : 0
	return input > 0 ? { input, cacheReads } : null
}

export default function (amp: PluginAPI) {
	// One button per thread. The Mac app doesn't render status items and reports no active
	// thread, so each thread gets its own quick action instead.
	const buttons = new Map<string, QuickAction>()
	const latestRequest = new Map<string, number>()

	async function readContext(threadID: string): Promise<ContextReport> {
		const { exitCode, stdout, stderr } = await amp.$`${AMP} threads context ${threadID}`
		if (exitCode !== 0) throw new Error(`amp threads context exited ${exitCode}: ${stderr.trim()}`)
		return JSON.parse(stdout) as ContextReport
	}

	async function refresh(thread: PluginThread): Promise<ContextReport | null> {
		const request = (latestRequest.get(thread.id) ?? 0) + 1
		latestRequest.set(thread.id, request)
		try {
			const report = await readContext(thread.id)
			// Drop results superseded by a newer refresh of the same thread.
			if (latestRequest.get(thread.id) === request) {
				const definition = {
					text: formatLabel(report),
					icon: 'activity',
					action: 'run-command',
					args: { command: DETAILS_COMMAND },
				} as const
				const button = buttons.get(thread.id)
				if (button) button.update(definition)
				else buttons.set(thread.id, thread.createQuickAction(definition))
			}
			return report
		} catch (error) {
			amp.logger.log(`context-usage: refresh failed for ${thread.id}: ${String(error)}`)
			if (latestRequest.get(thread.id) === request) {
				buttons.get(thread.id)?.unsubscribe()
				buttons.delete(thread.id)
			}
			return null
		}
	}

	// When each thread's latest turn started, as seen at agent.start. Thread messages carry no
	// timestamps, so this is the only source; it is saved to disk to survive plugin reloads.
	const turnStartsFile = join(amp.system.cacheDirectory, 'turn-starts.json')
	const turnStarts = new Map<string, string>()
	try {
		for (const [id, at] of Object.entries(JSON.parse(readFileSync(turnStartsFile, 'utf8')))) {
			if (typeof at === 'string') turnStarts.set(id, at)
		}
	} catch {
		// No saved turn starts yet.
	}

	function recordTurnStart(threadID: string) {
		turnStarts.delete(threadID)
		turnStarts.set(threadID, new Date().toISOString())
		// Keep the most recently started threads only.
		for (const id of [...turnStarts.keys()].slice(0, -MAX_SAVED_TURN_STARTS)) turnStarts.delete(id)
		try {
			mkdirSync(amp.system.cacheDirectory, { recursive: true })
			writeFileSync(turnStartsFile, JSON.stringify(Object.fromEntries(turnStarts)))
		} catch (error) {
			amp.logger.log(`context-usage: saving turn starts failed: ${String(error)}`)
		}
	}

	async function cacheLine(threadID: string): Promise<string | null> {
		const start = turnStarts.get(threadID)
		if (!start) return null
		// --start requires --end; leave headroom for requests still landing.
		const end = new Date(Date.now() + 60_000).toISOString()
		const { exitCode, stdout } =
			await amp.$`${AMP} threads usage ${threadID} --details --start ${start} --end ${end}`
		const share = exitCode === 0 ? parseCacheShare(stdout) : null
		if (!share) return null
		const pct = Math.round((share.cacheReads / share.input) * 100)
		return `Cache ${pct}% hit, latest turn (${formatTokens(share.cacheReads)} / ${formatTokens(share.input)})`
	}

	amp.on('session.start', (_event, ctx) => void refresh(ctx.thread))

	amp.on('agent.start', (event) => {
		recordTurnStart(event.thread.id)
		return {}
	})

	amp.registerCommand(
		DETAILS_COMMAND,
		{
			title: 'Show context details',
			category: 'context-usage',
			description: 'Refresh context usage and show its breakdown and last-turn cache share.',
		},
		async (ctx) => {
			if (!ctx.thread) return void (await ctx.ui.notify('No active thread.'))
			const [report, cache] = await Promise.all([refresh(ctx.thread), cacheLine(ctx.thread.id)])
			if (!report) return void (await ctx.ui.notify('Context usage is unavailable for this thread.'))
			// A dialog rather than a toast, which disappears too quickly to read.
			const lines = [formatSections(report)]
			if (cache) lines.push(cache)
			await ctx.ui.confirm({
				title: formatLabel(report),
				message: lines.join('\n\n'),
				confirmButtonText: 'Close',
				skipIfUnwatched: true,
			})
		},
	)

	amp.on('agent.end', (_event, ctx) => void refresh(ctx.thread))

	// Long turns make many tool calls; refresh mid-turn, but at most every 30s per thread.
	const lastToolRefresh = new Map<string, number>()
	amp.on('tool.result', (event, ctx) => {
		const now = Date.now()
		if (now - (lastToolRefresh.get(event.thread.id) ?? 0) < TOOL_REFRESH_MS) return
		lastToolRefresh.set(event.thread.id, now)
		void refresh(ctx.thread)
	})
}
