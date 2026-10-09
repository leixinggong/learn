# learn

Codex 插件市场：仓库根放市场清单 `.agents/plugins/marketplace.json`，里面发布一个插件 `learn`（`plugins/codex/`）。这个分支只跟 Codex 有关；pi 原版在 `main`，DeepSeek Harness 版在 `codex/work`。

`learn` 是教学插件：先摸底你的水平、画出依赖图、经你确认后逐个节点教学，每个节点用聊天里的选择题检查。用 `用 $learn 教我…` 触发，技能在 Codex 里显示为 `learn:learn`。

## 添加这个市场

在 Codex 的「添加插件市场」里：

- 来源：`https://github.com/leixinggong/learn.git`
- Git 引用：`codex/plugin`
- 稀疏路径：`plugins/codex`

命令行等价写法：

```bash
codex plugin marketplace add https://github.com/leixinggong/learn.git --ref codex/plugin --sparse plugins/codex
codex plugin add learn@learn
```

装完开新线程，输入 `用 $learn 教我为什么负数乘负数是正数`。

也可以直接从本地路径加：

```bash
codex plugin marketplace add /Volumes/gong/gongleixing/learn
codex plugin add learn@learn
```

## 目录

```
.agents/plugins/marketplace.json          市场清单（声明 learn → ./plugins/codex）
plugins/codex/.codex-plugin/plugin.json   插件清单
plugins/codex/skills/learn/               教学技能、可视化流程、notebook 启动器、模板
plugins/codex/assets/                     市场展示图标
tests/check_notebook.py                   启动器验收测试（保存时校验，非教学路径）
```

## 来源

插件内容转换自 [jakobtfaber/learn](https://github.com/jakobtfaber/learn) 的 `codex/learn-evolving-visuals` 分支（`codex-plugins/learn`），上游是 [amosblomqvist/learn](https://github.com/amosblomqvist/learn) 的 pi 版学习系统（视频：[How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU)）。

本分支的改动只有：抽成独立插件、补市场清单与图标、重排目录、重写 README、修正验收测试的脚本路径。教学正文与脚本未改动。

插件的能力边界、与 pi / DSH 版的差别，见 [plugins/codex/README.md](plugins/codex/README.md)。
