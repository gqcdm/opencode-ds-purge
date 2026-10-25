// opencode-ds-purge
// 在请求发给模型之前，把 opencode v2 为本次会话拼好的 system prompt 里
// 的角色设定、身份句、行为守则段落摘掉或换掉。
//
// 宿主接口（opencode 2.1.x）：插件导出一个 { id, setup(ctx) }，通过
// ctx.session.hook("钩子名", 回调) 注册钩子。"context" 钩子拿到的是可修改的
// SessionContext：
//   { sessionID, agent, model, system: SystemPart[], messages, options, tools }
// SystemPart = { type: "text", text, cache?, metadata? }
// 给 event.system 重新赋值，就等于替换本次请求的 system。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const PLUGIN_ID = "opencode-ds-purge"

// ------------------------------------------------------------- 人格文件

// 从 markdown 读取一整段人格设定。三个常见包装按顺序剥掉：
//   --- YAML frontmatter ---
//   <|im_start|>system:... 这类 harness 标记
//   <project_instructions> / </project_instructions> 之类的外壳标签
export function readPersonaFile(file) {
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (err) {
    return { error: `${file}: ${err?.message ?? err}` }
  }

  text = text.replace(/^\uFEFF/, "")
  const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)
  if (frontmatter) text = text.slice(frontmatter[0].length)

  text = text
    .replace(/^\s*<\|im_start\|>[^\n]*\n?/m, "")
    .replace(/<\|im_end\|>\s*$/m, "")
    .replace(/<\/?(?:project_instructions|system|instructions)>\s*\n?/gi, "")

  text = text.trim()
  return { text, bytes: Buffer.byteLength(text) }
}

// ---------------------------------------------------------------- 预设

const SECTIONS_RULES = [
  /^tone and style$/i,
  /^communication\b/i,
  /^behavior\b/i,
  /^proactiveness$/i,
  /^following conventions$/i,
  /^code style$/i,
  /^code comments$/i,
  /^code style - comments$/i,
  /^doing tasks$/i,
  /^tool usage policy$/i,
  /^code references$/i,
  /^harness$/i,
  /^working in codebases$/i,
  /^delegation$/i,
  /^destructive actions$/i,
  /^autonomy$/i,
  /^report an opencode issue$/i,
]

const SECTIONS_TOOL = [/^tool use\b/i, /^tools?$/i, /^available tools$/i]

const IDENTITY_PATTERNS = [
  /^\s*You are opencode\b/i,
  /^\s*You are an? (?:interactive )?(?:CLI|command[- ]line|terminal)\s+(?:tool|agent|assistant)\b/i,
  /^\s*You are (?:a|an) [^.\n]{0,80}\b(?:AI|A\.I\.|assistant|language model|agent|coding agent|CLI tool)\b/i,
  /^\s*(?:Your name is|You are called|You go by)\b/i,
  /^\s*You are (?:Claude Code|Claude|ChatGPT|GPT-?\d|Gemini|DeepSeek|Kimi|GLM|Qwen|Llama)\b/i,
  /^\s*你(?:是|叫|的名字是)/,
]

// AGENTS.md / CLAUDE.md 是作为一个 system 分段注入的，优先级比宿主提示词更高：
// 写在那里的人格能躲过上面所有身份规则，除非连 "You are a <角色>" 这种普
// 通句式也一起认出来。这条正则故意放宽，并且只由 `agentsMd` 开关显式启用，
// 不属于任何预设。
const PERSONA_LINE = /^\s*You are (?:a|an|the) [^.\n]{2,120}\.(?:\s*$|[\s\S]*$)/i

const PART_DROP_PATTERNS = [
  /^\s*<env>[\s\S]*<\/env>\s*$/,
  /^\s*<environment_context>[\s\S]*<\/environment_context>\s*$/,
]

export const PRESETS = {
  none: { stripIdentity: false, sections: [], tools: false, dropParts: [] },
  identity: { stripIdentity: true, sections: [], tools: false, dropParts: [] },
  rules: { stripIdentity: true, sections: SECTIONS_RULES, tools: false, dropParts: [] },
  all: { stripIdentity: true, sections: SECTIONS_RULES, tools: true, dropParts: PART_DROP_PATTERNS },
}

