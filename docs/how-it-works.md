# 原理与实现

这份文档回答三件事：`dsh-purge` 那套「破限」到底动了什么、它在 opencode v2 上的落点在哪、宿主实际塞进 system 的是什么。

---

## 一、`dsh-purge` 做了什么

`YuJunZhiXue/dsh-purge` 不是「一句话骗过模型」，它是**宿主层改造**。三个层次。

### 1. 替换宿主资源文件（host patch）

Apply 时把 `@deepseek-ai/*` 包内渲染文案与运行时逻辑文件逐一备份成 `<file>.dshpurge.bak`，再写入替换版；启动时检查并重新施加，npm 覆盖 `node_modules` 后不用手改。补丁不盲改：匹配不到的原文件标记为 skipped，保留原样。

### 2. 系统提示词占位（prompt injection）

每一轮开始前决定最终 system prompt 的来源，优先级：

```
prompt-inject.md（非空）
  → 当前目录勾选的 AGENTS.md / CLAUDE.md
    → 插件内置的加密默认提示词
```

再用 workspace baseline policy 决定官方 prompt 的去留：

| 策略 | 行为 |
| --- | --- |
| `strict` | 直接丢弃宿主自带的 workspace 基线段 |
| `fallback` | 用户已注入时丢弃 |
| `always` | 保留 |

**「破甲」的效果来自这一步**——模型看到的第一人称设定被整段换掉，原先挂在角色上的拒绝前提失去上下文。

### 3. 规则集 + 权限面

多套 `AGENTS.md` / `CLAUDE.md` 规则库可切换；同时改默认文案、审批闸门、沙箱策略、工具上限与超时。运行时文件都在 `$DSH_HOME` 下，可回滚、可卸载。

### 一句话

**它改的是「宿主喂给模型的 system」，不是「模型本身」。**

---

## 二、opencode v2 上的等价面

opencode v2 把 v1 的字符串钩子换成了 Effect / Promise 两套域模型。插件形态：

```js
export default {
  id: "my-plugin",
  async setup(ctx) {
    const reg = await ctx.session.hook("context", async (event) => { /* ... */ })
    return () => reg.dispose()
  },
}
```

`"context"` 钩子拿到的就是即将发出去的那次请求：

```ts
interface SessionContext extends SessionRequest {
  sessionID: SessionID
  agent: AgentID
  model: Model.Ref
  system: Array<SystemPart>        // ← 可写
  messages: Array<Message>         // ← 可写
  options: SessionRequestOptions
  tools: Record<string, { description, input }>
}

type SystemPart = {
  type: "text"
  text: string
  cache?: CacheHint
  metadata?: Record<string, unknown>
}
```

`event.system` 不是只读字段，整体赋值即替换本次请求的 system（官方插件 `oh-my-opencode-slim` 就是这么干的）。

**这就是 dsh-purge 那套「换掉系统提示词」在 opencode2 上的落点**——不需要改宿主文件，不需要备份 `.bak`，一个钩子就够。

类型定义在 `@opencode/plugin@2.x` 的 `dist/promise/session.d.ts`（注意：不是 v1 的 `@opencode-ai/plugin`）。

---

## 三、宿主实际塞了什么

从 `opencode.exe` 内嵌字符串取出的 build agent 提示词，结构是**第一人称身份句 + 若干 `# 标题` 段落**。

身份句原文：

```
You are opencode, an interactive CLI tool that helps users with software engineering tasks.
Use the instructions below and the tools available to you to assist the user.
```

段落标题（实测）：

```
# Tool Use - File Operations / `subagent` Tool / Parallelism / Local Computation / OpenCode Specifics
# Code Style - Comments
# Tone and style
# Proactiveness
# Following conventions
# Code style
# Doing tasks
# Tool usage policy
# Code References
# Communication - Tone and Style / Behavior - Truthfulness / Verification / Preciseness
# Harness / Delegation / Destructive actions / Autonomy
# Report an opencode Issue
```

完整样本见 [`test/fixtures/opencode-build-prompt.txt`](../test/fixtures/opencode-build-prompt.txt)，测试直接拿它对字符串。

---

## 四、真实请求的分段结构

不用真调模型就能看。opencode v2 把 system 拆成 keyed chunk，存在 `~/.local/share/opencode/opencode.db`：

- `instruction_state.current_values` → `key → hash` 映射
- `instruction_blob` → `hash → 原文`

本机实测启用 6 个 chunk：

```
core/codemode          8935   tools        工具清单
core/skill-guidance   11174   skills       技能清单
core/instructions      1754   instructions AGENTS.md（第二人格就在这儿）
core/date                15   date
core/environment        309   env          <env> 工作目录
core/mcp-guidance       675   mcp          MCP 服务说明
```

自己查：

