/**
 * md-log — mirror the session to a markdown file for comfortable reading.
 *
 * Designed for long teaching/learning sessions where the terminal is hard on
 * the eyes and markdown/math/code don't render. The linked .md file is meant to
 * be viewed rendered (e.g. in Obsidian), so assistant text with $...$ math,
 * code blocks, and markdown all render natively — no rendering work here.
 *
 * Captures only reading-relevant content:
 *   - user prompts
 *   - assistant text (lesson prose)
 *   - quiz / ask_user_question results
 * Other tools are omitted.
 *
 * Commands:
 *   /md-log <filepath>  — link a markdown file and backfill the session
 *   /md-unlog           — stop logging
 *
 * Notes on the DSH API this relies on:
 *   - `session/event` is observe-only, synchronous and fire-and-forget. The
 *     listener receives `(session, event)`, where `event` is the frozen durable
 *     event. A returned promise is not awaited, so file I/O is queued per
 *     session rather than awaited in the listener.
 *   - `tool/result` does NOT carry the tool name. It carries
 *     `event.data.message.toolCallId`, which is resolved against the
 *     `tool/call` events (`data.callId` -> `data.name`) seen on the same stream.
 *   - Backfill reads `session.deriveMessages()` — the supported, surface-
 *     projected history. `eventAt` / `snapshotEvents` / `ownEvents` / `log` are
 *     deprecated for new code.
 *
 * Difference from the pi original: the pi version persisted the link as a
 * custom session entry and restored it on session start. A DSH plugin cannot
 * mint durable session event types, so the link lives for the lifetime of the
 * session and must be re-issued after a restart.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Tools whose result is worth mirroring into the log. */
const QA_TOOLS = new Set(['quiz', 'ask_user_question'])

/**
 * Extract plain text from a message whose `content` may be a string or an
 * array of content blocks.
 * @param message - a session message.
 * @returns the concatenated text blocks.
 */
function messageText(message) {
	const content = message?.content
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	return content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n')
}

/** Build an Obsidian callout, quoting each body line. */
function callout(type, title, bodyLines) {
	const lines = [`> [!${type}] ${title}`]
	for (const line of bodyLines) lines.push(line.length === 0 ? '>' : `> ${line}`)
	return lines.join('\n')
}

/**
 * Replace injected `<skill …>…</skill>` declarations with a compact note, so
 * the log keeps the signal without the whole skill body.
 * @param text - already-trimmed message text.
 * @returns the text with skill blocks collapsed.
 */
function stripSkillBlocks(text) {
	return text.replace(/<skill\b([^>]*)>[\s\S]*?<\/skill>/g, (_match, attrs) => {
		const name = /name="([^"]+)"/.exec(attrs)?.[1]
		return `> [!note] SKILL loaded: ${name ?? '(unknown)'}`
	})
}

/**
 * Render one live durable event as a markdown block.
 * @param event - the frozen durable event handed to the `session/event` listener.
 * @param toolNameOf - resolves a tool call id to its tool name.
 * @returns the markdown block, or undefined when the event is not mirrored.
 */
function blockFor(event, toolNameOf) {
	if (event?.type === 'user/message') {
		// Not every user-role message is a human prompt: plugins inject their own
		// via agent.followup/steer with a different `source.kind`.
		if (event.data?.source?.kind !== 'user') return undefined
		const text = stripSkillBlocks(messageText(event.data).trim())
		return text.length === 0 ? undefined : `> [!quote] YOU\n\n${text}`
	}
	if (event?.type === 'assistant/message') {
		const text = messageText(event.data?.message).trim()
		return text.length === 0 ? undefined : `> [!abstract] AI\n\n${text}`
	}
	if (event?.type === 'tool/result') {
		const message = event.data?.message
		const name = toolNameOf(message?.toolCallId)
		if (!QA_TOOLS.has(name)) return undefined
		const text = messageText(message).trim()
		if (text.length === 0) return undefined
		return name === 'quiz'
			? callout('question', 'Quiz', text.split('\n'))
			: callout('example', 'Question', text.split('\n'))
	}
	return undefined
}

/**
 * Register the markdown-mirror commands and the session observer.
 * @param ctx - plugin context.
 * @param config - resolved plugin config (unused by this module).
 */
