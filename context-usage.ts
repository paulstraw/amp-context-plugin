import type { PluginAPI, StatusItem } from '@ampcode/plugin'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const description =
	'Shows the active thread’s context window usage in the status bar, from `amp threads context`.'

const WARN_AT = 0.8

interface ContextReport {
	totalTokens: number
	maxContextTokens: number
	compactionCount: number
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

export default function (amp: PluginAPI) {
	const experimental = amp.experimental
	if (!experimental) {
		amp.logger.log('context-usage: experimental APIs unavailable; status item disabled')
		return
	}

	let item: StatusItem | null = null
	let latestRequest = 0

	function show(text: string) {
		if (item) item.update({ text })
		else item = experimental!.createStatusItem({ text })
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

	async function refresh(threadID: string) {
		const request = ++latestRequest
		try {
			const report = await readContext(threadID)
			// Drop results for threads the user has since left, or superseded by a newer refresh.
			if (request !== latestRequest || amp.activeThread.current?.id !== threadID) return
			show(formatLabel(report))
		} catch (error) {
			amp.logger.log(`context-usage: refresh failed for ${threadID}: ${String(error)}`)
			if (request === latestRequest) hide()
		}
	}

	amp.activeThread.subscribe((thread) => {
		if (thread) void refresh(thread.id)
		else {
			latestRequest++
			hide()
		}
	})

	amp.on('agent.end', (event) => {
		if (amp.activeThread.current?.id === event.thread.id) void refresh(event.thread.id)
	})
}
