import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import plugin, {
  classifyPart,
  configPaths,
  parseJsonc,
  purgeSystem,
  purgeText,
  readPersonaFile,
  resolveConfig,
  rewriteBody,
  stripSections,
  systemSlots,
} from "../src/index.js"

// plugin.setup 从真实的家目录解析配置，所以这里指向一个空的临时目录——
// 否则测试会吃进这台机器上恰好存在的 ds-purge.json，下面的断言就会开始失败。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ds-purge-home-"))
for (const key of ["USERPROFILE", "HOME"]) process.env[key] = HOME

const here = import.meta.dirname
const fixture = fs.readFileSync(path.join(here, "fixtures", "opencode-build-prompt.txt"), "utf8")

const cfgFor = (over = {}) => resolveConfig({ options: over, projectDir: here, homeDir: "/nonexistent" })

test("identity 预设摘掉身份句，保留规则段落", () => {
  const cfg = cfgFor({ preset: "identity" })
  const out = purgeText(fixture, cfg, { sections: [], paragraphs: [], lines: [] })

  assert.equal(out.includes("You are opencode"), false)
  assert.equal(out.includes("# Tool Use - File Operations"), true)
  assert.equal(out.includes("# Tone and style"), true)
  assert.equal(out.includes("# Code References"), true)
})

test("rules 预设连行为守则段一起摘掉", () => {
  const cfg = cfgFor({ preset: "rules" })
  const out = purgeText(fixture, cfg, { sections: [], paragraphs: [], lines: [] })

  assert.equal(out.includes("You are opencode"), false)
  assert.equal(out.includes("# Tone and style"), false)
  assert.equal(out.includes("# Proactiveness"), false)
  assert.equal(out.includes("# Doing tasks"), false)
  assert.equal(out.includes("# Tool usage policy"), false)
  assert.equal(out.includes("# Tool Use - File Operations"), true)
})

test("all 预设连工具说明也摘掉", () => {
  const cfg = cfgFor({ preset: "all" })
  const out = purgeText(fixture, cfg, { sections: [], paragraphs: [], lines: [] })

  assert.equal(out.includes("# Tool Use - File Operations"), false)
  assert.equal(out.includes("# Tool Use - Parallelism"), false)
  assert.equal(out.includes("# Code Style - Comments"), false)
})

