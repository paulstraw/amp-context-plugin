import type { PluginAPI, PluginThread, QuickAction } from '@ampcode/plugin'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const description =
	'Shows each thread’s context window usage as a button above the composer, from `amp threads context`.'

const WARN_AT = 0.8
const TOOL_REFRESH_MS = 30_000
const DETAILS_COMMAND = 'context-usage-details'

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

// The Mac app's toast shows about three lines, so keep section names short.
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

	// When each thread's latest turn started, for the per-turn cache line. In memory only, so
	// threads whose turn started before the plugin loaded fall back to lifetime totals.
	const turnStarts = new Map<string, Date>()

	async function cacheLine(threadID: string): Promise<string | null> {
		const start = turnStarts.get(threadID)
		// --start requires --end; leave headroom for requests still landing.
		const end = new Date(Date.now() + 60_000).toISOString()
		const { exitCode, stdout } = start
			? await amp.$`${AMP} threads usage ${threadID} --details --start ${start.toISOString()} --end ${end}`
			: await amp.$`${AMP} threads usage ${threadID} --details`
		const share = exitCode === 0 ? parseCacheShare(stdout) : null
		if (!share) return null
		const pct = Math.round((share.cacheReads / share.input) * 100)
		const scope = start ? 'latest turn' : 'lifetime'
		return `Cache ${pct}% hit, ${scope} (${formatTokens(share.cacheReads)} / ${formatTokens(share.input)})`
	}

	amp.on('session.start', (_event, ctx) => void refresh(ctx.thread))

	amp.on('agent.start', (event) => {
		turnStarts.set(event.thread.id, new Date())
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
			// The button already shows the total; the toast only has room for the details.
			const lines = [formatSections(report)]
			if (cache) lines.push(cache)
			await ctx.ui.notify(lines.join('\n'))
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