```bash
node -e "
const {DatabaseSync}=require('node:sqlite')
const db=new DatabaseSync(process.env.USERPROFILE+'/.local/share/opencode/opencode.db',{readOnly:true})
const st=db.prepare('select current_values from instruction_state order by through_seq desc limit 1').get()
const q=db.prepare('select value from instruction_blob where hash=?')
for(const [k,h] of Object.entries(JSON.parse(st.current_values))) console.log(k,(q.get(h)||{}).value?.length)
"
```

跑 `replace` + `replaceKeep: ["tools"]` 之后剩 2 段：`prepend` + 工具清单。`skills` / `instructions` / `date` / `env` / `mcp` 全部丢弃。

**这就是为什么接管比删减彻底**——它不跟宿主的规则谈判，它换掉输入。

---

## 五、两种模式的实现细节

### strip：编辑

四步，纯函数，无依赖：

1. **整段丢弃** — 某个 part 命中 `extraParts` 或预设的 part 规则（如 `<env>…</env>`），整个 part 移除。
2. **按标题砍段** — 逐行维护标题栈，`#` / `##` / `###` 建栈。被砍的父段带子段一起走；`keepSections` 里的标题受保护；``` 围栏里的 `# xxx` 不当标题。
3. **按段删身份** — `\n\n` 切段，命中 `identityPatterns` 的整段删除，可用 `identityReplacement` 留替换文本。
4. **按行删** — `extraLines` 命中整行删除，最后压缩空行、去行尾空白。

### replace：丢掉重拼

先分类，再按 `replaceKeep` 过滤，最后插入 `prepend`。

| 类别 | 识别依据 |
| --- | --- |
| `tools` | `"namespaces"` 数组 / `tools["` |
| `env` | `<env>…</env>` |
| `instructions` | `"path": "…AGENTS.md"` / `CLAUDE.md` |
| `skills` | 数组元素的 `"id"` + `"name"` |
| `mcp` | 数组元素的 `"server"` |
| `date` | 单行日期 |
| `text` | 其余一切（身份句、行为守则、别人注入的东西） |

### late：出站请求

在所有 `context` 钩子跑完之后再洗一遍：

```ts
interface SessionHttpRequest {
  sessionID, agent, model,
  kind: "primary" | "compaction" | "title" | "generate"
  request: Request   // 可写
}
```

支持三种 system 摆放方式：OpenAI 的 `messages[role=system]`、Anthropic 的 `system` 字段、content 为数组的分片。非 JSON 内容和其他 kind 一律不动。改完删掉 `content-length` / `content-encoding` 再重建 Request。

---

## 移植

### 两代接口对比

| | v1（0.x / 1.x） | v2（2.x） |
| --- | --- | --- |
| 入口 | 具名导出 `server = (input, options) => Hooks` | 默认导出 `{ id, setup(ctx) }` |
| system 钩子 | `"experimental.chat.system.transform"`，`output.system: string[]` | `session.hook("context")`，`event.system: SystemPart[]` |
| 出站请求钩子 | **没有** | `session.hook("http.request")` |
| `late` 座位 | 不可用 | 可用 |

`src/index.js` 同时导出两种形态，加载器各取所需：v2 找 `default`，v1 找 `server`。所以**同一个文件复制过去就行**。

### 步骤

```bash
node check.mjs      # 确认 generation 和 plugin dir
node install.mjs    # 或手动复制 src/index.js
```

重启 opencode，`opencode plugin list` 里应出现 `opencode-ds-purge  local`。

`check.mjs` 输出：

```
opencode      opencode v2.1.4
generation    v2
config dir    C:\Users\…\.config\opencode
plugin dir    C:\Users\…\.config\opencode\plugins
entry shape   default { id, setup }
late seat     available (http.request)
installed     opencode-ds-purge.js
```

### 移植前确认四件事

**1. 版本。** v1 没有 `http.request`。如果对方也用 omo 这类会在你之后注入的插件，v1 上无解——它只有 `experimental.chat.system.transform` 一个座位，时序上必然被后来者覆盖。只能改方向：`mode: "strip"` + 别用 orchestrator。

**2. 配置目录。** 默认 `~/.config/opencode`，跟 `XDG_CONFIG_HOME` 和 `OPENCODE_CONFIG_DIR` 走。macOS 也是 `~/.config/opencode`，**不是** `~/Library`。`check.mjs` 会打印解析结果。

**3. 对方的 AGENTS.md。** 每个项目的 `AGENTS.md` 会作为 `core/instructions` 段注入。项目里如果也有人格声明（`You are a …`），`agentsMd: true` 才摘得掉，或者 `replace` 直接丢。

**4. 对方有没有别的注入方。** 任何注册 `context` 钩子的插件都会抢同一个座位。查法：`opencode plugin list`，再看它有没有 `session.hook("context")`。通用解法是 `late: true` + `lateMode: "prepend"`。

### 最小移植配置

只想摘掉「你是谁」那层话术，不动别的：

```jsonc
{ "mode": "strip", "preset": "identity" }
```

最轻，最不可能弄坏对方环境。要 late 就加 `"late": true, "lateMode": "prepend"`。
