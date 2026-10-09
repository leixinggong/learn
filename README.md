# learn

[![video](assets/thumbnail.png)](https://www.youtube.com/watch?v=kzcI5F4tGiU)

My AI learning system from this video: [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).

This is a personal system I built for myself, shared as-is. It was originally a **pi** configuration; this branch is the **DeepSeek Harness** port: the teaching philosophy encoded in skills, one host plugin for the tooling, and the maker/researcher briefs as skills.

## What's in it

- `skills/teach/` — the philosophy and the process
- `skills/visualize/` — adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `skills/researcher/`, `skills/mermaid-maker/`, `skills/svg-maker/` — the briefs the main agent hands to a `subagent` call
- `lib/quiz.js` — graded questions with instant feedback (✓/✗, correct answer, explanation)
- `lib/mermaid-tools.js` / `lib/svg-tools.js` — the makers' authoring loops (`write_*` / `edit_*` / `render_*`)
- `lib/md-log.js` — `/md-log` and `/md-unlog`: link a markdown file to the session

## Install

This repo **is** a DSH bundle that you drop in as the workspace's `.dsh` directory. From your learning project's root:

```bash
git clone https://github.com/amosblomqvist/learn .dsh
```

That immediately gives you the skills: DSH discovers them from `<projectRoot>/.dsh/skills`, and picks up new or edited skills without a restart.

The `lib/` tooling is a plugin bundle and has to be installed into your profile. As the agent, from inside the project:

> Install the bundle at `<project>/.dsh` into this profile.

The agent does it with `plugin_manager` `action: install_bundle` and the absolute package directory as `target`. To do it by hand, quit DeepSeek Harness completely and run:

```bash
dsh plugin --profile <your-profile> add <project>/.dsh
```

Then relaunch and confirm the `quiz` tool is available to the model.

## Requirements

- DeepSeek Harness with the `standard` agent preset (or any preset that mounts `tools`, `userQuestions`, and `commands`)
- **An image-capable model for the visual makers.** `render_mermaid` / `render_svg` hand the PNG back through the attachment store, and a route that does not declare image input gets a text placeholder instead of the picture — the maker can then no longer see what it drew. The teaching and quiz flow works on any model.
- For Mermaid: the bundled `@mermaid-js/mermaid-cli` plus an installed Chrome or Chromium. Approve the package's build script when `install_bundle` reports it as pending.
- For SVG: `rsvg-convert` (librsvg), falling back to ImageMagick's `magick`.
- `md-log` writes into an Obsidian-style markdown file you already have. It never creates the file.

## Notes

You can run the system without subagents. The main session does the teaching. You just lose the researcher (truth verification) and the generated visuals.

The teaching skill is written for one learner (me). Edit the skill to fit how you learn best.

## Differences from the pi version

- **`ask_user_question` is gone.** DeepSeek Harness ships it natively, so the pi extension was dropped rather than ported.
- **No named subagents.** DSH's `subagent` tool takes `description` and `prompt`, not an agent name. The three pi agent definitions became skills, and the caller names the skill inside the prompt. Model, reasoning effort and tool restrictions are chosen on the `subagent` call itself, not in the agent file.
- **`md-log` does not remember its link across restarts.** pi persisted it as a custom session entry; a DSH plugin cannot mint durable session event types. Re-issue `/md-log <path>` in a new session.
- `md-log` mirrors `quiz` and `ask_user_question` results as plain callouts. The pi version also wrote a live "question asked" block before the user answered; that hook has no DSH equivalent.
- `md-log` writes with `node:fs`, not `ctx.fs`. DSH's mutation fence lives *inside* the `ctx.fs` service, so a note outside the workspace would be refused under `workspace-write` mode; a plugin runs in the host process and can step around it. That is a deliberate tradeoff — the mirror is meant to write into a vault you pick, wherever it lives.
- Backfill reads `session.deriveMessages()`, DSH's supported surface-projected history. After a compaction it reflects the messages the model still sees, so superseded turns are not mirrored.
