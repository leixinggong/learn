/**
 * Mermaid authoring loop for the mermaid-maker — three tools sharing one
 * per-agent managed source file:
 *
 *   write_mermaid   — write the full Mermaid source to the agent's file
 *   edit_mermaid    — exact-match old_text -> new_text on that file
 *   render_mermaid  — render the file -> PNG, returned inline; with `save_as`,
 *                     also publish it into <cwd>/viz
 *
 * Rendering shells out to the bundled @mermaid-js/mermaid-cli (`mmdc`) with a
 * puppeteer config pointing at an installed Chrome, so no Chromium download is
 * needed. The PNG is handed back through the host attachment store so the model
 * can actually look at the diagram and iterate.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	applyEdit,
	createSessionStore,
	existsSync,
	findChrome,
	mkdirSync,
	publish,
	readFileSync,
	run,
	sessionCwd,
	snippetAround,
	writeFileSync,
} from './visual-common.js'

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const MMDC_BIN = join(PACKAGE_DIR, 'node_modules', '.bin', 'mmdc')
const GROUP = 'mermaid'
const BODY_FILE = 'diagram.mmd'
const RENDER_TIMEOUT_MS = 120_000

/**
 * Store a rendered PNG as a durable attachment so the model can view it.
 * @param ctx - plugin context, used to look up the attachment service.
 * @param pngPath - the rendered file on disk.
 * @param name - the filename to record with the attachment.
 * @returns the attachment reference, or undefined when no store is mounted.
 */
async function imageAttachment(ctx, pngPath, name) {
	const attachments = ctx.get('attachments')
	if (attachments === undefined) return undefined
	const ref = await attachments.saveImage({ data: readFileSync(pngPath), mediaType: 'image/png', name })
	return {
		attachmentId: String(ref.attachmentId),
		mediaType: ref.mediaType,
		bytes: ref.bytes,
		width: ref.width,
		height: ref.height,
		...(ref.name === undefined ? {} : { name: ref.name }),
	}
}

/** Shared output schema: a human-readable line plus an optional inline image. */
const RENDER_OUTPUT = {
	type: 'object',
	additionalProperties: true,
	required: true,
	properties: {
		ok: { type: 'boolean', required: true, description: 'Whether the render succeeded.' },
		message: { type: 'string', required: true, description: 'Model-facing report of the render.' },
		path: { type: 'string', description: 'Absolute path of the produced PNG.' },
		filename: { type: 'string', description: 'Published filename, when saved into viz/.' },
		image: {
			type: 'object',
			additionalProperties: true,
			description: 'Durable attachment reference for the inline image, when one was produced.',
		},
	},
}

/**
 * Register the Mermaid authoring tools.
 * @param ctx - agent-scoped context receiving the tools.
 * @param config - resolved plugin config; `vizDir` names the publish directory.
 */
