/**
 * SVG authoring loop for the svg-maker — three tools sharing one per-agent
 * managed source file:
 *
 *   write_svg   — write the full SVG source to the agent's file
 *   edit_svg    — exact-match old_text -> new_text on that file
 *   render_svg  — render the file -> PNG, returned inline; with `save_as`,
 *                 also publish it into <cwd>/viz
 *
 * Rendering shells out to rsvg-convert (good system-font handling), falling
 * back to ImageMagick's `magick` when it is absent. Both are system binaries;
 * there are no Node render dependencies.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import {
	applyEdit,
	createSessionStore,
	existsSync,
	mkdirSync,
	publish,
	readFileSync,
	run,
	sessionCwd,
	snippetAround,
	writeFileSync,
} from './visual-common.js'

const GROUP = 'svg'
const BODY_FILE = 'diagram.svg'
const RENDER_TIMEOUT_MS = 60_000

/**
 * Render an SVG file to PNG via rsvg-convert, falling back to ImageMagick.
 * @param svgPath - the SVG to render.
 * @param outPath - the PNG to write.
 * @param workDir - working directory for the child process.
 * @returns whether a PNG was produced, plus the last run result.
 */
async function renderSvg(svgPath, outPath, workDir) {
	// rsvg-convert renders at the SVG's intrinsic size; -z 2 doubles it for crispness.
	const rsvg = await run('rsvg-convert', ['-z', '2', svgPath, '-o', outPath], {
		cwd: workDir,
		timeoutMs: RENDER_TIMEOUT_MS,
	})
	if (rsvg.code === 0 && existsSync(outPath)) return { ok: true, result: rsvg }
	// Fallback: ImageMagick. -density 192 (~2x of 96dpi) for a crisp raster.
	const magick = await run('magick', ['-density', '192', '-background', 'white', svgPath, outPath], {
		cwd: workDir,
		timeoutMs: RENDER_TIMEOUT_MS,
	})
	if (magick.code === 0 && existsSync(outPath)) return { ok: true, result: magick }
	return { ok: false, result: rsvg.code !== null ? rsvg : magick }
}

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
 * Register the SVG authoring tools.
 * @param ctx - agent-scoped context receiving the tools.
 * @param config - resolved plugin config; `vizDir` names the publish directory.
 */
export function applySvgTools(ctx, config) {
	const vizDir = config.vizDir ?? 'viz'
	const store = createSessionStore(GROUP, BODY_FILE)

	ctx.tools.register(
		defineTool({
			name: 'write_svg',
			description: [
				"Write the FULL SVG source to this session's managed file (your first draft or a complete rewrite).",
				'You do NOT name the file — edit_svg and render_svg act on the same one.',
				'',
				'`source` is a complete `<svg ...>…</svg>` document with an explicit width/height (or viewBox), readable font sizes, and a light or transparent background.',
				'Writing does NOT render — call render_svg when ready. For a small fix, prefer edit_svg over rewriting.',
			].join('\n'),
			parameters: {
				source: {
					type: 'string',
					required: true,
					description: 'The complete SVG document, from `<svg` through `</svg>`.',
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
						text: `Wrote a ${value.lines}-line SVG source.\nCall render_svg to render it, or edit_svg to tweak it.`,
					},
				],
			},
			execute(args, exec) {
				const source = String(args.source ?? '').trim()
				if (source.length === 0) throw new Error('`write_svg` requires a non-empty `source`.')
				if (!source.includes('<svg')) throw new Error('`write_svg`: source must be a complete <svg>…</svg> document.')
				const session = store.write(exec, source)
				return { lines: source.split('\n').length, path: session.bodyPath }
			},
		}),
	)

	ctx.tools.register(
		defineTool({
			name: 'edit_svg',
			description: [
				"Make a single exact-match replacement in this session's SVG source — the same contract as the built-in edit tool, locked to the one managed file.",
				'`old_text` must appear EXACTLY ONCE (include surrounding context for uniqueness); on zero or multiple matches the call fails and nothing changes.',
				'Call write_svg first. Editing does NOT render.',
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
						text: `Applied edit. Updated region:\n\`\`\`\n${value.region}\n\`\`\`\nCall render_svg to see it.`,
					},
				],
			},
			execute(args, exec) {
				const session = store.read(exec)
				if (session === undefined || !existsSync(session.bodyPath)) {
					throw new Error('edit_svg: no source yet — call write_svg first.')
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
			name: 'render_svg',
			description: [
				'Render the CURRENT session SVG source to a PNG and return it inline so you can SEE the picture and iterate.',
				'You do NOT pass the source here — it comes from the managed file; call write_svg first.',
				'',
				'Iterate freely with no `save_as` (preview only). When the picture is correct and clean, call once more with `save_as` set to a short kebab-case topic slug: that publishes the PNG into <cwd>/viz under a unique filename and returns the filename to embed.',
				'On a render error this returns the error text instead of an image — fix with edit_svg and re-render.',
			].join('\n'),
			parameters: {
				save_as: {
					type: 'string',
					description:
						"Short kebab-case topic slug (e.g. 'number-line'). When set, the rendered PNG is published into <cwd>/viz as viz-<slug>-<timestamp>.png and the filename is returned. Omit for a preview-only render.",
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
					throw new Error('render_svg: no source yet — call write_svg first.')
				}
				const { workDir, bodyPath } = session
				mkdirSync(workDir, { recursive: true })

				const outPath = join(workDir, `render-${Date.now()}.png`)
				const { ok, result } = await renderSvg(bodyPath, outPath, workDir)

				if (!ok) {
					const detail = (result.stderr || result.stdout || 'unknown error').split('\n').slice(-30).join('\n')
					const note = result.timedOut ? 'SVG render timed out.\n\n' : ''
					return {
						ok: false,
						path: '',
						message: `${note}SVG render FAILED — no image produced (tried rsvg-convert then magick). Fix the source with edit_svg and call render_svg again.\n\nError:\n${detail}`,
					}
				}

				const slug = args.save_as === undefined ? undefined : String(args.save_as)
				const published = slug === undefined ? undefined : publish(sessionCwd(exec), vizDir, outPath, slug)
				const image = await imageAttachment(ctx, outPath, published?.filename ?? 'svg-preview.png')
				const message = published === undefined
					? 'Preview render (not yet saved). LOOK: are coordinates, angles, directions, and proportions correct? Labels clear and unclipped? Fix with edit_svg, or re-render with `save_as` to publish.'
					: `Published to ${vizDir}/.\nfilename: ${published.filename}\npath: ${published.path}\n\nLOOK at the picture below to confirm the geometry is correct before returning it.`
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
