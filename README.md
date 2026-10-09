# learn — Codex plugin

learn 教学系统的 **Codex 原生插件**。这个仓库分支就是插件本身：`.codex-plugin/plugin.json` + `skills/learn/`。

装完在 Codex 里输入 `用 $learn 教我…` 触发。它先摸底你的水平、画出依赖图、经你确认后逐个节点教学，每个节点用聊天里的选择题检查。技能在 Codex 里显示为 `learn:learn`（别名 `$learn`）。

这个分支只放 Codex 插件；pi 原版在 `main`，DeepSeek Harness 版在 `codex/work`。

## 安装

```bash
codex plugin marketplace add /Volumes/gong/gongleixing/codex-marketplace
codex plugin add learn@codex-marketplace
```

或直接把这个仓库作为市场源（`source: git-subdir`，`path: "./"`）。

## 目录

```
.codex-plugin/plugin.json                      Codex 插件清单
skills/learn/SKILL.md                          教学技能：哲学 + probe → plan → teach
skills/learn/references/visual-lessons.md      可视化课程流程（Mermaid/SVG/notebook/浏览器演示）
skills/learn/scripts/notebook.py(+.lock)       课程 notebook 启动器（--init / --check / --open）
skills/learn/assets/lesson.ipynb               notebook 模板（黑板结构）
assets/icon.png · icon.svg                     市场展示图标
tests/check_notebook.py                        启动器验收测试（保存时校验，非教学路径）
```

## 来源

教学正文与脚本来自 [jakobtfaber/learn](https://github.com/jakobtfaber/learn) 的 `codex/learn-evolving-visuals` 分支（`codex-plugins/learn`），上游是 [amosblomqvist/learn](https://github.com/amosblomqvist/learn) 的 pi 版学习系统（视频：[How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU)）。

本分支的改动只有：抽成独立插件（清单补图标与关键词）、重排目录、重写本 README、修正验收测试的脚本路径。教学正文未改动。

## 能力边界

- **出题在对话里完成**：没有 `quiz` / `ask_user_question` 工具，也没有 pi 版的答题卡片、按钮或客户端即时判分。多选必须完全答对才算对；“我不知道”和不作答与答错分开处理。
- **偏好类问题**走 Codex 自带的输入工具（有限制时就在聊天里问），不当作判分界面用。
- **研究**用 Codex 自带的联网检索；本插件不内置 Exa/Tavily 之类搜索服务，不读取凭据，也不新增 MCP 服务。
- **可视化课程**：notebook 路径需要 Python ≥3.11，用 `uv run --locked skills/learn/scripts/notebook.py <lesson.ipynb> --init|--check|--open`；`--check` 在全新内核里执行，产物写到 `.learn-checks/`，不会覆盖你的 notebook。缺 uv 或相关依赖时，技能退回到纯对话讲解。

## 与 pi / DSH 版的差别

| | pi / DSH 版 | 本 Codex 版 |
| --- | --- | --- |
| 出题 | `quiz` 工具（宿主画卡片、即时判分） | 聊天里的选择题，回复后判分 |
| 笔记镜像 | `/md-log`、`/md-unlog` | 无（会话即进度） |
| 视觉工具 | `write_mermaid` / `render_mermaid` / `write_svg` / `render_svg` | notebook / Mermaid 源码 / 浏览器演示，按技能流程手工产出 |
| 子代理 | 派发 researcher / mermaid-maker / svg-maker | 用 Codex 自己的子代理或本地完成 |
