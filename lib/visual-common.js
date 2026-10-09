/**
 * Shared helpers for the visual authoring loops (`mermaid-tools.js`,
 * `svg-tools.js`): a subprocess runner, a per-agent managed source file, an
 * exact-match editor, and publishing a chosen render into `<cwd>/viz`.
 *
 * The pi original kept its session state in module scope because each subagent
 * ran in its own child process. A DSH subagent runs in-process, so module scope
 * is shared between the main agent and every concurrent subagent. Each maker
 * therefore gets its own state, keyed by the owning agent object.
 */

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// rsvg-convert lives under MacPorts (/opt/local/bin); magick/gs under
// /usr/local/bin; Homebrew under /opt/homebrew/bin. Augment PATH so a process
// started with a thin PATH still resolves them.
export const EXTRA_PATH = ['/opt/local/bin', '/usr/local/bin', '/opt/homebrew/bin']

// Transient session/preview files live under the OS temp dir (NOT the vault),
// so only the PUBLISHED PNG ever lands inside it.
export const STAGING_ROOT = join(tmpdir(), 'dsh-learn-visual')

export const CHROME_CANDIDATES = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
]

/**
 * @returns the first installed Chrome/Chromium executable, or undefined.
 */
export function findChrome() {
	for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate
	return undefined
}

/**
 * Run a subprocess to completion with a hard timeout.
 * @param cmd - executable.
 * @param args - arguments.
 * @param opts - working directory, timeout in ms, and extra environment.
 * @returns exit code, captured streams, and whether the timeout fired.
 */
export function run(cmd, args, opts) {
	return new Promise((resolveRun) => {
		const augmentedPath = [...EXTRA_PATH, process.env.PATH ?? ''].join(delimiter)
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: { ...process.env, ...(opts.env ?? {}), PATH: augmentedPath },
		})
		let stdout = ''
		let stderr = ''
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGKILL')
		}, opts.timeoutMs)
		child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
		child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
		child.on('error', (error) => {
			clearTimeout(timer)
			resolveRun({ code: null, stdout, stderr: stderr + String(error), timedOut })
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			resolveRun({ code, stdout, stderr, timedOut })
		})
	})
}

/**
 * The session working directory, used as the base for publishing.
 * @param exec - the tool execution context.
 * @returns the owning session's cwd, or the process cwd as a fallback.
 */
export function sessionCwd(exec) {
	return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

/**
 * Exact-match single replacement, matching the host's `edit` contract: the old
 * text must appear exactly once.
 * @param current - the current source.
 * @param oldText - the substring to replace.
 * @param newText - its replacement.
 * @returns the updated content and the match offset.
 * @throws with a precise reason on a missing or ambiguous match.
 */
export function applyEdit(current, oldText, newText) {
	if (oldText === '') throw new Error('`old_text` must be non-empty.')
	if (oldText === newText) throw new Error('`old_text` and `new_text` are identical.')
	const first = current.indexOf(oldText)
	if (first === -1) throw new Error('`old_text` not found in the current source — match it exactly.')
	if (current.indexOf(oldText, first + 1) !== -1) {
		let count = 0
		let cursor = current.indexOf(oldText)
		while (cursor !== -1) {
			count += 1
			cursor = current.indexOf(oldText, cursor + oldText.length)
		}
		throw new Error(`\`old_text\` appears ${count} times — add surrounding context to make it unique.`)
	}
	return { updated: current.slice(0, first) + newText + current.slice(first + oldText.length), index: first }
}

/**
 * A small numbered window of `content` around a character offset.
 * @param content - the full text.
 * @param index - the offset to centre on.
 * @param contextLines - lines to include on each side.
 * @returns the excerpt with 1-based line numbers.
 */
export function snippetAround(content, index, contextLines = 3) {
	const before = content.slice(0, index)
	const hitLine = before.split('\n').length - 1
	const lines = content.split('\n')
	const start = Math.max(0, hitLine - contextLines)
	const end = Math.min(lines.length - 1, hitLine + contextLines)
	const width = String(end + 1).length
	const out = []
	for (let i = start; i <= end; i += 1) out.push(`${String(i + 1).padStart(width)}  ${lines[i]}`)
	return out.join('\n')
}

/**
 * Copy a rendered PNG into `<baseDir>/viz` under a unique, slugified name.
 * @param baseDir - typically the session working directory.
 * @param vizDir - the directory name to publish into.
 * @param pngPath - the rendered file.
 * @param slug - a short topic slug supplied by the maker.
 * @returns the published filename and absolute path.
 */
export function publish(baseDir, vizDir, pngPath, slug) {
	const filesDir = join(baseDir, vizDir)
	mkdirSync(filesDir, { recursive: true })
	const clean =
		String(slug)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'viz'
	const filename = `viz-${clean}-${Date.now()}.png`
	const dest = join(filesDir, filename)
	copyFileSync(pngPath, dest)
	return { filename, path: dest }
}

/**
 * Per-agent managed source file, so parallel makers never share one file.
 * @param group - a label distinguishing this authoring loop (mermaid, svg).
 * @param bodyFileName - the source filename inside the agent's work dir.
 * @returns an accessor keyed by the owning agent.
 */
export function createSessionStore(group, bodyFileName) {
	const byAgent = new WeakMap()
	let counter = 0
	const unowned = { state: undefined }

	function entryFor(exec) {
		const agent = exec?.agent
		if (agent === undefined || agent === null) return unowned
		let entry = byAgent.get(agent)
		if (entry === undefined) {
			entry = { state: undefined }
			byAgent.set(agent, entry)
		}
		return entry
	}

	return {
		/**
		 * @param exec - the tool execution context.
		 * @returns the current source file state, or undefined before a write.
		 */
		read(exec) {
			return entryFor(exec).state
		},
		/**
		 * Write the full source, creating this agent's work dir on first use.
		 * @param exec - the tool execution context.
		 * @param source - the complete source text.
		 * @returns the session state for the agent.
		 */
		write(exec, source) {
			const entry = entryFor(exec)
			if (entry.state === undefined) {
				counter += 1
				const workDir = join(STAGING_ROOT, `${group}-${process.pid}-${counter}`)
				mkdirSync(workDir, { recursive: true })
				entry.state = { workDir, bodyPath: join(workDir, bodyFileName) }
			}
			writeFileSync(entry.state.bodyPath, source, 'utf8')
			return entry.state
		},
	}
}

export { existsSync, mkdirSync, readFileSync, writeFileSync, join }
