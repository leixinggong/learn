/**
 * quiz — a GRADED sibling of `ask_user_question`.
 *
 * Where `ask_user_question` collects a preference/decision with no notion of
 * right or wrong, `quiz` poses a question that HAS a correct answer, grades the
 * user's selection, and reports tight feedback (✓/✗ + the correct answer + the
 * explanation) back to the model.
 *
 * It is intentionally options-only: single-select or multi-select. There is no
 * free-text mode and no author-supplied "Other" option, because a free-text
 * answer can't be graded against a correct value. An "I don't know" choice is
 * added automatically so an honest gap is never confused with a wrong guess.
 *
 * Ported from the pi `quiz` extension. The pi version drew its own TUI; here the
 * question is presented through the host's `ctx.userQuestions` service, and the
 * feedback is carried by the tool result's `render` output.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** The always-present opt-out. Not a real option: never shuffled, never graded. */
const DONT_KNOW_LABEL = "I don't know"

const DESCRIPTION = [
	'Ask the user a GRADED question with a known correct answer, then grade their answer and give feedback.',
	'Use `quiz` to (1) assess what the learner already understands before teaching, and (2) run tight practice/retrieval loops after explaining.',
	'For a question with no right answer — a preference, a direction, a free-form answer — use `ask_user_question` instead.',
	'',
	'Rules:',
	'- `correct_answer` is REQUIRED and holds option `value` string(s), never a position number. It is self-checking: a value matching no option is an error.',
	'- `explanation` is REQUIRED. Always say why the correct answer is correct.',
	'- Provide ONLY the real, gradable options (at least two). An "I don\'t know" choice is added automatically — never add your own uncertainty or opt-out option.',
	'- Multi-select is graded as an exact-set match: correct only if every correct option is selected and no incorrect one is.',
	'- Treat each distractor as a diagnostic probe: make it a specific, believable mistake (a common misconception or an easily-confused neighbour) so that WHICH wrong answer the user picks reveals WHICH nuance is off — then let the explanation address that gap.',
	'- Every distractor must be unambiguously wrong on the intended reading: tempting, but a real error, not a defensible alternative. Never write a trick question.',
	'- Keep options even in form — similar length, specificity and phrasing — so the correct one cannot be picked from shape alone. Put ALL reasoning in `explanation`, never inside an option.',
	'- Options are shuffled before display by default, so position carries no signal. Set `shuffle: false` only when order is meaningful (ordered values, or an "all of the above" option that must stay last).',
	'- Ask several quick questions and adapt each one to the previous answer, rather than writing one giant question.',
	'If the result says the user chose "I don\'t know", they did not guess — treat it as a genuine knowledge gap to teach into, not as a wrong answer.',
].join('\n')

const MODE_SINGLE = 'single-select'
const MODE_MULTI = 'multi-select'

/**
 * Trim, drop blanks, and enforce that labels and values are unique.
 * @param raw - options as supplied by the model.
 * @returns normalized options.
 * @throws when a label or value repeats, since grading keys off both.
 */
function normalizeOptions(raw) {
	const seenLabels = new Set()
	const seenValues = new Set()
	const out = []
	for (const option of raw ?? []) {
		const label = String(option?.label ?? '').trim()
		if (label.length === 0) continue
		const value = String(option?.value ?? '').trim() || label
		if (seenLabels.has(label)) throw new Error(`duplicate option label ${JSON.stringify(label)}`)
		if (seenValues.has(value)) throw new Error(`duplicate option value ${JSON.stringify(value)}`)
		seenLabels.add(label)
		seenValues.add(value)
		const description = String(option?.description ?? '').trim()
		out.push(description.length > 0 ? { label, value, description } : { label, value })
	}
	return out
}

/**
 * Fisher-Yates shuffle over a copy. Safe because grading resolves through
 * option values, not positions.
 * @param items - options to reorder.
 * @returns a shuffled copy.
 */
function shuffled(items) {
	const out = [...items]
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1))
		;[out[i], out[j]] = [out[j], out[i]]
	}
	return out
}

/**
 * Resolve author-supplied option values to the display labels the answer
 * service echoes back.
 * @param values - option `value` strings named as correct.
 * @param options - the post-shuffle option list actually shown.
 * @returns the correct labels, or an error string.
 */
