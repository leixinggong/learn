/**
 * learn — the DSH port of the pi "learn" teaching system.
 *
 * One bundle registers everything the teaching system needs from the host:
 *
 *   quiz            (lib/quiz.js)          — graded multiple-choice questions
 *   write_mermaid / edit_mermaid / render_mermaid   (lib/mermaid-tools.js)
 *   write_svg / edit_svg / render_svg               (lib/svg-tools.js)
 *                                           — the makers' authoring loops
 *   /md-log, /md-unlog      (lib/md-log.js) — mirror the session to a markdown file
 *
 * The `teach` philosophy, the `visualize` procedure, and the three maker briefs
 * ship as skills under `skills/`, which DSH discovers from `.dsh/skills` of the
 * workspace this bundle is cloned into. DSH has no named-subagent dispatch, so
 * the pi `agents/*.md` definitions became skills the delegating agent points a
 * `subagent` call at.
 */

import z from '@deepseek-ai/schemastery'
import { applyMdLog } from './md-log.js'
import { applyMermaidTools } from './mermaid-tools.js'
import { applyQuiz } from './quiz.js'
import { applySvgTools } from './svg-tools.js'

export const name = 'learn'

export const inject = ['tools', 'userQuestions', 'commands']

export const Config = z.object({
	vizDir: z.string().default('viz'),
})

/**
 * Register the plugin's tools and commands.
 * @param ctx - the plugin context.
 * @param config - the row's config, validated against `Config`.
 */
export function apply(ctx, config = {}) {
	const resolved = { vizDir: config.vizDir ?? 'viz' }
	applyQuiz(ctx, resolved)
	applyMermaidTools(ctx, resolved)
	applySvgTools(ctx, resolved)
	applyMdLog(ctx, resolved)
}