export function applyMdLog(ctx, config) {
	/** Per-session link, write queue, and tool-call name table. */
	const sessions = new WeakMap()

	/**
	 * @param session - a live session object.
	 * @returns the mutable state for that session.
	 */
	function stateFor(session) {
		let state = sessions.get(session)
		if (state === undefined) {
			state = { file: undefined, queue: Promise.resolve(), toolNames: new Map() }
			sessions.set(session, state)
		}
		return state
	}

	/** Serialize appends: events can fire close together. */
	function enqueue(state, task) {
		const next = state.queue.then(task, task)
		state.queue = next.then(
			() => undefined,
			() => undefined,
		)
		return next
	}

	/**
	 * Append one markdown block, tolerating a file deleted underneath us.
	 * @param file - the linked markdown file.
	 * @param block - the markdown to add.
	 */
	async function append(file, block) {
		try {
			const prefix = fs.existsSync(file) && fs.statSync(file).size > 0 ? '\n\n' : ''
			fs.appendFileSync(file, `${prefix}${block}\n`, 'utf-8')
		} catch {
			// The file may have been moved or deleted externally; ignore.
		}
	}

	ctx.on('session/event', (session, event) => {
		const state = stateFor(session)

		// `tool/call` is not mirrored, but it is the only place a tool result's
		// name is recorded.
		if (event?.type === 'tool/call') {
			const { callId, name } = event.data ?? {}
			if (typeof callId === 'string' && typeof name === 'string') state.toolNames.set(callId, name)
			return
		}
		if (state.file === undefined) return

		const block = blockFor(event, (callId) => state.toolNames.get(callId))
		if (block === undefined) return
		const file = state.file
		void enqueue(state, () => append(file, block))
	})

	/**
	 * Write the whole session so far into the file, using the surface-projected
	 * message history rather than the deprecated raw event readers.
	 * @param session - the session to replay.
	 * @param file - the linked markdown file.
	 * @returns how many messages were considered.
	 */
	function backfill(session, file) {
		if (typeof session.deriveMessages !== 'function') return 0
		const messages = session.deriveMessages()
		const toolNames = new Map()
		const blocks = []
		for (const message of messages) {
			if (message?.role === 'assistant') {
				for (const part of message.content ?? []) {
					if (part?.type === 'tool-call' && typeof part.id === 'string') toolNames.set(part.id, part.name)
				}
				const text = messageText(message).trim()
				if (text.length > 0) blocks.push(`> [!abstract] AI\n\n${text}`)
				continue
			}
			if (message?.role === 'user') {
				if (message.source?.kind !== 'user') continue
				const text = stripSkillBlocks(messageText(message).trim())
				if (text.length > 0) blocks.push(`> [!quote] YOU\n\n${text}`)
				continue
			}
			if (message?.role === 'tool') {
				const name = toolNames.get(message.toolCallId)
				if (!QA_TOOLS.has(name)) continue
				const text = messageText(message).trim()
				if (text.length === 0) continue
				blocks.push(name === 'quiz'
					? callout('question', 'Quiz', text.split('\n'))
					: callout('example', 'Question', text.split('\n')))
			}
		}
		if (blocks.length > 0) {
			try {
				fs.writeFileSync(file, `${blocks.join('\n\n')}\n`, 'utf-8')
			} catch {
				// ignore
			}
		}
		return messages.length
	}

	ctx.commands.register({
		name: 'md-log',
		description: 'Mirror the session to a markdown file (backfills history)',
		input: { hint: '<filepath>' },
		handler: (invocation) => {
			const filepath = String(invocation.rawInput ?? '').trim()
			if (filepath.length === 0) return { kind: 'error', text: 'Usage: /md-log <filepath>' }
			const session = invocation.agent?.session
			if (session === undefined) return { kind: 'error', text: 'No active session to log.' }

			const resolved = path.isAbsolute(filepath)
				? filepath
				: path.resolve(session.header?.cwd ?? process.cwd(), filepath)

			// The file must already exist — /md-log links into an existing note,
			// it never creates one, so a typo cannot scatter new files around.
			if (!fs.existsSync(resolved)) return { kind: 'error', text: `File does not exist: ${resolved}` }
			if (!fs.statSync(resolved).isFile()) return { kind: 'error', text: `Not a file: ${resolved}` }

			const state = stateFor(session)
			state.file = resolved
			const considered = backfill(session, resolved)
			return { kind: 'success', text: `Linked: ${resolved} (${considered} messages backfilled)` }
		},
	})

	ctx.commands.register({
		name: 'md-unlog',
		description: 'Stop mirroring the session to a markdown file',
		handler: (invocation) => {
			const session = invocation.agent?.session
			const state = session === undefined ? undefined : sessions.get(session)
			if (state?.file === undefined) return { kind: 'error', text: 'No file linked' }
			const name = path.basename(state.file)
			state.file = undefined
			return { kind: 'success', text: `Unlinked: ${name}` }
		},
	})
}
