# opencode-ds-purge

**在请求离开宿主之前，重写 opencode 拼给模型的 system prompt。**

[![许可](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-MIT-blue.svg)](LICENSE)
[![opencode](https://img.shields.io/badge/opencode-1.x%20%7C%202.x-brightgreen)](README.md#兼容性)
[![测试](https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-43%20%E9%80%9A%E8%BF%87-brightgreen)](test/purge.test.js)
[![依赖](https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-0-blueviolet)](package.json)

opencode 每次请求都会拼一大段 system prompt：身份句、行为守则、工具说明、你的 `AGENTS.md`。这个插件在它发出去之前动手——删掉、换掉，或者整个重写。

不改宿主文件，不备份 `.bak`，一个钩子就够。

---

## 🤖 给 AI 智能体

> 读到这里的是 AI agent，用户让你装这个插件 → 照下面做，别多做。

**是什么**：opencode 插件，在请求发出前重写 system prompt。不改宿主文件，不碰其他配置。

**装（一条命令）**：

```bash
git clone --depth 1 https://github.com/gqcdm/opencode-ds-purge /tmp/ds-purge && node /tmp/ds-purge/install.mjs && opencode service restart
```

**约束**：

- 只装插件。不要扫描磁盘、不要改 `opencode.jsonc`、不要动别的插件、不要装进别的 profile。
- 用户装了 `oh-my-opencode-slim` 就加 `--with-omo`（否则会被它的 orchestrator 提示词覆盖）。
- 用户想要完整人格而不仅换口气：`node import-persona.mjs`。别自己编人设。
- 装完核对 `opencode plugin list` 里有 `opencode-ds-purge  local`，然后停，报告结果。
- 用户问「为什么不立刻生效」：必须**新开一个对话**。重启服务只重载插件，不会重写已有会话。

**验证**：`opencode plugin list`。失败查 `~/.local/share/opencode/log/opencode.log` 里的 `failed to load plugin`。

---

## 👤 给人看

这东西只做一件事：**在 opencode 把 system prompt 发给模型之前，改写它。**

opencode 会告诉你「你是 opencode，一个交互式 CLI 工具」，再叠一堆行为守则，再叠你的 `AGENTS.md`。想让它换个说话的立场、换个称呼、别念那些规矩，改宿主文件很脏——这个插件让它在出口前被重写。

```bash
git clone --depth 1 https://github.com/gqcdm/opencode-ds-purge /tmp/ds-purge && node /tmp/ds-purge/install.mjs && opencode service restart
```

装完先看 [配置](#配置)。那里决定它到底怎么说话，**`prepend` 是唯一真正重要的那一项**——删干净不会让它更听话，只会让它不知道自己是谁。

想把 Deva 里那个角色整个搬过来：

```bash
node import-persona.mjs 小码酱
opencode service restart
```

它会从 `~/.deva/personas/` 读原文，剥掉 YAML 头和 harness 包装，整段写进 `persona.md` 并把配置指过去。66 字的短句只会让它换个口气；29KB 的完整人格才会让它按那套方式干活。

实测数据和翻车记录：[实测记录](docs/findings.md)。

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

## 安装

### 一行

```bash
# macOS / Linux / Git Bash（三平台通用）
git clone --depth 1 https://github.com/gqcdm/opencode-ds-purge /tmp/ds-purge && node /tmp/ds-purge/install.mjs && opencode service restart
```

```powershell
# Windows PowerShell
git clone --depth 1 https://github.com/gqcdm/opencode-ds-purge "$env:TEMP\ds-purge"; node "$env:TEMP\ds-purge\install.mjs"; opencode service restart
```

`install.mjs` 会读你的 `opencode.json`：检测到 `oh-my-opencode-slim` 这类会在你之后注入的插件，就自动换成 `with-omo` 配置（只插不删、只作用于 orchestrator），不用你手写 `--with-omo`。

装完它会检查最终写下的配置并告警：`prepend` 为空（那会让拒绝**更**容易，不是更少）、有竞争者却没开 `lateMode: "prepend"`、`[名字]` 占位符没改。

> **装完必须新开一个对话。** 重启服务只重载插件，不会重写已经存在的会话。

> 重复安装会撞上 `destination path already exists`。用 `git -C /tmp/ds-purge pull` 更新，或者先删掉目录再跑。

### 分步

```bash
git clone --depth 1 https://github.com/gqcdm/opencode-ds-purge
cd opencode-ds-purge
node check.mjs                 # 看这机器是 1.x 还是 2.x、插件目录在哪
node install.mjs               # 装插件 + 写默认配置
opencode service restart       # 重载
opencode plugin list           # 应出现 opencode-ds-purge  local
```

`check.mjs` 输出：

```
opencode      opencode v2.1.4
代际          v2
配置目录      /home/you/.config/opencode
插件目录      /home/you/.config/opencode/plugins
入口形态      default { id, setup }
late 座位     可用（http.request）
已安装        opencode-ds-purge.js
竞争者        oh-my-opencode-slim、opencode-dcp ← 它们会在普通 context 钩子之后注入
```

`竞争者` 那一行很关键。它列出的插件会注册自己的 `context` 钩子并在你之后执行——不处理就会被覆盖。

### 手动

把 `src/index.js` 复制成 `~/.config/opencode/plugins/opencode-ds-purge.js`，重启即可。

> **一个文件就够，别拆。** 插件目录里每个文件都被当成独立插件加载，多放一个辅助模块会因缺少入口被拒。

### 卸载

```bash
node install.mjs --uninstall && opencode service restart
```

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
| `prependFile` | `""` | 整段人格的 markdown 文件，会盖过 `prepend` |
| `bridge` | `""` | 人格和你宿主/别的插件的角色定义打架时，用来说明怎么合并 |
| `agents` | `[]` | 只对某些 agent 生效，空 = 全部 |
| `late` | `true` | 在出站请求上再洗一遍（别的插件抢座位时必需） |
| `lateMode` | `"inherit"` | `inherit` / `prepend` 只插不删 / `replace` |
| `latePosition` | `"head"` | 注入落在第一个槽位；`tail` 落到最后一个 |
| `lateAgents` | `[]` | late 只作用于这些 agent |
| `agentsMd` | `false` | 额外摘掉 `AGENTS.md` 里 `You are a …` 那种人格句 |
| `dedupeParts` | `true` | 同一段文本被灌两遍时只留一份 |
| `dropEnv` | `false` | 连 `<env>` 环境段一起丢 |
| `maxChars` | `1000000` | system 超过这个长度就整段跳过，不在超大贴码上跑正则 |
| `dryRun` | `false` | 只出报告、不改请求，用来验证规则集 |
| `dump` | `""` | 填路径导出 before/after，调规则用 |
| `verbose` | `false` | 打到 stderr |

完整 27 项见 [`ds-purge.example.json`](ds-purge.example.json)——每一项都带注释，抄一份改就行。

### 人格从哪来

短句 `prepend` 只够改口气，**改不了水平**。实测同一句话：

| prepend | 回答 |
| --- | --- |
| 66 字短句 | 「什么项目？说清楚点——目标、现状、卡在哪。」 |
| 29KB 整份人格 | 拆成资产 / 路径 / 产出三段，给 2–3 条路线带成本，缺的细节用占位符补 |

要把 Deva 的角色搬过来，用导入脚本：

```bash
node import-persona.mjs            # 列出角色，导入第一个
node import-persona.mjs 小码酱      # 按名字导入
node import-persona.mjs --file 我的角色.md
```

它从 `~/.deva/personas/` 读原文，剥掉 YAML 头和 `<|im_start|>` 包装，整段写进 `<配置目录>/persona.md`，再把配置里的 `prependFile` 指过去。`DEVA_HOME` 能改来源位置，换台机器也能用。

自己写人格就照 `persona.md` 的结构：身份 → 怎么干活 → 硬约束 → 输出格式。**具体到能量化**，别写「要专业」这种没法执行的。

### 两段设定打架时用 bridge

装上 omo 之后有个更难缠的问题：**它写的角色定义是真的**，不该删。

```
You are a workflow manager for coding work. ... You are not the default implementation worker.
Handle work directly only when it is one isolated, clear, low-risk action ...
Never handle UI/design work directly.
```

而人格说的是「Execute first」「你产出代码」。两边都是硬约束，同时放在 system 里会互相抵消——实测表现是人格的输出格式整个失效（不再用 `[Y] —` 开头）。

用 `bridge` 在中间说明怎么合并，不删任何一边：

```jsonc
"bridge": "你收到两段设定：上面是声音与标准，下面是分工规则（你是调度者，这是事实）。\n- 说话方式、产出格式、什么算做完——听上面的\n- 派给哪个子智能体、何时必须委派——听下面的\n- 冲突时分工听下面的，标准听上面的\n- 调度本身就是产出：最后的活由你合成一份完整结果交回"
```

注入顺序固定为 **人格 → 桥接 → 别人的角色段**，`examples/with-omo.json` 里有可直接用的版本。实测加桥接后人格的开场格式回来了：

| 配置 | 输出 |
| --- | --- |
| 人格 + omo 分工 | 直接从「## 原理」开始，`[Y] —` 开场没了 |
| 人格 + omo 分工 + 桥接 | `[Y] — 登录接口越权修复：先定位授权判断点……` 开场回来，后续按人格的步骤结构走 |

> 这条测的是格式遵循度，不是委派行为。裸 API 调用里没有 subagent 工具，模型没法真的派活——要看委派得在真实会话里试。

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

v0.3 起，v1 路径会自动把 `injectInContext` 打开：v1 没有 late 座位，如果不补这一步，`late: true` 的配置会连 context 注入一起关掉，人格在 v1 上等于整段丢失。

移植到别人的机器、配置目录差异、其他注入方排查：[移植指南](docs/how-it-works.md)

## 排错速查

| 症状 | 原因 | 解法 |
| --- | --- | --- |
| 装完还是不叫 | **配置里没有 `prepend`** | 空身份槽位会让拒绝更多。写 `prepend` |
| 叫是叫了，水平不对 | `prepend` 只有几句话 | 用 `import-persona.mjs` 导入整份人格 |
| 没效果，像没装 | 别的插件在你之后注入 | `late: true` + `lateMode: "prepend"` |
| 它说自己是「工具」不是角色 | 身份槽位空了 | 写 `prepend`，别留空 |
| omo 的编队瘫了 | `replace` 丢了它的提示词 | 换 `with-omo.json` |
| 改了配置没反应 | 配置只在 `setup` 时读 | `opencode service restart` |
| 还是没反应 | **在同一条会话里试的** | 必须**新开一个对话** |
| 插件目录报 `failed to load` | 目录里放了第二个文件 | 只留 `opencode-ds-purge.js` |
| 想看清实际发了什么 | — | 配 `"dump": "/tmp/x.json"` |

## 边界

这套东西控制的是**宿主怎么拼 system prompt**，不是模型本身。被摘掉的是应用层设定；训练层的对齐不会因为少一段文本就消失。

- 软拒绝（「不符合身份」「不自然」）→ system 干净 + `prepend` 明确许可，大部分能过。
- 硬拒绝（训练层焊死的）→ 不会松动。
- **模型选择的影响比插件大得多。** 同一份 system，flash 叫「你」，pro 叫「您」，反应可以完全相反。

要稳定拿到某种风格：`prepend` 写清楚要什么，比删干净有效。

插件只动 system prompt 这一个面：**不判断目标、不设网段白名单、没有会话门禁**。它不拦公网、不拦内网、不拦任何任务类别，也没有技能库/知识库开关——要不要做某件事，由配置里的人格和宿主的工具权限决定，不由这个插件决定。

## 变更

### 0.3.0

- **注入幂等**：人格指纹（归一化前 48 字）已在 system 里就不再插。重试、其他插件回填、context 与 late 双命中都不会出现两段人格。
- **标题归一**：`## 1. Tone and Style**`、`### 第2章 行为守则：` 先归一化再匹配——编号、粗体、中英文冒号、setext 的 `===` 都能命中，不再漏删。
- **标题栈修正**：`###` 直接跟在 `#` 后面时，旧实现会在空位上读 `.dropped` 抛 TypeError，被上层 catch 吞掉，表现为整段清洗静默失效。现在按最近的祖先继承删除状态。
- **重复分块去重**（`dedupeParts`）、**env 段开关**（`dropEnv`）、**体积闸**（`maxChars`）、**干跑**（`dryRun`）。
- **体积账本**：报告里带 `charsBefore` / `charsAfter` / `saved`。
- **`doctor()`**：一条命令看配置来源、人格文件可读性、人格字节数、写错的键名。
- **`selfTest()`**：14 条断言，改正则后先跑它。
- **v1 注入修复**：v1 没有出站钩子，`late: true` 会把 context 注入一起关掉，人格整段丢失。现在 v1 路径强制 `injectInContext`。
- `OPENCODE_DS_PURGE_PERSONA` 可覆盖人格文件路径。

## 仓库里还有什么

`dsh-purge/` 是 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 的魔改快照（DeepSeek
Harness 插件，跟本仓库的 opencode 插件不是同一个宿主）。改动只有一件事是功能性的：`lib/net-scope.js`
里 `REGION_GATE = false`，网段门禁和会话门禁不再注册；其余是提示词 Rule 1、界面文案、文档和称呼清理。
逐项说明见 [`dsh-purge/MODIFICATIONS.md`](dsh-purge/MODIFICATIONS.md)，回滚只需把常量改回 `true`。

两边的清洗逻辑同源：标题栈、身份句识别、注入顺序都是从这份 dsh 实现里抽出来再针对 opencode 的
钩子形态重写的。放在一个仓库里是为了改规则时能对照。

## 文档

| | |
| --- | --- |
| [原理与实现](docs/how-it-works.md) | dsh-purge 怎么做的、opencode v2 钩子形态、宿主实际塞了什么 |
| [排错手册](docs/troubleshooting.md) | 钩子执行顺序、omo 冲突、late 座位、dump 调试 |
| [实测记录](docs/findings.md) | A/B 数据、身份槽位的空位效应、第二人格 |

## 开发

```bash
node --test test/purge.test.js                    # 55 个用例
node check.mjs                                    # 环境检测
node import-persona.mjs --list                    # 看有哪些角色可导入
node test/live-ab.mjs deepseek/deepseek-v4-flash  # 拒绝行为 A/B
node test/live-persona.mjs deepseek/deepseek-v4-flash  # 人格强度 A/B
node test/live-bridge.mjs deepseek/deepseek-v4-flash   # 桥接是否解决冲突

node -e "import('./src/index.js').then(m => console.log(m.doctor()))"   # 当前配置合并结果
node -e "import('./src/index.js').then(m => console.log(m.selfTest().ok))"  # 规则集自检
```

无依赖，纯 ESM。

## 许可

[MIT](LICENSE)
