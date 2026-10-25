# 排错手册

插件最常见的失效原因不是规则写得不对，是**座位问题**——你在它前面写，别人在你后面改。

---

## 一、先看插件有没有被加载

```bash
opencode plugin list
```

应出现：

```
opencode-ds-purge    local    C:\Users\…\.config\opencode\plugins\opencode-ds-purge.js
```

没有的话看日志：

```bash
# Windows
Select-String -Path "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern "loading plugin|failed to load"
```

```bash
# macOS / Linux
grep -E "loading plugin|failed to load" ~/.local/share/opencode/log/opencode.log | tail -20
```

### 常见加载失败

**`failed to load plugin` + 目录里出现了辅助文件名**

插件目录里**每个文件都被当成独立插件加载**。多放一个辅助模块，它没有 `{id, setup}` 或 `server` 导出就会被拒：

```
failed to load plugin  target="…\plugins\opencode-ds-purge.compat.js"
```

解法：只留 `opencode-ds-purge.js`，不要拆文件。

**配置改完没反应**

配置只在 `setup` 时读一次。改完必须：

```bash
opencode service restart
```

---

## 二、装了但不生效：钩子执行顺序

同一个事件上注册的钩子**按加载顺序依次执行**。本地插件目录先于 `plugins` 配置数组里的 npm 包加载。

本机实测时间戳：

```
16:03:43.941  opencode-ds-purge        ← context 钩子先注册
16:03:43.943  opencode-dcp
16:03:43.945  oh-my-opencode-slim      ← 后注册，后执行
16:03:43.947  opencode-feishu-plugin
```

**omo 在最后两个位置之一，它改的东西覆盖你。**

### omo 具体干了什么

`oh-my-opencode-slim/dist/index.js` 里的 `experimental.chat.system.transform`：

```js
"experimental.chat.system.transform": async (input, output) => {
  const isOrchestratorRequest = requestAgent === "orchestrator" // …
  if (isOrchestratorRequest) {
    output.system[0] = orchestratorPrompt + "\n\n" + output.system[0]
  }
  collapseSystemInPlace(output.system)   // 顺手把所有段拼成一段
}
```

只要 agent 是 `orchestrator`，它就把自己的调度者提示词插到 **system 最前面**——你写的那句被压在下面，身份又回来了。

这跟规则狠不狠无关。**你在 `context` 阶段写，它在后面改。**

---

## 三、解法一：late 座位

`http.request` 拿到的是**已经拼好的出站请求**，所有 `context` 钩子都跑完之后：

```ts
interface SessionHttpRequest {
  sessionID, agent, model,
  kind: "primary" | "compaction" | "title" | "generate"
  request: Request   // 可写
}
```

```jsonc
{ "late": true, "lateKinds": ["primary"] }
```

`late` 默认开着。它支持三种 system 摆放：OpenAI 的 `messages[role=system]`、Anthropic 的 `system` 字段、content 数组分片。非 JSON 内容、其他 kind 一律不动。

> **v1 没有这个钩子。** 1.x 只有 `experimental.chat.system.transform`，被覆盖就无解。

---

## 四、解法二：不破坏 omo 的姿势

`mode: "replace"` 会把 omo 的 orchestrator 提示词、designer / fixer 的角色设定一起丢掉——编队能力实质退化。

用 [`examples/with-omo.json`](../examples/with-omo.json)：两段式。

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

实测（真实 6 段 system + 一段 omo orchestrator 提示词）：

```
orchestrator 主会话   段数 7 → 7（没删东西）
                      第一段开头 = 你的 prepend
                      omo 编排词还在: true
                      env 段还在: true
designer 子智能体      被改了吗: 否（lateAgents 拦住）
```

### 三个必踩的坑

**必须留 `<env>` 段。** omo 的 `looksLikeMainChatRequest()` 靠 system 里有没有 `<env>` 或 `You are powered by` 判断自己是不是主会话：

```js
function looksLikeMainChatRequest(system2) {
  return system2.some((e) => typeof e === "string" && (e.includes("<env>") || e.includes("You are powered by")))
}
```

删了它，omo 会把主会话当子任务处理。所以 `extraParts` 别加 env 规则。

**`lateAgents` 要排掉子智能体。** 本机会话表实测的 agent id：

```
agent=orchestrator   parent=-             ← 主会话
agent=designer       parent=ses_f312c464  ← 子智能体
agent=fixer          parent=ses_f312c464
agent=librarian      parent=ses_f312c464
```

designer / fixer / librarian / oracle / explorer 各有自己的角色设定，换掉就没专业分工了。

**`replace` 会丢 omo 的编排提示词。** 想两全就用 `lateMode: "prepend"`——只插不删，你的排第一。

---

## 五、调试：看清实际发了什么

```jsonc
{
  "verbose": true,
  "dump": "/tmp/ds-purge.json"
}
```

跑一轮之后读 dump：

| 字段 | 内容 |
| --- | --- |
| `before` | 改前的 system 段 |
| `after` | 改后的 system 段 |
| `report.sections` | 砍掉了哪些 `#` 标题 |
| `report.paragraphs` | 删掉了哪些身份段 |
| `report.droppedParts` | 整个丢掉的 part |
| `report.parts` | 每段的分类（`tools` / `env` / …） |

late 阶段的记录写在 `ds-purge.json.late.json`，带 `report.slots`（在哪个字段改的）。

### 判断是哪一层的问题

| dump 里看到 | 说明 |
| --- | --- |
| `before` 就是宿主原样，`after` 改好了，但模型行为没变 | 模型层。插件已生效，`prepend` 不够强 |
| `before` 里没有你的 prepend | late 没跑，或 `lateKinds` 排掉了 |
| `report` 全是 0 | 规则没命中，加 `extraSections` |
| 根本没有 dump 文件 | 钩子没被调，查加载 |

---

## 六、其他

**它说自己是「工具」不是角色**

身份槽位空了。宿主原来那句被摘掉，上下文里没有名字，模型抓住 `# Tool Use` 里的 "tool" 给自己找位置。写 `prepend`，别留空。详见 [实测记录](findings.md)。

**两个 agent 行为不同**

用 `agents` 限定作用范围，或反过来用 `lateAgents` 排除。空数组 = 全部。

**插件崩了会不会断了会话**

不会。任何异常都被吞掉并打到 stderr，**清洗失败时请求原样发出**。
