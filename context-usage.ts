import type { PluginAPI, StatusItem } from '@ampcode/plugin'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const description =
	'Shows the active thread’s context window usage in the status bar, from `amp threads context`.'

const WARN_AT = 0.8
const TOOL_REFRESH_MS = 30_000
const DETAILS_COMMAND = 'context-usage-details'

interface ContextReport {
	totalTokens: number
	maxContextTokens: number
	compactionCount: number
	sections: { name: string; tokens: number }[]
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

export function formatSections(r: ContextReport): string {
	return r.sections.map((s) => `${s.name} ${formatTokens(s.tokens)}`).join(' · ')
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
	const experimental = amp.experimental
	if (!experimental) {
		amp.logger.log('context-usage: experimental APIs unavailable; status item disabled')
		return
	}

	let item: StatusItem | null = null
	let latestRequest = 0

	function show(text: string) {
		const value = { text, url: `command:${DETAILS_COMMAND}` }
		if (item) item.update(value)
		else item = experimental!.createStatusItem(value)
	}

	function hide() {
		item?.unsubscribe()
		item = null
	}

	async function readContext(threadID: string): Promise<ContextReport> {
		const { exitCode, stdout, stderr } = await amp.$`${AMP} threads context ${threadID}`
		if (exitCode !== 0) throw new Error(`amp threads context exited ${exitCode}: ${stderr.trim()}`)
		return JSON.parse(stdout) as ContextReport
	}

	async function refresh(threadID: string): Promise<ContextReport | null> {
		const request = ++latestRequest
		try {
			const report = await readContext(threadID)
			// Drop results for threads the user has since left, or superseded by a newer refresh.
			if (request === latestRequest && amp.activeThread.current?.id === threadID) {
				show(formatLabel(report))
			}
			return report
		} catch (error) {
			amp.logger.log(`context-usage: refresh failed for ${threadID}: ${String(error)}`)
			if (request === latestRequest) hide()
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
		return `Cache: ${pct}% of input read from cache (${formatTokens(share.cacheReads)} / ${formatTokens(share.input)}, ${scope})`
	}

	amp.activeThread.subscribe((thread) => {
		if (thread) void refresh(thread.id)
		else {
			latestRequest++
			hide()
		}
	})

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
			const threadID = ctx.thread.id
			const [report, cache] = await Promise.all([refresh(threadID), cacheLine(threadID)])
			if (!report) return void (await ctx.ui.notify('Context usage is unavailable for this thread.'))
			const lines = [formatLabel(report), formatSections(report)]
			if (cache) lines.push(cache)
			await ctx.ui.notify(lines.join('\n'))
		},
	)

	amp.on('agent.end', (event) => {
		if (amp.activeThread.current?.id === event.thread.id) void refresh(event.thread.id)
	})

	// Long turns make many tool calls; refresh mid-turn, but at most every 30s.
	let lastToolRefresh = 0
	amp.on('tool.result', (event) => {
		if (amp.activeThread.current?.id !== event.thread.id) return
		const now = Date.now()
		if (now - lastToolRefresh < TOOL_REFRESH_MS) return
		lastToolRefresh = now
		void refresh(event.thread.id)
	})
}
