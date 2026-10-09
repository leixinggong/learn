# Visual lessons

Use this branch when the planned concept benefits from seeing a relationship or changing a parameter. The teacher selects the surface; the learner can override it. A visual is evidence for a model under stated assumptions, not a substitute for its derivation.

## Choose and build incrementally

- Mermaid: dependencies, flows, and relationships. Keep the editable `.mmd` source when saving a rendered artifact.
- SVG: exact geometry, vectors, spatial layouts. Keep the source beside a PNG preview if the client cannot display SVG.
- Matplotlib in one notebook: quantitative curves, equations, data, numerical experiments. Prefer ordinary parameter cells and reruns; widgets are optional.
- Browser demo: direct manipulation materially helps and an available browser can open and test it. Retain its local HTML/JS source. A notebook is often simpler for scientific work.
- TikZ: justified by precise mathematical typesetting or an existing LaTeX workflow, with an available compiler. Retain `.tex` and a rendered preview.

For each node, integrate this sequence into probe → plan → teach:

1. **Motivate:** name the question this visual lets us answer.
2. **Draw/build:** add the minimum setup to the evolving artifact: axes, quantities, assumptions, or the already-established baseline.
3. **Predict:** ask one graded question when a prediction is useful. Wait for the learner before exposing the answer through a plot, output, annotation, later cell, or explanation. Keep future results out of the learner-facing artifact until that turn. In explicitly expository mode, narrate the prediction instead.
4. **Manipulate/run:** change one meaningful parameter or assumption, then execute/render. Explain what stayed fixed and what changed. Do not silently normalize away the effect being taught.
5. **Explain:** compare the actual result with the prediction and connect it to established nodes. State the limits of the model.
6. **Check:** use the teaching skill's graded chat question to test transfer to a new case, then wait. A working plot is not evidence of learner understanding.

## One editable lesson

Reuse the current lesson notebook; inspect its cells and learner changes before every edit. Keep stable cell IDs, parameter cells, assumptions, units, derivations, and conclusions. Append or narrowly update the current increment instead of regenerating the file. Respect unsaved editor changes: save/synchronize before external edits or execution. Put the notebook, editable diagram/demo source, and figures in the learner's lesson directory, not `/tmp` or a plugin cache. Keep figures in `figures/` and use relative paths inside the notebook.

The optional [notebook template](../assets/lesson.ipynb) provides a small starting structure. Adapt it to the topic; it is not a mandatory lesson format. The [launcher](../scripts/notebook.py) can initialize without overwriting and run Jupyter using the same Python environment as its kernel:

```sh
uv run --locked /absolute/path/to/skills/learn/scripts/notebook.py /absolute/lesson/lesson.ipynb --init
uv run --locked /absolute/path/to/skills/learn/scripts/notebook.py /absolute/lesson/lesson.ipynb --check
uv run --locked /absolute/path/to/skills/learn/scripts/notebook.py /absolute/lesson/lesson.ipynb --open
```

Use an existing suitable project environment with JupyterLab, Matplotlib, nbclient, nbformat, and ipykernel when present; the script's PEP 723 dependencies support portable `uv run --locked` otherwise. `--check` executes the saved notebook in a fresh kernel and creates an executed copy under `.learn-checks/`; it never replaces the lesson notebook. Inspect that copy and its outputs before applying any output updates to the learner's notebook. Execution can write files through notebook code: inspect those cells first and preserve unrelated files. The launcher temporarily resolves the notebook’s named Python kernel to its own environment without changing notebook metadata or global kernels. `--open` launches authenticated, loopback-only Jupyter and requests the local browser. A server startup or browser-open request alone does not establish that the learner can see it.

## Optional illustrator

Adapt Learn's original `skills/visualize` pattern only when delegation is useful and authorized by the user or governing instructions. Use an actually available agent tool; otherwise draw locally. Do not assume Pi makers, Obsidian logging, or specialized render tools exist in native Codex.

Give one bounded illustration task: the idea, established assumptions, quantities/units, intended relationship, at most a few carrying elements, allowed files, renderer, and required return evidence. Ask the illustrator to return editable source, rendered artifact paths, execution evidence, and whether it visually inspected the result. It must not invent scientific assumptions or modify the lesson narrative. The teacher verifies the math, labels, domain, normalization, and consistency with the current node, and inspects the returned render before teaching from it. A delegation report alone is not teacher validation.

## Deliver visibly and report evidence

Track separately: **created** (file exists), **executed/rendered** (successful run), **visually inspected** (an image/viewer tool actually showed the result), and **opened** (the target notebook/browser/viewer surface was observed or the learner confirmed it). Mark unavailable checks explicitly. Use a fresh kernel to catch hidden notebook state; retain successful outputs in the delivered notebook after reconciling learner edits. Check both the science and visual readability, including axes, legends, clipping, and units.

Embed the inspected PNG or supported SVG in the current conversation using `![description](/absolute/lesson/figures/name.png)`, followed by a real `[editable notebook](/absolute/lesson/lesson.ipynb)` or source link. A file link alone does not display an image. If visual inspection is unavailable, label the artifact uninspected rather than claim it renders correctly. If the learner asks to see/open it, use an available local viewer/browser and verify that surface; keep the inline preview as the portable fallback. Never claim a canvas, interactive control, open notebook, or visible image merely because source code or a URL was produced.