export function applyMermaidTools(ctx, config) {
	const vizDir = config.vizDir ?? 'viz'
	const store = createSessionStore(GROUP, BODY_FILE)

	ctx.tools.register(
		defineTool({
			name: 'write_mermaid',
			description: [
				"Write the FULL Mermaid source to this session's managed file (your first draft or a complete rewrite).",
				'You do NOT name the file — edit_mermaid and render_mermaid act on the same one.',
				'',
				'`source` is a complete Mermaid diagram, e.g. a `graph TD` / `graph LR` flow, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`, `mindmap`, or `timeline`.',
				'Writing does NOT render — call render_mermaid when ready. For a small fix, prefer edit_mermaid over rewriting.',
			].join('\n'),
			parameters: {
				source: {
					type: 'string',
					required: true,
					description: 'The complete Mermaid diagram source (starts with the diagram type, e.g. `graph TD`).',
				},
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: true,
					properties: { lines: { type: 'integer' }, path: { type: 'string' } },
				},
				render: (_args, value) => [
					{
						type: 'text',
						text: `Wrote a ${value.lines}-line Mermaid source.\nCall render_mermaid to render it, or edit_mermaid to tweak it.`,
					},
				],
			},
			execute(args, exec) {
				const source = String(args.source ?? '').trim()
				if (source.length === 0) throw new Error('`write_mermaid` requires a non-empty `source`.')
				const session = store.write(exec, source)
				return { lines: source.split('\n').length, path: session.bodyPath }
			},
		}),
	)

	ctx.tools.register(
		defineTool({
			name: 'edit_mermaid',
			description: [
				"Make a single exact-match replacement in this session's Mermaid source — the same contract as the built-in edit tool, locked to the one managed file.",
				'`old_text` must appear EXACTLY ONCE (include surrounding context for uniqueness); on zero or multiple matches the call fails and nothing changes.',
				'Call write_mermaid first. Editing does NOT render.',
			].join('\n'),
			parameters: {
				old_text: {
					type: 'string',
					required: true,
					description: 'Exact substring of the current source to replace (must match exactly once).',
				},
				new_text: { type: 'string', required: true, description: 'Replacement text for `old_text`.' },
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: true,
					properties: { region: { type: 'string' } },
				},
				render: (_args, value) => [
					{
						type: 'text',
						text: `Applied edit. Updated region:\n\`\`\`\n${value.region}\n\`\`\`\nCall render_mermaid to see it.`,
					},
				],
			},
			execute(args, exec) {
				const session = store.read(exec)
				if (session === undefined || !existsSync(session.bodyPath)) {
					throw new Error('edit_mermaid: no source yet — call write_mermaid first.')
				}
				const current = readFileSync(session.bodyPath, 'utf8')
				const { updated, index } = applyEdit(current, String(args.old_text ?? ''), String(args.new_text ?? ''))
				writeFileSync(session.bodyPath, updated, 'utf8')
				return { region: snippetAround(updated, index) }
			},
		}),
	)

	ctx.tools.register(
		defineTool({
			name: 'render_mermaid',
			description: [
				'Render the CURRENT session Mermaid source to a PNG and return it inline so you can SEE the diagram and iterate.',
				'You do NOT pass the source here — it comes from the managed file; call write_mermaid first.',
				'',
				'Iterate freely with no `save_as` (preview only). When the diagram is correct and clean, call once more with `save_as` set to a short kebab-case topic slug: that publishes the PNG into <cwd>/viz under a unique filename and returns the filename to embed.',
				'On a render error this returns the error text instead of an image — fix with edit_mermaid and re-render.',
			].join('\n'),
			parameters: {
				save_as: {
					type: 'string',
					description:
						"Short kebab-case topic slug (e.g. 'internet-packets'). When set, the rendered PNG is published into <cwd>/viz as viz-<slug>-<timestamp>.png and the filename is returned. Omit for a preview-only render.",
				},
			},
			output: {
				schema: RENDER_OUTPUT,
				render: (_args, value) => {
					const blocks = [{ type: 'text', text: value.message }]
					if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
					return blocks
				},
			},
			async execute(args, exec) {
				const session = store.read(exec)
				if (session === undefined || !existsSync(session.bodyPath)) {
					throw new Error('render_mermaid: no source yet — call write_mermaid first.')
				}
				const { workDir, bodyPath } = session
				mkdirSync(workDir, { recursive: true })

				const chrome = findChrome()
				const cfgPath = join(workDir, 'puppeteer.json')
				writeFileSync(
					cfgPath,
					JSON.stringify(chrome ? { executablePath: chrome, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] }),
					'utf8',
				)

				const outPath = join(workDir, `render-${Date.now()}.png`)
				const result = await run(
					MMDC_BIN,
					['-i', bodyPath, '-o', outPath, '-p', cfgPath, '-s', '2', '-b', 'white'],
					{ cwd: workDir, timeoutMs: RENDER_TIMEOUT_MS, env: { PUPPETEER_SKIP_DOWNLOAD: '1' } },
				)

				if (result.code !== 0 || !existsSync(outPath)) {
					const detail = (result.stderr || result.stdout || 'unknown error').split('\n').slice(-30).join('\n')
					const note = result.timedOut ? 'mmdc timed out.\n\n' : ''
					return {
						ok: false,
						path: '',
						message: `${note}Mermaid render FAILED — no image produced. Fix the source with edit_mermaid and call render_mermaid again.\n\nError:\n${detail}`,
					}
				}

				const slug = args.save_as === undefined ? undefined : String(args.save_as)
				const published = slug === undefined ? undefined : publish(sessionCwd(exec), vizDir, outPath, slug)
				const image = await imageAttachment(ctx, outPath, published?.filename ?? 'mermaid-preview.png')
				const message = published === undefined
					? 'Preview render (not yet saved). LOOK: are arrows/relationships correct, labels right, nothing cramped? Fix with edit_mermaid, or re-render with `save_as` to publish.'
					: `Published to ${vizDir}/.\nfilename: ${published.filename}\npath: ${published.path}\n\nLOOK at the diagram below to confirm it is correct before returning it.`
				return {
					ok: true,
					message,
					path: published?.path ?? outPath,
					...(published === undefined ? {} : { filename: published.filename }),
					...(image === undefined ? {} : { image }),
				}
			},
		}),
	)
}