function resolveCorrectLabels(values, options) {
	const byValue = new Map(options.map((option) => [option.value, option.label]))
	const labels = []
	for (const raw of values) {
		const value = String(raw).trim()
		const label = byValue.get(value)
		if (label === undefined) {
			const known = options.map((option) => JSON.stringify(option.value)).join(', ')
			return { error: `correct_answer ${JSON.stringify(value)} does not match any option value (${known})` }
		}
		if (!labels.includes(label)) labels.push(label)
	}
	return { labels }
}

/**
 * Exact-set comparison in the post-shuffle display order.
 * @param selected - labels the user selected, excluding "I don't know".
 * @param correct - labels that are correct.
 * @param options - the post-shuffle option list.
 * @returns whether the selection matches the correct set exactly.
 */
function isExactMatch(selected, correct, options) {
	const order = options.map((option) => option.label)
	const asIndexSet = (labels) =>
		[...new Set(labels)]
			.map((label) => order.indexOf(label))
			.filter((index) => index >= 0)
			.sort((a, b) => a - b)
	const a = asIndexSet(selected)
	const b = asIndexSet(correct)
	return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Render the graded outcome for the model: the verdict, the full option list
 * with ✓/✗ marks, the correct answer, any note, and the explanation.
 * @param value - the tool's structured output.
 * @returns model-facing text.
 */
function renderFeedback(value) {
	const lines = []
	for (const option of value.options) {
		const mark = option.correct ? '✓' : option.selected ? '✗' : ' '
		lines.push(`${mark} ${option.index}. ${option.label}`)
	}
	lines.push('')
	if (value.status !== 'answered') {
		lines.push(value.status === 'skipped' ? 'User skipped the question.' : 'User cancelled the question.')
		return lines.join('\n')
	}
	if (value.dont_know) {
		lines.push('User selected "I don\'t know" — they did not attempt an answer (a genuine knowledge gap, not a wrong guess).')
	} else {
		const selected = value.selected.join(', ')
		lines.push(`User answered ${value.correct ? 'correctly' : 'incorrectly'}.`)
		if (selected.length > 0) lines.push(`Selected: ${selected}`)
	}
	lines.push(`Correct: ${value.correct_answer.join(', ')}`)
	if (value.note !== undefined) lines.push(`User's note: ${value.note}`)
	lines.push(`Explanation: ${value.explanation}`)
	return lines.join('\n')
}

/**
 * Register the `quiz` tool.
 * @param ctx - agent-scoped context receiving the tool.
 * @param config - resolved plugin config (unused by this module).
 */
export function applyQuiz(ctx, config) {
	ctx.tools.register(
		defineTool({
			name: 'quiz',
			description: DESCRIPTION,
			parameters: {
				question: {
					type: 'string',
					required: true,
					description: 'The single quiz question to ask. Ask exactly one question per tool call.',
				},
				details: {
					type: 'string',
					description: 'Optional extra context or instructions shown under the question.',
				},
				options: {
					type: 'array',
					required: true,
					description:
						'The answer options (two or more). Options only — there is no free-text mode. Give each option a stable `value`; the correct one is referenced by that value.',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							label: { type: 'string', required: true, description: 'Display label for the answer option.' },
							value: {
								type: 'string',
								description: 'Optional machine-readable value. Defaults to the label.',
							},
							description: {
								type: 'string',
								description: 'Optional extra detail shown below the option.',
							},
						},
					},
				},
				multi_select: {
					type: 'boolean',
					description: 'Set to true when more than one option is correct and the user must select all of them.',
				},
				correct_answer: {
					type: 'array',
					required: true,
					description:
						'REQUIRED. The correct answer as the option value(s). Single-select: one value, e.g. ["mercury"]. Multi-select: every correct value, e.g. ["belize", "niue"]. Always pass values, never position numbers.',
					items: { type: 'string' },
				},
				explanation: {
					type: 'string',
					required: true,
					description:
						'REQUIRED. Shown after the user answers, whether right or wrong. Say why the correct answer is correct.',
				},
				shuffle: {
					type: 'boolean',
					description:
						"Defaults to true: options are randomly reordered before display so the correct answer isn't always in the same position. Set false only when option order is meaningful.",
				},
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: true,
					required: true,
					properties: {
						status: {
							type: 'string',
							enum: ['answered', 'skipped', 'cancelled'],
							required: true,
							description: 'Outcome of the question.',
						},
						question: { type: 'string', required: true },
						mode: { type: 'string', enum: [MODE_SINGLE, MODE_MULTI], required: true },
						correct: {
							type: 'boolean',
							required: true,
							description: 'False for a skipped question and for "I don\'t know".',
						},
						dont_know: { type: 'boolean', required: true },
						selected: { type: 'array', items: { type: 'string' }, required: true },
						correct_answer: { type: 'array', items: { type: 'string' }, required: true },
						note: { type: 'string', description: "The user's optional free-text note, present only when non-empty." },
						options: {
							type: 'array',
							required: true,
							items: {
								type: 'object',
								additionalProperties: false,
								properties: {
									index: { type: 'integer', required: true },
									label: { type: 'string', required: true },
									correct: { type: 'boolean', required: true },
									selected: { type: 'boolean', required: true },
								},
							},
						},
						explanation: { type: 'string' },
					},
				},
				render: (_args, value) => [{ type: 'text', text: renderFeedback(value) }],
			},
			async execute(args, exec) {
				const details = args.details?.trim() || undefined
				const explanation = String(args.explanation ?? '').trim()
				const mode = args.multi_select === true ? MODE_MULTI : MODE_SINGLE

				let options
				try {
					options = normalizeOptions(args.options)
				} catch (error) {
					throw new Error(`quiz ${error.message}`)
				}
				if (options.length < 2) throw new Error('quiz requires at least two options')

				// Shuffle BEFORE resolving the correct labels so grading matches the
				// order the user actually sees.
				if (args.shuffle !== false) options = shuffled(options)

				const resolved = resolveCorrectLabels(args.correct_answer ?? [], options)
				if (resolved.error !== undefined) throw new Error(`quiz ${resolved.error}`)
				const correctLabels = resolved.labels
				if (correctLabels.length === 0) throw new Error('quiz correct_answer is required')

				// Build the displayed option list, appending the automatic opt-out.
				const displayed = [...options, { label: DONT_KNOW_LABEL, value: '__dont_know__' }]
				const byLabel = new Map(displayed.map((option, index) => [option.label, { option, index: index + 1 }]))

				const describe = (value, selectedLabels) => {
					const selectedSet = new Set(selectedLabels)
					const correctSet = new Set(correctLabels)
					return displayed.map((option, index) => ({
						index: index + 1,
						label: option.label,
						correct: correctSet.has(option.label),
						selected: selectedSet.has(option.label),
					}))
				}

				const base = (status, selectedLabels, note) => {
					const dontKnow = selectedLabels.includes(DONT_KNOW_LABEL)
					const realSelected = selectedLabels.filter((label) => label !== DONT_KNOW_LABEL)
					const value = {
						status,
						question: args.question,
						mode,
						correct: status === 'answered' && !dontKnow && isExactMatch(realSelected, correctLabels, options),
						dont_know: dontKnow,
						selected: realSelected,
						correct_answer: correctLabels,
						options: describe(null, selectedLabels),
						explanation,
					}
					if (note !== undefined) value.note = note
					return value
				}

				// A cancelled or timed-out question must not be graded as wrong.
				if (exec.signal?.aborted) return base('cancelled', [])

				const result = await ctx.userQuestions.ask({
					questions: [
						{
							id: 'quiz',
							question: details === undefined ? args.question : `${args.question}\n\n${details}`,
							options: displayed.map((option) => (option.description === undefined
								? { label: option.label }
								: { label: option.label, description: option.description })),
							...(args.multi_select === true ? { multiSelect: true } : {}),
						},
					],
					...(exec.agent !== undefined ? { agent: exec.agent } : {}),
					signal: exec.signal,
				})

				const answer = result.answers[0]
				if (answer === undefined) return base('cancelled', [])
				const selectedLabels = [...answer.selected]
				// A skipped question comes back with nothing selected and no custom text.
				if (selectedLabels.length === 0 && answer.custom === undefined) return base('skipped', [])

				const note = answer.custom?.trim() || undefined
				// Guard against a label the option list no longer knows about.
				for (const label of selectedLabels) {
					if (!byLabel.has(label)) throw new Error(`quiz received an unknown option label ${JSON.stringify(label)}`)
				}
				return base('answered', selectedLabels, note)
			},
		}),
	)
}