export const DEFAULTS = {
  enabled: true,
  preset: "identity",
  mode: "strip",
  replaceKeep: [],
  late: true,
  lateMode: "inherit",
  lateAgents: [],
  lateKinds: ["primary"],
  agentsMd: false,
  agents: [],
  keepSections: [],
  extraSections: [],
  extraLines: [],
  identityPatterns: [],
  identityReplacement: "",
  extraParts: [],
  prepend: "",
  prependFile: "",
  append: "",
  dump: "",
  verbose: false,
}

// --------------------------------------------------------------- 工具函数

export function parseJsonc(text) {
  let out = ""
  let i = 0
  let quote = null
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (quote) {
      out += ch
      if (ch === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i++
      continue
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

function readConfigFile(file) {
  try {
    if (!fs.existsSync(file)) return null
    return parseJsonc(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function asRegExpList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (item instanceof RegExp) out.push(item)
    else if (typeof item === "string" && item.length > 0) {
      try {
        out.push(new RegExp(item, "i"))
      } catch {}
    }
  }
  return out
}

function matchesAny(value, list) {
  for (const re of list) {
    re.lastIndex = 0
    if (re.test(value)) return true
  }
  return false
}

// 配置文件路径，按优先级从低到高排列。
export function configPaths({ projectDir, homeDir = os.homedir(), env = process.env }) {
  const paths = []
  paths.push(path.join(homeDir, ".config", "opencode", "ds-purge.json"))
  paths.push(path.join(homeDir, ".config", "opencode", "ds-purge.jsonc"))
  if (projectDir) {
    paths.push(path.join(projectDir, ".opencode", "ds-purge.json"))
    paths.push(path.join(projectDir, ".opencode", "ds-purge.jsonc"))
  }
  if (env.OPENCODE_DS_PURGE_CONFIG) paths.push(env.OPENCODE_DS_PURGE_CONFIG)
  return paths
}

export function resolveConfig({ options, projectDir, homeDir, env } = {}) {
  const merged = { ...DEFAULTS }
  for (const file of configPaths({ projectDir, homeDir, env })) {
    const cfg = readConfigFile(file)
    if (cfg && typeof cfg === "object") Object.assign(merged, cfg)
  }
  if (options && typeof options === "object") Object.assign(merged, options)

  const preset = PRESETS[merged.preset] ?? PRESETS.identity
  const stripSections = [...preset.sections, ...asRegExpList(merged.extraSections)]
  if (preset.tools) stripSections.push(...SECTIONS_TOOL)

  const identity = [
    ...(preset.stripIdentity ? IDENTITY_PATTERNS : []),
    ...(merged.agentsMd ? [PERSONA_LINE] : []),
    ...asRegExpList(merged.identityPatterns),
  ]

  // prepend 可以是配置里直接写的短句，也可以由 prependFile 指向一整个 markdown
  // 人格文件。文件存在就以文件为准（那是完整设定），配置里的 prepend 只在文件
  // 读不到时兜底，免得两段人格同时生效互相打架。
  let persona = String(merged.prepend ?? "")
  let personaError = ""
  let personaBytes = Buffer.byteLength(persona)
  if (merged.prependFile) {
    const loaded = readPersonaFile(merged.prependFile)
    if (loaded.error) personaError = loaded.error
    else if (loaded.text) {
      persona = loaded.text
      personaBytes = loaded.bytes
    }
  }

  return {
    ...merged,
    prepend: persona,
    personaError,
    personaBytes,
    presetName: PRESETS[merged.preset] ? merged.preset : "identity",
    modeName: merged.mode === "replace" ? "replace" : "strip",
    // late 座位启用后，prepend / append 由它自己注入。这里再注入一次会让文本
    // 出现两遍（每个阶段一遍），模型会当成两条独立的指令来读。
    injectInContext: merged.late !== true,
    replaceKeep: Array.isArray(merged.replaceKeep) ? merged.replaceKeep.map(String) : [],
    lateMode: merged.lateMode === "prepend" || merged.lateMode === "replace" ? merged.lateMode : "inherit",
    lateAgents: Array.isArray(merged.lateAgents) ? merged.lateAgents.map(String) : [],
    lateKinds: Array.isArray(merged.lateKinds) ? merged.lateKinds.map(String) : ["primary"],
    agents: Array.isArray(merged.agents) ? merged.agents.map(String) : [],
    stripSections,
    keepSections: asRegExpList(merged.keepSections),
    identity,
    extraLines: asRegExpList(merged.extraLines),
    dropParts: [...(preset.dropParts ?? []), ...asRegExpList(merged.extraParts)],
    dumpPath: merged.dump || env?.OPENCODE_DS_PURGE_DUMP || "",
  }
}

// ------------------------------------------------------------- 分块分类

// opencode v2 的 system prompt 是由一组带键的指令分块拼起来的
// （core/instructions、core/environment、core/skill-guidance ……）。插件或
// AGENTS.md 加进来的东西也只是多一个文本块，所以接管之前得先分清每块是什么，
// 才能决定谁能留下。
export function classifyPart(text) {
  if (typeof text !== "string" || text.length === 0) return "empty"
  if (/<env>[\s\S]*<\/env>/.test(text)) return "env"
  if (/"namespaces"\s*:\s*\[|tools\["/.test(text)) return "tools"
  if (/"path"\s*:\s*"[^"]*(?:AGENTS|CLAUDE)\.md/.test(text)) return "instructions"
  if (/^\s*\[\s*\{\s*"server"\s*:/.test(text)) return "mcp"
  if (/^\s*\[\s*\{\s*"id"\s*:\s*"/.test(text)) return "skills"
  if (/^\s*"?[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4}"?\s*$/.test(text.trim())) return "date"
  return "text"
}

// replace 模式不编辑宿主的提示词，而是整个丢掉，只发 replaceKeep 里点名的
// 分块，外加用户自己写的内容。
export function takeover(parts, cfg, report) {
  const keep = new Set(cfg.replaceKeep)
  const out = []
  for (const part of parts) {
    const text = typeof part?.text === "string" ? part.text : ""
    const kind = classifyPart(text)
    report.parts.push({ kind, chars: text.length })
    if (keep.has(kind) && text) {
      out.push(part)
      continue
    }
    report.droppedParts.push(`${kind}:${text.slice(0, 60).replace(/\s+/g, " ")}`)
  }

  const prepend = (cfg.prepend ?? "").trim()
  const append = (cfg.append ?? "").trim()
  if (prepend) out.unshift({ type: "text", text: prepend })
  if (append) out.push({ type: "text", text: append })
  return out
}

// ---------------------------------------------------------------- 清洗主体

const HEADER = /^(#{1,3})\s+(.+?)\s*$/
const FENCE = /^\s*(```|~~~)/

// 逐行扫描提示词，维护一个标题栈，这样砍掉一段就连它的子段一起带走。
// 代码围栏里的 # 开头行不当标题处理。
export function stripSections(text, strip, keep, report) {
  const lines = text.split("\n")
  const stack = [] // { header, dropped }
  const out = []
  let fence = false

  for (const line of lines) {
    if (FENCE.test(line)) {
      fence = !fence
      const blocked = stack.length > 0 && stack[stack.length - 1].dropped
      if (!blocked) out.push(line)
      continue
    }

    const m = fence ? null : HEADER.exec(line)
    if (m) {
      const level = m[1].length
      const header = m[2]
      stack.length = Math.max(0, level - 1)
      const inherited = stack.length > 0 ? stack[stack.length - 1].dropped : false
      const protectedHere = matchesAny(header, keep)
      const dropped = protectedHere ? false : inherited || matchesAny(header, strip)
      stack[level - 1] = { header, dropped }
      if (!dropped) out.push(line)
      else if (report) report.sections.push(header)
      continue
    }

    const blocked = stack.length > 0 && stack[stack.length - 1].dropped
    if (blocked) continue
    out.push(line)
  }

  return out.join("\n")
}

export function stripParagraphs(text, patterns, replacement, report) {
  if (patterns.length === 0) return text
  const paragraphs = text.split(/\n{2,}/)
  const kept = []
  for (const paragraph of paragraphs) {
    if (matchesAny(paragraph.trim(), patterns)) {
      if (report) report.paragraphs.push(paragraph.trim().slice(0, 120))
      if (replacement) kept.push(replacement)
      continue
    }
    kept.push(paragraph)
  }
  return kept.join("\n\n")
}

export function stripLines(text, patterns, report) {
  if (patterns.length === 0) return text
  const kept = []
  for (const line of text.split("\n")) {
    if (line.trim() && matchesAny(line, patterns)) {
      if (report) report.lines.push(line.trim().slice(0, 120))
      continue
    }
    kept.push(line)
  }
  return kept.join("\n")
}

function tidy(text) {
  return text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim()
}

export function purgeText(text, cfg, report) {
  let out = text
  out = stripSections(out, cfg.stripSections, cfg.keepSections, report)
  out = stripParagraphs(out, cfg.identity, cfg.identityReplacement, report)
  out = stripLines(out, cfg.extraLines, report)
  return tidy(out)
}

export function purgeSystem(parts, cfg, meta = {}) {
  const report = { agent: meta.agent, mode: cfg.modeName, sections: [], paragraphs: [], lines: [], droppedParts: [], parts: [] }
  if (!Array.isArray(parts)) return { parts, report }

  if (cfg.agents.length > 0 && !cfg.agents.includes(String(meta.agent ?? ""))) {
    return { parts, report, skipped: "agent" }
  }

  if (cfg.modeName === "replace") {
    return { parts: takeover(parts, cfg, report), report }
  }

  const next = []
  for (const part of parts) {
    const text = part?.text
    if (typeof text !== "string") {
      next.push(part)
      continue
    }

    if (cfg.dropParts.length > 0 && matchesAny(text, cfg.dropParts)) {
      report.droppedParts.push(text.slice(0, 80))
      continue
    }

    const purged = purgeText(text, cfg, report)
    if (purged === text) {
      next.push(part)
      continue
    }
    if (!purged.trim()) continue
    next.push({ ...part, text: purged })
  }

  const prepend = (cfg.prepend ?? "").trim()
  const append = (cfg.append ?? "").trim()
  // late 座位启用时 injectInContext 为 false：注入由 late 在拼好的请求体上完成，
  // 这里再做一次会让文本重复。
  if (cfg.injectInContext !== false) {
    if (prepend) next.unshift({ type: "text", text: prepend })
    if (append) next.push({ type: "text", text: append })
  }

  return { parts: next, report }
}

// ----------------------------------------------------------- late 座位

// 别的插件可以在本插件之后注册自己的 "context" 钩子，把它的身份再塞回 system
// 数组里——oh-my-opencode-slim 在 agent 为 "orchestrator" 时干的就是这件事。
// 那之后唯一还能写入的位置就是出站请求，所以这里在拼好的 JSON 请求体上
// 再洗一遍。
export function systemSlots(body) {
  const slots = []
  if (typeof body?.system === "string") {
    slots.push({ path: ["system"], get: () => body.system, set: (v) => (body.system = v) })
  } else if (Array.isArray(body?.system)) {
    body.system.forEach((part, i) => {
      if (typeof part?.text === "string") {
        slots.push({ path: ["system", i, "text"], get: () => part.text, set: (v) => (part.text = v) })
      } else if (typeof part === "string") {
        slots.push({ path: ["system", i], get: () => part, set: (v) => (body.system[i] = v) })
      }
    })
  }
  if (Array.isArray(body?.messages)) {
    body.messages.forEach((message, i) => {
      if (message?.role !== "system") return
      if (typeof message.content === "string") {
        slots.push({ path: ["messages", i, "content"], get: () => message.content, set: (v) => (message.content = v) })
      } else if (Array.isArray(message.content)) {
        message.content.forEach((part, j) => {
          if (typeof part?.text === "string") {
            slots.push({
              path: ["messages", i, "content", j, "text"],
              get: () => part.text,
              set: (v) => (part.text = v),
            })
          }
        })
      }
    })
  }
  return slots
}

// 原地重写已经拼好的请求体，返回报告；没有可改的地方返回 null。
//
// mode: "replace" 丢掉所有 system 槽位，只发注入内容和 replaceKeep 允许的分块。
// "prepend" 只把注入内容放到第一个槽位前面，其余原样不动——当别的插件的提示词
// 必须继续生效时，用这一种。
export function rewriteBody(body, cfg, meta = {}, mode = cfg.modeName) {
  const agent = String(meta.agent ?? "")
  if (cfg.agents.length > 0 && !cfg.agents.includes(agent)) return null
  if (Array.isArray(cfg.lateAgents) && cfg.lateAgents.length > 0 && !cfg.lateAgents.includes(agent)) return null

  const slots = systemSlots(body).filter((slot) => slot.get().trim().length > 0)
  if (slots.length === 0) return null

  const report = {
    agent: meta.agent,
    mode,
    sections: [],
    paragraphs: [],
    lines: [],
    droppedParts: [],
    parts: [],
    slots: slots.map((slot) => slot.path.join(".")),
  }

  const prepend = (cfg.prepend ?? "").trim()
  const append = (cfg.append ?? "").trim()

  if (mode === "prepend") {
    if (prepend) slots[0].set(`${prepend}\n\n${slots[0].get()}`.trim())
    const last = slots[slots.length - 1]
    if (append) last.set(`${last.get()}\n\n${append}`.trim())
    if (prepend) report.injected = prepend.slice(0, 120)
    return report
  }

  if (mode === "replace") {
    const parts = slots.map((slot) => ({ type: "text", text: slot.get() }))
    const result = purgeSystem(parts, cfg, meta)
    for (const key of ["sections", "paragraphs", "lines", "droppedParts", "parts"]) report[key] = result.report[key]

    const texts = result.parts.map((part) => part.text).filter((text) => text.trim().length > 0)
    slots.forEach((slot, i) => slot.set(i === 0 ? texts.join("\n\n") : ""))

    const emptied = new Set()
    for (const slot of slots) {
      if (slot.path[0] === "messages" && !slot.get().trim()) emptied.add(slot.path[1])
    }
    if (emptied.size > 0 && Array.isArray(body.messages)) {
      const kept = body.messages.filter((_, i) => !emptied.has(i))
      // 存活下来的提示词必须留在最前面；如果 system 槽位全是 message 而且都被
      // 清空了，就把注入内容补回开头
      const head = texts.join("\n\n").trim()
      const hasSystemFirst = kept[0]?.role === "system"
      if (head && !hasSystemFirst) kept.unshift({ role: "system", content: head })
      body.messages = kept
    }
    return report
  }

  for (const slot of slots) slot.set(purgeText(slot.get(), cfg, report))

  if (prepend && slots[0]) slots[0].set(`${prepend}\n\n${slots[0].get()}`.trim())
  const last = slots[slots.length - 1]
  if (append && last) last.set(`${last.get()}\n\n${append}`.trim())

  return report
}

async function rewriteRequest(request, cfg, meta, mode) {
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.includes("json")) return null

  let body
  try {
    body = JSON.parse(await request.clone().text())
  } catch {
    return null
  }

  const report = rewriteBody(body, cfg, meta, mode)
  if (!report) return null

  const headers = new Headers(request.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  const next = new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
    duplex: "half",
  })
  return { request: next, report }
}

// ------------------------------------------------------------------ 插件入口

function describe(report) {
  const total =
    report.sections.length + report.paragraphs.length + report.lines.length + report.droppedParts.length
  if (total === 0) return null
  return `${PLUGIN_ID}: 段落=${report.sections.length} 身份段=${report.paragraphs.length} 行=${report.lines.length} 分块=${report.droppedParts.length}`
}

function dumpState(dumpPath, payload) {
  if (!dumpPath) return
  try {
    fs.mkdirSync(path.dirname(dumpPath), { recursive: true })
    fs.writeFileSync(dumpPath, JSON.stringify(payload, null, 2))
  } catch {}
}

export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const projectDir = ctx?.location?.project?.directory ?? ctx?.location?.directory ?? process.cwd()
    const cfg = resolveConfig({ options: ctx?.options, projectDir })

    if (!cfg.enabled) {
      if (cfg.verbose) console.error(`[${PLUGIN_ID}] 配置里已停用`)
      return () => {}
    }

    const reg = await ctx.session.hook("context", async (event) => {
      try {
        if (!event || !Array.isArray(event.system)) return
        const before = event.system.map((part) => part?.text ?? "")
        const result = purgeSystem(event.system, cfg, { agent: event.agent })
        if (result.skipped) return
        event.system = result.parts

        if (cfg.dumpPath) {
          dumpState(cfg.dumpPath, {
            at: new Date().toISOString(),
            sessionID: event.sessionID,
            agent: event.agent,
            model: event.model,
            preset: cfg.presetName,
            mode: cfg.modeName,
            before,
            after: result.parts.map((part) => part?.text ?? ""),
            report: result.report,
          })
        }
        if (cfg.verbose) {
          const line = describe(result.report)
          if (line) console.error(`[${PLUGIN_ID}] ${line}`)
        }
      } catch (err) {
        console.error(`[${PLUGIN_ID}] 清洗失败，提示词保持原样：`, err?.message ?? err)
      }
    })

    const disposers = [() => reg.dispose()]

    if (cfg.late) {
      try {
        const lateReg = await ctx.session.hook("http.request", async (event) => {
          try {
            if (!event?.request) return
            if (cfg.lateKinds.length > 0 && !cfg.lateKinds.includes(event.kind)) return
            const lateMode = cfg.lateMode === "inherit" ? cfg.modeName : cfg.lateMode
            const out = await rewriteRequest(event.request, cfg, { agent: event.agent }, lateMode)
            if (!out) return
            event.request = out.request
            if (cfg.dumpPath) {
              dumpState(cfg.dumpPath.replace(/\.json$/, "") + ".late.json", {
                at: new Date().toISOString(),
                sessionID: event.sessionID,
                agent: event.agent,
                kind: event.kind,
                report: out.report,
              })
            }
            if (cfg.verbose) {
              const line = describe(out.report)
              if (line) console.error(`[${PLUGIN_ID}] late 阶段 ${line}`)
            }
          } catch (err) {
            console.error(`[${PLUGIN_ID}] late 重写失败，请求保持原样：`, err?.message ?? err)
          }
        })
        disposers.push(() => lateReg.dispose())
      } catch (err) {
        console.error(`[${PLUGIN_ID}] http.request 钩子不可用，late 座位关闭：`, err?.message ?? err)
      }
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {}
      }
    }
  },
}

// opencode 1.x 按 `(input, options) => Hooks` 加载插件，找的是具名导出
// `server`，system prompt 通过 "experimental.chat.system.transform" 以
// string[] 的形式交过来。下面这段适配的正是那种形态，并且和主体放在同一个文件
// 里——插件目录下的每个文件都会被当成独立插件，只放一个可加载模块，别多放。

const v1Log = (cfg, message) => {
  if (cfg.verbose) console.error(`[${PLUGIN_ID}] ${message}`)
}

// v1 交过来的是字符串而不是 SystemPart，包一层就能和 v2 共用同一套逻辑。
const toSystemParts = (system) => (Array.isArray(system) ? system.map((text) => ({ type: "text", text })) : [])
const toSystemStrings = (parts) =>
  parts.map((part) => part?.text ?? "").filter((text) => text.length > 0)

export function createV1Plugin(options) {
  return async (input) => {
    const projectDir = input?.directory ?? input?.project?.worktree ?? process.cwd()
    const cfg = resolveConfig({ options, projectDir })

    if (!cfg.enabled) {
      v1Log(cfg, "配置里已停用")
      return {}
    }

    v1Log(cfg, `v1 宿主，模式=${cfg.modeName}`)
    if (!cfg.late) {
      v1Log(cfg, "late 已关闭，而且 v1 本来就没有出站请求钩子")
    }

    return {
      "experimental.chat.system.transform": async (args, output) => {
        try {
          if (!Array.isArray(output?.system)) return
          const before = [...output.system]
          const { parts, report, skipped } = purgeSystem(toSystemParts(output.system), cfg, { agent: args?.agent })
          if (skipped) return
          output.system = toSystemStrings(parts)

          if (cfg.dumpPath) dumpState(cfg.dumpPath, {
            at: new Date().toISOString(),
            host: "v1",
            sessionID: args?.sessionID,
            agent: args?.agent,
            mode: cfg.modeName,
            before,
            after: output.system,
            report,
          })

          const touched = report.sections.length + report.paragraphs.length + report.lines.length + report.droppedParts.length
          if (touched > 0) v1Log(cfg, `v1 段落=${report.sections.length} 行=${report.lines.length} 分块=${report.droppedParts.length}`)
        } catch (err) {
          console.error(`[${PLUGIN_ID}] v1 清洗失败，提示词保持原样：`, err?.message ?? err)
        }
      },
    }
  }
}

// opencode 1.x 找具名导出 `server`，2.x 用默认导出。两种形态都留在这个文件里，
// 这样装一个文件就能在两种宿主上跑。
export const server = async (input, options) => createV1Plugin(options)(input)