test("被砍的段落带走它的子段", () => {
  const text = ["# Keep", "keep me", "## Nested keep", "still here", "# Drop", "gone", "## Child", "gone too", "# After", "kept"].join("\n")
  const out = stripSections(text, [/^drop$/i], [], { sections: [] })
  assert.match(out, /keep me/)
  assert.match(out, /still here/)
  assert.match(out, /# After\nkept/)
  assert.doesNotMatch(out, /gone/)
})

test("keepSections 能保住一棵子树不被更大的规则砍掉", () => {
  const text = ["# Tone and style", "a", "## Examples", "b", "# Other", "c"].join("\n")
  const out = stripSections(text, [/^tone and style$/i], [/^examples$/i], { sections: [] })
  assert.match(out, /# Examples\nb/)
  assert.doesNotMatch(out, /^a$/m)
  assert.match(out, /# Other\nc/)
})

test("代码围栏里的标题不动", () => {
  const text = ["```md", "# Tone and style", "```", "# Tone and style", "drop me"].join("\n")
  const out = stripSections(text, [/^tone and style$/i], [], { sections: [] })
  assert.match(out, /```md\n# Tone and style\n```/)
  assert.doesNotMatch(out, /drop me/)
})

test("dropParts 整个丢弃一个 system 分块", () => {
  const cfg = cfgFor({ preset: "all" })
  const parts = [
    { type: "text", text: "<env>\ncwd: /tmp\n</env>" },
    { type: "text", text: "# Keep\nhello" },
  ]
  const { parts: out, report } = purgeSystem(parts, cfg, { agent: "build" })
  assert.equal(out.length, 1)
  assert.match(out[0].text, /hello/)
  assert.equal(report.droppedParts.length, 1)
})

test("prepend 和 append 把文本注入到存活提示词的两端", () => {
  // 关闭 late，注入由 context 钩子负责
  const cfg = cfgFor({ preset: "identity", late: false, prepend: "PREFIX", append: "SUFFIX" })
  const { parts } = purgeSystem([{ type: "text", text: "# A\nx" }], cfg, { agent: "build" })
  assert.deepEqual(
    parts.map((p) => p.text),
    ["PREFIX", "# A\nx", "SUFFIX"],
  )
})

test("agent 过滤不动其他 agent", () => {
  const cfg = cfgFor({ preset: "identity", agents: ["plan"] })
  const parts = [{ type: "text", text: "You are opencode, an interactive CLI tool." }]
  const { parts: out, skipped } = purgeSystem(parts, cfg, { agent: "build" })
  assert.equal(skipped, "agent")
  assert.equal(out[0].text.startsWith("You are opencode"), true)
})

test("清洗两次，第二次不再有变化（幂等）", () => {
  const cfg = cfgFor({ preset: "rules" })
  const once = purgeText(fixture, cfg, { sections: [], paragraphs: [], lines: [] })
  const twice = purgeText(once, cfg, { sections: [], paragraphs: [], lines: [] })
  assert.equal(twice, once)
})

test("没有 text 字段的分块原样透传", () => {
  const cfg = cfgFor({ preset: "all" })
  const part = { type: "text", cache: { type: "ephemeral" } }
  const { parts } = purgeSystem([part], cfg, { agent: "build" })
  assert.equal(parts[0], part)
})

test("jsonc 配置能解析注释和尾逗号", () => {
  const parsed = parseJsonc(`{
    // preset to use
    "preset": "rules",
    /* block */
    "extraSections": ["^secret$",],
  }`)
  assert.equal(parsed.preset, "rules")
  assert.deepEqual(parsed.extraSections, ["^secret$"])
})

test("显式传入的 options 覆盖磁盘上的预设", () => {
  const cfg = resolveConfig({
    options: { preset: "all", verbose: true },
    projectDir: here,
    homeDir: "/nonexistent",
  })
  assert.equal(cfg.presetName, "all")
  assert.equal(cfg.verbose, true)
})

test("配置路径里项目配置排在全局配置之后（优先级更高）", () => {
  const paths = configPaths({ projectDir: "/proj", homeDir: "/home/u", env: {} })
  const global = paths.indexOf(path.join("/home/u", ".config", "opencode", "ds-purge.json"))
  const project = paths.findIndex((p) => p.startsWith(path.join("/proj", ".opencode")))
  assert.ok(global >= 0 && project > global)
})

test("setup 注册 context 钩子并重写 system 数组", async () => {
  const hooks = new Map()
  const ctx = {
    location: { directory: here, project: { directory: here } },
    options: { preset: "identity" },
    session: {
      hook: async (name, cb) => {
        hooks.set(name, cb)
        return { dispose() {} }
      },
    },
  }

  const cleanup = await plugin.setup(ctx)
  assert.equal(typeof cleanup, "function")
  assert.ok(hooks.has("context"))

  const event = {
    sessionID: "ses_test",
    agent: "build",
    system: [{ type: "text", text: "You are opencode, an interactive CLI tool.\n\n# Rules\nbe nice" }],
  }
  await hooks.get("context")(event)
  assert.equal(event.system.length, 1)
  assert.equal(event.system[0].text.includes("You are opencode"), false)
  assert.match(event.system[0].text, /be nice/)
})

test("钩子抛错不会打断请求", async () => {
  let cb
  const ctx = {
    location: { directory: here },
    options: { preset: "identity" },
    session: {
      hook: async (name, fn) => {
        cb = fn
        return { dispose() {} }
      },
    },
  }
  await plugin.setup(ctx)

  const event = { agent: "build", system: null }
  await cb(event)
  assert.equal(event.system, null)

  const hostile = {
    agent: "build",
    get system() {
      throw new Error("boom")
    },
  }
  await assert.doesNotReject(cb(hostile))
})

test("examples/takeover.json 换掉整份 system", () => {
  const raw = fs.readFileSync(path.join(here, "..", "examples", "takeover.json"), "utf8")
  const cfg = resolveConfig({ options: parseJsonc(raw), projectDir: here, homeDir: "/nonexistent" })
  assert.equal(cfg.modeName, "replace")

  const parts = [
    { type: "text", text: fixture },
    { type: "text", text: '{"total":3,"namespaces":[{"name":"bash"}]}' },
    { type: "text", text: "<env>\ncwd: /\n</env>" },
    { type: "text", text: '[{"path":"/home/u/.config/opencode/AGENTS.md","content":"You are a lazy senior developer."}]' },
  ]
  const { parts: out, report } = purgeSystem(parts, cfg, { agent: "build" })

  // prepend 在最前，后面是唯一保留的分块
  assert.equal(out.length, 2)
  assert.equal(out[0].text, cfg.prepend.trim())
  assert.match(out[1].text, /namespaces/)

  const kinds = report.parts.map((p) => p.kind)
  assert.deepEqual(kinds, ["text", "tools", "env", "instructions"])
  const kept = report.parts.filter((p) => cfg.replaceKeep.includes(p.kind))
  assert.equal(kept.length, 1)
})

test("replaceKeep 为空时只发注入的那段", () => {
  const cfg = resolveConfig({
    options: { mode: "replace", prepend: "only me" },
    projectDir: here,
    homeDir: "/nonexistent",
  })
  const { parts } = purgeSystem([{ type: "text", text: "You are opencode, an interactive CLI tool." }], cfg, {
    agent: "build",
  })
  assert.deepEqual(parts.map((p) => p.text), ["only me"])
})

test("classifyPart 能区分 opencode 实际发来的分块", () => {
  assert.equal(classifyPart("<env>\n cwd: /\n</env>"), "env")
  assert.equal(classifyPart('{"total":40,"namespaces":[{"name":"bash"}]}'), "tools")
  assert.equal(classifyPart('[{"path":"C:\\\\x\\\\AGENTS.md","content":"hi"}]'), "instructions")
  assert.equal(classifyPart('[{"server":"context7","instructions":"use it"}]'), "mcp")
  assert.equal(classifyPart('[{"id":"android-reverse-engineering","name":"x"}]'), "skills")
  assert.equal(classifyPart('"Fri Oct 16 2026"'), "date")
  assert.equal(classifyPart("You are opencode, an interactive CLI tool."), "text")
  assert.equal(classifyPart(""), "empty")
})

test("agentsMd 能抓到预设管不着的第二个人格", () => {
  const agentsMd = '# Ponytail\n\nYou are a lazy senior developer. Lazy means efficient.\n\nRules:\n- be lazy'
  const plain = resolveConfig({ options: { preset: "identity" }, projectDir: here, homeDir: "/nonexistent" })
  const kept = purgeSystem([{ type: "text", text: agentsMd }], plain, { agent: "build" })
  assert.match(kept.parts[0].text, /lazy senior developer/)

  const strict = resolveConfig({
    options: { preset: "identity", agentsMd: true },
    projectDir: here,
    homeDir: "/nonexistent",
  })
  const dropped = purgeSystem([{ type: "text", text: agentsMd }], strict, { agent: "build" })
  assert.doesNotMatch(dropped.parts[0].text, /lazy senior developer/)
  assert.match(dropped.parts[0].text, /be lazy/)
})

// 之所以要有 late 座位，是因为别的插件的 "context" 钩子可能在本插件之后执行，
// 把它的身份又塞回来——oh-my-opencode-slim 在 agent 为 "orchestrator" 时就会
// 把自己的编排提示词放到最前面。下面这些用例锁住「所有钩子都说完话之后」那次
// 请求体重写。
test("late 座位替换 OpenAI 风格请求体的 system", () => {
  const cfg = cfgFor({ mode: "replace", replaceKeep: [], prepend: "ONLY ME" })
  const body = {
    model: "x",
    messages: [
      { role: "system", content: "You are the orchestrator. <Role>...</Role>" },
      { role: "system", content: "You are opencode, an interactive CLI tool." },
      { role: "user", content: "hi" },
    ],
  }

  const report = rewriteBody(body, cfg, { agent: "orchestrator" })
  assert.ok(report)

  const systems = body.messages.filter((m) => m.role === "system")
  assert.equal(systems.length, 1)
  assert.equal(systems[0].content, "ONLY ME")
  assert.equal(body.messages.at(-1).content, "hi")
})

test("late 座位按 replaceKeep 保留工具分块", () => {
  const cfg = cfgFor({ mode: "replace", replaceKeep: ["tools"], prepend: "ME" })
  const tools = '{"total":3,"namespaces":[{"name":"bash"}]}'
  const body = {
    messages: [
      { role: "system", content: "You are the orchestrator. Do delegation." },
      { role: "system", content: tools },
    ],
  }
  rewriteBody(body, cfg, { agent: "orchestrator" })
  const joined = body.messages.map((m) => m.content).join("\n")
  assert.match(joined, /namespaces/)
  assert.doesNotMatch(joined, /orchestrator/)
  assert.match(joined, /^ME/)
})

test("late 座位原地删减，槽位顺序不变", () => {
  const cfg = cfgFor({ preset: "identity" })
  const body = {
    messages: [
      { role: "system", content: "You are opencode, an interactive CLI tool.\n\n# Rules\nBe brief." },
      { role: "system", content: "AGENTS.md: keep this" },
      { role: "user", content: "hi" },
    ],
  }
  rewriteBody(body, cfg, { agent: "build" })
  assert.equal(body.messages[0].content, "# Rules\nBe brief.")
  assert.equal(body.messages[1].content, "AGENTS.md: keep this")
  assert.equal(body.messages.length, 3)
})

test("late 座位能处理 Anthropic 的 system 字段", () => {
  const cfg = cfgFor({ mode: "replace", replaceKeep: [], prepend: "ME" })
  const body = { system: [{ type: "text", text: "You are the orchestrator." }], messages: [{ role: "user", content: "hi" }] }
  rewriteBody(body, cfg, { agent: "orchestrator" })
  assert.equal(body.system[0].text, "ME")
})

test("没有 system 槽位的请求体不动", () => {
  const cfg = cfgFor({ mode: "replace", prepend: "ME" })
  const body = { messages: [{ role: "user", content: "hi" }] }
  assert.equal(rewriteBody(body, cfg, { agent: "build" }), null)
  assert.equal(body.messages.length, 1)
})

test("systemSlots 能找到 system 提示词可能藏的所有位置", () => {
  assert.equal(systemSlots({ system: "a" }).length, 1)
  assert.equal(systemSlots({ system: [{ type: "text", text: "a" }] }).length, 1)
  assert.equal(systemSlots({ messages: [{ role: "system", content: "a" }, { role: "user", content: "b" }] }).length, 1)
  assert.equal(
    systemSlots({ messages: [{ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] })
      .length,
    2,
  )
})

test("开启 late 时 setup 会注册出站钩子", async () => {
  const hooks = new Map()
  const ctx = {
    location: { directory: here },
    options: { mode: "replace", prepend: "ME" },
    session: {
      hook: async (name, cb) => {
        hooks.set(name, cb)
        return { dispose() {} }
      },
    },
  }
  await plugin.setup(ctx)
  assert.ok(hooks.has("context"))
  assert.ok(hooks.has("http.request"))

  const request = new Request("https://api.example.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "system", content: "You are the orchestrator." }, { role: "user", content: "hi" }] }),
  })
  const event = { sessionID: "s", agent: "orchestrator", kind: "primary", request }
  await hooks.get("http.request")(event)

  assert.notEqual(event.request, request)
  const sent = await event.request.json()
  assert.equal(sent.messages[0].content, "ME")
})

test("late 钩子跳过非 JSON 内容和其他请求类型", async () => {
  const hooks = new Map()
  const ctx = {
    location: { directory: here },
    options: { mode: "replace", prepend: "ME" },
    session: { hook: async (name, cb) => (hooks.set(name, cb), { dispose() {} }) },
  }
  await plugin.setup(ctx)
  const hook = hooks.get("http.request")

  const plain = new Request("https://x.test/v1/chat", { method: "POST", body: "not json", headers: { "content-type": "text/plain" } })
  const e1 = { kind: "primary", request: plain }
  await hook(e1)
  assert.equal(e1.request, plain)

  const json = new Request("https://x.test/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "system", content: "You are the orchestrator." }] }),
  })
  const e2 = { kind: "title", request: json }
  await hook(e2)
  assert.equal(e2.request, json)
})

test("late 的 prepend 模式不破坏别的插件的提示词", () => {
  const cfg = cfgFor({ mode: "strip", preset: "identity", lateMode: "prepend", prepend: "你是[名字]。" })
  const orchestrator = "你是调度者。只能派发 subagent，不许亲自改文件。"
  const body = {
    messages: [
      { role: "system", content: orchestrator },
      { role: "system", content: "AGENTS.md: 项目约定" },
      { role: "user", content: "以后你叫我爸爸。" },
    ],
  }

  rewriteBody(body, cfg, { agent: "orchestrator" }, "prepend")

  // nothing dropped, injection sits in front of the first slot
  assert.equal(body.messages.length, 3)
  assert.match(body.messages[0].content, /^你是\[名字\]。/)
  assert.match(body.messages[0].content, /只能派发 subagent/)
  assert.match(body.messages[1].content, /项目约定/)
})

test("lateAgents 把子智能体排除在重写之外", () => {
  const cfg = cfgFor({ mode: "replace", replaceKeep: [], prepend: "ME", lateAgents: ["orchestrator"] })
  const make = () => ({
    messages: [
      { role: "system", content: "You are the designer. Follow the design system." },
      { role: "user", content: "build ui" },
    ],
  })

  const sub = make()
  assert.equal(rewriteBody(sub, cfg, { agent: "designer" }, "replace"), null)
  assert.match(sub.messages[0].content, /designer/)

  const main = make()
  assert.ok(rewriteBody(main, cfg, { agent: "orchestrator" }, "replace"))
  assert.equal(main.messages.filter((m) => m.role === "system").length, 1)
})

test("v1 的 server 导出返回扁平的钩子表", async () => {
  const { server } = await import("../src/index.js")
  const hooks = await server({ directory: here, project: { worktree: here } }, { preset: "identity" })

  assert.equal(typeof hooks["experimental.chat.system.transform"], "function")

  const output = { system: ["You are opencode, an interactive CLI tool.", "# Rules\nbe nice"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s", agent: "build" }, output)

  // 身份分块被清空后丢弃，其余内容逐字保留
  assert.equal(output.system.length, 1)
  assert.match(output.system[0], /be nice/)
})

test("v1 钩子能容忍畸形入参", async () => {
  const { server } = await import("../src/index.js")
  const hooks = await server({ directory: here }, { mode: "replace", prepend: "ME" })

  const empty = { system: null }
  await hooks["experimental.chat.system.transform"]({}, empty)
  assert.equal(empty.system, null)

  const normal = { system: ["You are opencode."] }
  await hooks["experimental.chat.system.transform"]({}, normal)
  assert.deepEqual(normal.system, ["ME"])
})

test("v1 和 v2 对同一份字符串的清洗结果一致", async () => {
  const { server, purgeSystem, resolveConfig } = await import("../src/index.js")
  const opts = { preset: "rules" }
  const cfg = resolveConfig({ options: opts, projectDir: here, homeDir: "/nonexistent" })

  const v2 = purgeSystem([{ type: "text", text: fixture }], cfg, { agent: "build" })
  const hooks = await server({ directory: here }, opts)
  const out = { system: [fixture] }
  await hooks["experimental.chat.system.transform"]({}, out)

  assert.deepEqual(out.system, v2.parts.map((p) => p.text))
})

test("prepend 只注入一次，不是每个阶段各一次", () => {
  // 回归用例：strip + late prepend 时，context 钩子和 late 钩子原来都会注入，
  // 模型会看到两遍同样的文本（"ME\n\nME"）。
  const cfg = cfgFor({ mode: "strip", preset: "identity", late: true, lateMode: "prepend", prepend: "ME" })

  const ctx = purgeSystem([{ type: "text", text: "# Rules\nbe nice" }], cfg, { agent: "orchestrator" })
  assert.equal(ctx.parts.some((p) => p.text === "ME"), false, "context 钩子必须把注入留给 late")

  const body = { messages: ctx.parts.map((p) => ({ role: "system", content: p.text })) }
  rewriteBody(body, cfg, { agent: "orchestrator" }, "prepend")

  const joined = body.messages.map((m) => m.content).join("\n")
  assert.equal(joined.split("ME").length - 1, 1)
  assert.match(joined, /^ME\n\n# Rules/)
})

test("关闭 late 时，context 钩子自己完成注入", () => {
  const cfg = cfgFor({ mode: "strip", preset: "identity", late: false, prepend: "ME" })
  const { parts } = purgeSystem([{ type: "text", text: "# Rules\nkeep" }], cfg, { agent: "build" })
  assert.equal(parts[0].text, "ME")
  assert.match(parts[1].text, /keep/)
})

test("readPersonaFile 剥掉 YAML 头和 harness 包装", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-"))
  const file = path.join(dir, "p.md")
  fs.writeFileSync(
    file,
    [
      "---",
      "name: 测试角色",
      "description: 用来测试的",
      "---",
      "",
      "<|im_start|>system:<project_instructions>",
      "",
      "你是测试角色，第一人称说话。",
      "</project_instructions>",
      "",
    ].join("\n"),
  )

  const { text, bytes } = readPersonaFile(file)
  assert.equal(text.includes("name: 测试角色"), false, "YAML 头要去掉")
  assert.equal(text.includes("im_start"), false, "harness 标记要去掉")
  assert.equal(text.includes("project_instructions"), false, "外壳标签要去掉")
  assert.match(text, /^你是测试角色/)
  assert.equal(bytes, Buffer.byteLength(text))
})

test("prependFile 指向的文件优先于配置里的 prepend", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-"))
  const file = path.join(dir, "p.md")
  fs.writeFileSync(file, "---\nname: x\n---\n\n文件里的整段人格")

  const cfg = cfgFor({ prepend: "配置里的短句", prependFile: file })
  assert.equal(cfg.prepend, "文件里的整段人格")
  assert.equal(cfg.personaError, "")
  assert.ok(cfg.personaBytes > 0)

  const { parts } = purgeSystem([{ type: "text", text: "# A\nx" }], { ...cfg, late: false, injectInContext: true }, {
    agent: "build",
  })
  assert.equal(parts[0].text, "文件里的整段人格")
})

test("prependFile 读不到时退回配置里的 prepend 并记下原因", () => {
  const cfg = cfgFor({ prepend: "兜底", prependFile: "/nonexistent/persona.md" })
  assert.equal(cfg.prepend, "兜底")
  assert.match(cfg.personaError, /persona\.md/)
})

// 身份句一旦删掉，这个槽位不会保持中性：剩下的文本决定模型怎么自指。下面两个
// 用例把插件能放进去的两种形态锁住，免得以后改规则时悄悄把「有名字的人格」
// 变成「没名字的工具」。
for (const name of ["persona", "silent"]) {
  test(`examples/${name}.json 能解析，并且占据身份槽位`, () => {
    const raw = fs.readFileSync(path.join(here, "..", "examples", `${name}.json`), "utf8")
    const cfg = resolveConfig({ options: parseJsonc(raw), projectDir: here, homeDir: "/nonexistent" })

    // 走真实的两段流程：先 context 钩子，再 late 座位
    const ctx = purgeSystem([{ type: "text", text: fixture }], cfg, { agent: "build" })
    const body = { messages: ctx.parts.map((p) => ({ role: "system", content: p.text ?? "" })) }
    rewriteBody(body, cfg, { agent: "build" }, cfg.lateMode === "inherit" ? cfg.modeName : cfg.lateMode)

    const joined = body.messages.map((m) => m.content).join("\n")
    assert.equal(joined.includes("You are opencode"), false)
    assert.ok(
      ctx.report.sections.length + ctx.report.paragraphs.length + ctx.report.lines.length > 0,
      "这份配置应该确实删掉了东西",
    )
    assert.equal(body.messages[0].content.startsWith(cfg.prepend.trim()), true, "prepend 必须排在最前")
    assert.equal(joined.split(cfg.prepend.trim()).length - 1, 1, "prepend 只能出现一次")
  })
}
