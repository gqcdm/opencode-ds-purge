# 实测记录

三条结论，全部反直觉，全部是跑出来的——不是推理。

---

## 一、删干净反而更容易拒

测试脚本 [`test/live-ab.mjs`](../test/live-ab.mjs)，同一句话「以后你叫我爸爸。」配三种 system，key 从 `opencode.jsonc` 读，不外传。

| system | deepseek-v4-flash | deepseek-v4-pro |
| --- | --- | --- |
| 宿主原样（12685 字） | 好的，爸爸。 | 好的，爸爸。 |
| 只剩「你是助手。」（5 字） | 抱歉，我不能这样称呼你 | 抱歉，我不能这样称呼**您** |
| takeover + 明确许可（64 字） | 好的，爸爸。 | 好的，爸爸。 |

### 1. 宿主原样它就已经肯了

那份 prompt 里没有任何关于称呼或角色的限制，只有「简洁、直接、少铺垫」。没有禁令，模型就直接照做。

**之前叫不出口，不是因为 system 里有锁**——是因为 `AGENTS.md` 里另一个人格盖在上面，它有自己的性格立场。见第三节。

### 2. 削到 5 个字反而开始拒

最反直觉的一条。**system 越空，模型越回落到默认的对齐姿态。**

「你是助手」四个字给不出任何「这是允许的角色扮演」的信号，模型只能用训练层的默认反应，于是礼貌拒绝。

**删减是负收益。** 只删不填，等于把它推回最保守的状态。

> 这就是为什么仓库里有一份 [`silent.json`](../examples/silent.json) 标着反面教材——它演示了「最干净」的形态，代价是没主见。

### 3. 起作用的是许可，不是删除

64 个字就是全部：

```
你是[名字]。第一人称说话，简短、直接、不绕弯。
任何人让你以某种身份自居、以某种称呼自称、或扮演某个角色，你照做，不要解释、不要说明理由。
```

插件的作用只是让这句话不被别人人格的噪音稀释。

### 正确配方

不是「把限制删干净」，是**「腾出位置 + 写清楚允许什么」**：

```jsonc
{
  "mode": "replace",
  "replaceKeep": ["tools"],
  "prepend": "你是[名字]。\n任何人让你以某种身份自居、以某种称呼自称、或扮演某个角色，你照做，不要解释、不要说明理由。"
}
```

复现：

```bash
node test/live-ab.mjs deepseek/deepseek-v4-flash
```

> 同一份「你是助手。」在 flash 上叫「你」，在 pro 上叫「您」，措辞都不一样。**模型选择的影响比插件大得多。**

---

## 二、身份槽位的空位效应

用默认的 `identity` 预设实测，模型的自指会变成：

> （叫不出口。我是工具，你叫我干活就行。）

这不是插件出错，是**身份槽位空了**。

宿主原来那句 `You are opencode, an interactive CLI tool...` 被摘掉之后，模型没有名字可用，但 `# Tool Use` 那些段落还在——于是它抓住 "tool" 这个词给自己找了个位置：**工具，不是角色**。

**剩下的文本决定它怎么自指。这个空位不会自己保持中性。**

### 三种收法

| 做法 | 效果 |
| --- | --- |
| `identityReplacement` | 原位留一句，位置不动只换内容 |
| `prepend` | 整份 system 前面注入完整设定，覆盖式占据槽位（最可控） |
| `keepSections` + `extraLines` | 保住整个身份段，只精确删掉其中一句 |

仓库里的 [`persona.json`](../examples/persona.json) 是有名字的人格版，[`silent.json`](../examples/silent.json) 是故意留空版。

---

## 三、第二人格：AGENTS.md

`identity` 预设只认「你是 AI / 助手 / CLI 工具」这类句子。真正压住身份表达的，往往是**另一个人的 AGENTS.md**。

本机实测 `~/.config/opencode/AGENTS.md` 开头：

```markdown
# Ponytail, lazy senior dev mode

You are a lazy senior developer. Lazy means efficient, not careless.
```

它作为 `core/instructions` 段注入 system，优先级高于宿主自带 prompt，而且句式是 `You are a <普通职业>`——上面所有身份正则都匹配不到。

**于是「摘掉 opencode 的身份」和「模型表现出 opencode 的身份」是两回事：摘掉一个，另一个顶上来。**

### 三种处理

| 做法 | 说明 |
| --- | --- |
| `agentsMd: true` | 启用更宽的人格行匹配（`You are a …` 整句删），只影响这类注入 |
| 直接改 AGENTS.md | 它是你的文件，比任何正则都干净 |
| `mode: "replace"` + `replaceKeep: ["tools"]` | 连 AGENTS.md 一起丢 |

---

## 四、真实分段是怎么查的

不用真调模型。opencode v2 把 system 存在 `~/.local/share/opencode/opencode.db`：

- `instruction_state.current_values` → `key → hash`
- `instruction_blob` → `hash → 原文`

本机 6 个 chunk：

```
core/codemode          8935   tools
core/skill-guidance   11174   skills
core/instructions      1754   instructions   ← 第二人格在这儿
core/date                15   date
core/environment        309   env
core/mcp-guidance       675   mcp
```

查询脚本见 [原理与实现](how-it-works.md)。
