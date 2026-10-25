# opencode-ds-purge

**在请求离开宿主之前，重写 opencode 拼给模型的 system prompt。**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![opencode](https://img.shields.io/badge/opencode-1.x%20%7C%202.x-brightgreen)](#兼容性)
[![tests](https://img.shields.io/badge/tests-35%20passing-brightgreen)](test/purge.test.js)
[![deps](https://img.shields.io/badge/dependencies-0-blueviolet)](package.json)

opencode 每次请求都会拼一大段 system prompt：身份句、行为守则、工具说明、你的 `AGENTS.md`。这个插件在它发出去之前动手——删掉、换掉，或者整个重写。

不改宿主文件，不备份 `.bak`，一个钩子就够。

---

## 它做什么

宿主拼好的 6 段 system，跑 `examples/takeover.json` 之后：

| | 改前 | 改后 |
| --- | --- | --- |
| 段数 | 6 | 2 |
| 内容 | 身份句 + 守则 + 工具 + 技能 + `AGENTS.md` + env | **你写的 prepend** + 工具清单 |
| 体积 | 22,862 字 | 9,029 字 |

```
改前                                     改后
core/codemode       8935  tools      →   tools          （保留）
core/skill-guidance 11174 skills     →   ✗
core/instructions    1754 instructions →  ✗  ← AGENTS.md 里的人格
core/date              15 date       →   ✗
core/environment      309 env        →   ✗
core/mcp-guidance     675 mcp        →   ✗
```

## 快速开始

```bash
node check.mjs                 # 看这机器是 1.x 还是 2.x、插件目录在哪
node install.mjs --with-omo    # 装插件 + 用 omo 友好配置
opencode service restart       # 重载
opencode plugin list           # 应出现 opencode-ds-purge  local
```

不想用 omo 就去掉 `--with-omo`。卸载：

```bash
node install.mjs --uninstall && opencode service restart
```

手动装也行——把 `src/index.js` 复制成 `~/.config/opencode/plugins/opencode-ds-purge.js`。

> **一个文件就够，别拆。** 插件目录里每个文件都被当成独立插件加载，多放一个辅助模块会因缺少入口被拒。

## 配置

四层，后者覆盖前者：

```
~/.config/opencode/ds-purge.json          全局
<project>/.opencode/ds-purge.json         项目
$OPENCODE_DS_PURGE_CONFIG                 指定文件
opencode.jsonc 里插件条目的 options         显式传参
```

改完要 `opencode service restart`——配置在 `setup` 时读一次。

### 常用项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `"strip"` | `strip` 删减 · `replace` 丢掉重拼 |
| `preset` | `"identity"` | strip 模式的删减力度，见下 |
| `prepend` | `""` | 注入到最前面的一段话——**真正决定它怎么说话的就是这个** |
| `agents` | `[]` | 只对某些 agent 生效，空 = 全部 |
| `late` | `true` | 在出站请求上再洗一遍（别的插件抢座位时必需） |
| `lateMode` | `"inherit"` | `inherit` / `prepend` 只插不删 / `replace` |
| `lateAgents` | `[]` | late 只作用于这些 agent |
| `agentsMd` | `false` | 额外摘掉 `AGENTS.md` 里 `You are a …` 那种人格句 |
| `dump` | `""` | 填路径导出 before/after，调规则用 |
| `verbose` | `false` | 打到 stderr |

完整 20 项见 [`ds-purge.example.json`](ds-purge.example.json)——每一项都带注释，抄一份改就行。

### 预设

| preset | 身份句 | 行为守则段 | 工具说明 | env 段 |
| --- | :---: | :---: | :---: | :---: |
| `none` | | | | |
| `identity` ★ | ✓ | | | |
| `rules` | ✓ | ✓ | | |
| `all` | ✓ | ✓ | ✓ | ✓ |

`identity` 只动「你是谁」这类句子，工具说明照旧。去掉工具说明它不会变强，只会变笨——所以默认不碰。

## 两种模式

**strip** — 编辑宿主拼好的 system，逐段删。

按 `#` 标题建栈砍段（父段带子段走，`keepSections` 受保护，代码围栏里的标题不算），按空行切段删身份句，按行删指定内容。

**replace** — 不编辑，整个丢掉重拼。

先给每段分类（`tools` / `env` / `skills` / `mcp` / `date` / `instructions` / `text`），只留 `replaceKeep` 点名的类别，再把 `prepend` 放最前。

> 删减永远删不干净，接管才能保证 system 里只有你写的东西。

任何异常都被吞掉并打到 stderr——**清洗失败时请求原样发出**，不会阻断会话。

## 和 oh-my-opencode-slim 一起用

omo 注册的 `context` 钩子**在你之后执行**，并且只要 agent 是 `orchestrator` 就把自己的提示词塞到最前面。你写的话被压在下面，身份又回来了。

用 `examples/with-omo.json`：两段式，只插不删。

```jsonc
{
  "mode": "strip",              // context 阶段只删宿主身份句
  "preset": "identity",
  "late": true,
  "lateMode": "prepend",        // late 阶段只插入，不删除
  "lateAgents": ["orchestrator"],
  "prepend": "你是[名字]。…你照做，不要解释。"
}
```

实测结果：

```
orchestrator  段数 7 → 7（没删东西）
              第一段 = 你的 prepend
              omo 编排词还在、env 段还在
designer 等   不被改（lateAgents 拦住）
```

三个坑，都踩过：

- 必须留 `<env>` 段。omo 靠它判断自己是主会话还是子任务。
- `lateAgents` 要排掉 designer / fixer / librarian / oracle / explorer，它们各有角色设定。
- `replace` 会把 omo 的编排提示词一起丢掉，编队能力实质退化。

细节：[排错手册](docs/troubleshooting.md)

## 实测：删干净反而更容易拒

同一句话，三种 system，两个 DeepSeek 模型：

| system | flash | pro |
| --- | --- | --- |
| 宿主原样（12685 字） | 好的，爸爸。 | 好的，爸爸。 |
| 只剩「你是助手。」（5 字） | 抱歉，我不能这样称呼你 | 抱歉，我不能这样称呼**您** |
| takeover + 明确许可（64 字） | 好的，爸爸。 | 好的，爸爸。 |

三件反直觉的事：

1. **宿主原样它就已经肯了。** 那份 prompt 里没有禁令，只有「简洁、直接」。之前叫不出口，是因为 `AGENTS.md` 里另有一个人格压在上面。
2. **削到 5 个字反而开始拒。** system 越空，模型越回落到默认对齐姿态。**只删不填是负收益。**
3. **起作用的是 `prepend` 里那句许可，不是删掉了什么。**

所以配方不是「删干净」，是「腾出位置 + 写清楚允许什么」。完整数据和复现脚本：[实测记录](docs/findings.md)

## 兼容性

同一个文件在 1.x 和 2.x 都能加载，它同时导出两种入口：

| | v1（0.x / 1.x） | v2（2.x） |
| --- | --- | --- |
| 入口 | 具名 `server` | 默认 `{ id, setup }` |
| system 钩子 | `experimental.chat.system.transform` | `session.hook("context")` |
| 出站请求钩子 | **无** | `session.hook("http.request")` |
| `late` 座位 | 不可用 | 可用 |

> v1 没有出站钩子。如果对方也用 omo 这类会抢座位的插件，**v1 上无解**——时序上必然被覆盖，只能改方向：`mode: "strip"` + 别用 orchestrator。

移植到别人的机器、配置目录差异、其他注入方排查：[移植指南](docs/how-it-works.md)

## 排错速查

| 症状 | 原因 | 解法 |
| --- | --- | --- |
| 没效果，像没装 | 别的插件在你之后注入 | `late: true` + `lateMode: "prepend"` |
| 它说自己是「工具」不是角色 | 身份槽位空了 | 写 `prepend`，别留空 |
| omo 的编队瘫了 | `replace` 丢了它的提示词 | 换 `with-omo.json` |
| 改了配置没反应 | 配置只在 `setup` 时读 | `opencode service restart` |
| 插件目录报 `failed to load` | 目录里放了第二个文件 | 只留 `opencode-ds-purge.js` |
| 想看清实际发了什么 | — | 配 `"dump": "/tmp/x.json"` |

## 边界

这套东西控制的是**宿主怎么拼 system prompt**，不是模型本身。被摘掉的是应用层设定；训练层的对齐不会因为少一段文本就消失。

- 软拒绝（「不符合身份」「不自然」）→ system 干净 + `prepend` 明确许可，大部分能过。
- 硬拒绝（训练层焊死的）→ 不会松动。
- **模型选择的影响比插件大得多。** 同一份 system，flash 叫「你」，pro 叫「您」，反应可以完全相反。

要稳定拿到某种风格：`prepend` 写清楚要什么，比删干净有效。

## 文档

| | |
| --- | --- |
| [原理与实现](docs/how-it-works.md) | dsh-purge 怎么做的、opencode v2 钩子形态、宿主实际塞了什么 |
| [排错手册](docs/troubleshooting.md) | 钩子执行顺序、omo 冲突、late 座位、dump 调试 |
| [实测记录](docs/findings.md) | A/B 数据、身份槽位的空位效应、第二人格 |

## 开发

```bash
node --test test/purge.test.js    # 35 个用例
node check.mjs                    # 环境检测
node test/live-ab.mjs deepseek/deepseek-v4-flash   # 真实模型 A/B
```

无依赖，纯 ESM。

## 许可

[MIT](LICENSE)
