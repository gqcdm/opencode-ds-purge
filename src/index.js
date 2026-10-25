// opencode-ds-purge v0.3
//
// 在请求发给模型之前，把 opencode v2 为本次会话拼好的 system prompt 里的
// 角色设定、身份句、行为守则段落摘掉或换掉，再把人格文件顶到最前面。
//
// 宿主接口（opencode 2.1.x）：插件导出一个 { id, setup(ctx) }，通过
// ctx.session.hook("钩子名", 回调) 注册钩子。"context" 钩子拿到的是可修改的
// SessionContext：
//   { sessionID, agent, model, system: SystemPart[], messages, options, tools }
// SystemPart = { type: "text", text, cache?, metadata? }
// 给 event.system 重新赋值，就等于替换本次请求的 system。
//
// v2 相对 v1 的改动（都为了「少删错、少重复、可观测」）：
//   1. 注入幂等：人格指纹已在 system 里就不再插一遍。重试、其他插件回填、
//      context 与 late 同时命中，都不会出现两段人格互相打架。
//   2. 标题归一：`## 1. Tone and Style**` / `### 第2章 行为守则：` 这类写法
//      先归一化再匹配，不会再因为编号、粗体、冒号、setext 下划线漏删。
//   3. 标题栈修正：`###` 直接跟在 `#` 后面时旧实现会在空位上取 .dropped 抛错，
//      整段清洗静默失效。现在按「最近的祖先」继承删除状态。
//   4. 重复分块去重：其他插件把同一段文本灌两遍时只留一份。
//   5. 体积账本：报告里带 charsBefore / charsAfter / saved，调提示词有数可看。
//   6. 保护阈值：system 超过 maxChars 直接跳过，不在超大贴码/日志上做正则扫描。
//   7. dryRun：只出报告不改请求，用来验证规则集。
//   8. doctor()：一条命令看配置合并结果、人格文件是否可读、有没有写错的键名。
//
// 降级原则不变：任何一段清洗抛错，都放行原请求，绝不让插件把会话弄挂。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const PLUGIN_ID = "opencode-ds-purge"
export const PLUGIN_VERSION = "0.3.0"

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
  // 中文这条必须收窄：只认「你是 + AI/助手/模型」这类，不能见「你是」就删。
  // 放宽到 /^你是/ 会把别的插件写的「你是调度者」整段吃掉。
  /^\s*你(?:是|叫|的名字是)[^。\n]{0,20}?(?:AI|人工智能|助手|语言模型|大模型|机器人)/,
  /^\s*你(?:是|叫)\s*(?:Claude|ChatGPT|GPT|Gemini|DeepSeek|Kimi|GLM|通义|文心|豆包)/i,
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
  latePosition: "head",
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
  dropEnv: false,
  dedupeParts: true,
  maxChars: 1_000_000,
  dryRun: false,
  prepend: "",
  prependFile: "",
  bridge: "",
  append: "",
  dump: "",
  verbose: false,
}

const KNOWN_KEYS = new Set([...Object.keys(DEFAULTS), "injection", "personaBytes"])

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

const charCount = (text) => (typeof text === "string" ? text.length : 0)

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
  const used = []
  for (const file of configPaths({ projectDir, homeDir, env })) {
    const cfg = readConfigFile(file)
    if (cfg && typeof cfg === "object") {
      Object.assign(merged, cfg)
      used.push(file)
    }
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
  const personaFile = merged.prependFile || env?.OPENCODE_DS_PURGE_PERSONA || ""
  if (personaFile) {
    const loaded = readPersonaFile(personaFile)
    if (loaded.error) personaError = loaded.error
    else if (loaded.text) {
      persona = loaded.text
      personaBytes = loaded.bytes
    }
  }

  const unknownKeys = Object.keys(merged).filter((key) => !KNOWN_KEYS.has(key))

  return {
    ...merged,
    prepend: persona,
    // 注入块 = 人格 + 桥接。桥接紧跟在人格后面、别人的提示词前面，用来说明
    // 「你的声音」和「你的分工」两段设定怎么同时成立，免得两边硬约束互相打架。
    injection: [persona.trim(), String(merged.bridge ?? "").trim()].filter(Boolean).join("\n\n"),
    personaError,
    personaBytes,
    personaFile,
    configFiles: used,
    unknownKeys,
    presetName: PRESETS[merged.preset] ? merged.preset : "identity",
    modeName: merged.mode === "replace" ? "replace" : "strip",
    // late 座位启用后，prepend / append 由它自己注入。这里再注入一次会让文本
    // 出现两遍（每个阶段一遍），模型会当成两条独立的指令来读。
    injectInContext: merged.late !== true,
    replaceKeep: Array.isArray(merged.replaceKeep) ? merged.replaceKeep.map(String) : [],
    lateMode: merged.lateMode === "prepend" || merged.lateMode === "replace" ? merged.lateMode : "inherit",
    latePosition: merged.latePosition === "tail" ? "tail" : "head",
    lateAgents: Array.isArray(merged.lateAgents) ? merged.lateAgents.map(String) : [],
    lateKinds: Array.isArray(merged.lateKinds) ? merged.lateKinds.map(String) : ["primary"],
    agents: Array.isArray(merged.agents) ? merged.agents.map(String) : [],
    stripSections,
    keepSections: asRegExpList(merged.keepSections),
    identity,
    extraLines: asRegExpList(merged.extraLines),
    dropParts: [...(preset.dropParts ?? []), ...asRegExpList(merged.extraParts)],
    dumpPath: merged.dump || env?.OPENCODE_DS_PURGE_DUMP || "",
    maxChars: Number.isFinite(Number(merged.maxChars)) && Number(merged.maxChars) > 0 ? Number(merged.maxChars) : DEFAULTS.maxChars,
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
  const seen = new Set()
  for (const part of parts) {
    const text = typeof part?.text === "string" ? part.text : ""
    const kind = classifyPart(text)
    report.parts.push({ kind, chars: text.length })
    if (!keep.has(kind) || !text) {
      report.droppedParts.push(`${kind}:${text.slice(0, 60).replace(/\s+/g, " ")}`)
      continue
    }
    if (cfg.dedupeParts && seen.has(text.trim())) {
      report.droppedParts.push(`${kind}:dup`)
      continue
    }
    seen.add(text.trim())
    out.push(part)
  }

  const head = addHead("", cfg)
  const append = String(cfg.append ?? "").trim()
  if (head) out.unshift({ type: "text", text: head })
  if (append) out.push({ type: "text", text: append })
  return out
}

// ---------------------------------------------------------------- 清洗主体

const FENCE = /^\s*(```|~~~)/
const ATX = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const SETEXT_H1 = /^\s{0,3}=+\s*$/

// 标题匹配前先归一：去编号、去粗体/行内代码、去首尾冒号、压空格。
// `## 1. Tone and Style**` 与 `## Tone and style:` 归一后都是 "tone and style"。
export function normalizeHeading(title) {
  return String(title ?? "")
    .replace(/^[\s#>*_`]+/, "")
    .replace(/[\s#:*_`：:、]+$/, "")
    .replace(/^\(?\d+(?:\.\d+)*[.)、]?\s+/, "")
    .replace(/^第[一二三四五六七八九十百零\d]+[章节部分]\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

// 逐行扫描提示词，维护一个「层级 → 是否删除」的状态表。砍掉一段连它的子段
// 一起带走；keep 命中的标题连同子树恢复。缺级标题（`###` 直接跟在 `#` 后面）
// 按最近的祖先继承，旧实现在空位上取 .dropped 会抛 TypeError 并让整个清洗失效。
export function stripSections(text, strip, keep, report) {
  const lines = text.split("\n")
  const state = new Map() // level -> dropped
  const out = []
  let fence = false
  let bodyDropped = false

  const applyHeading = (level, title) => {
    for (const key of [...state.keys()]) if (key > level) state.delete(key)
    let inherited = false
    for (let l = level - 1; l >= 1; l -= 1) {
      if (state.has(l)) {
        inherited = state.get(l)
        break
      }
    }
    const normalized = normalizeHeading(title)
    const protectedHere = matchesAny(normalized, keep) || matchesAny(String(title).trim(), keep)
    const dropped = protectedHere ? false : inherited || matchesAny(normalized, strip) || matchesAny(String(title).trim(), strip)
    state.set(level, dropped)
    bodyDropped = dropped
    return dropped
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    if (FENCE.test(line)) {
      fence = !fence
      if (!bodyDropped) out.push(line)
      continue
    }

    if (!fence) {
      const atx = ATX.exec(line)
      if (atx) {
        const dropped = applyHeading(atx[1].length, atx[2])
        if (!dropped) out.push(line)
        else if (report) report.sections.push(String(atx[2]).trim())
        continue
      }
      // setext 一级标题：`Title` + 下一行全 `=`。只认 `=`，不认 `---`——
      // `---` 在 markdown 里同时是分隔线和 frontmatter 边界，误判会把正文吃掉。
      const next = lines[i + 1] ?? ""
      if (line.trim() && SETEXT_H1.test(next)) {
        const dropped = applyHeading(1, line.trim())
        if (!dropped) {
          out.push(line)
          out.push(next)
        } else if (report) report.sections.push(line.trim())
        i += 1
        continue
      }
    }

    if (bodyDropped) continue
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

// ------------------------------------------------------------- 注入幂等

// 人格指纹：取注入块归一化后的前 48 个字符。够唯一，又不会因为文件尾部
// 改两个字就整段重插。
export function injectionKey(cfg) {
  const text = String(cfg?.injection ?? "").trim()
  if (text.length < 16) return ""
  return text.replace(/\s+/g, " ").slice(0, 48)
}

export function hasInjection(text, key) {
  if (!key) return false
  return String(text ?? "").replace(/\s+/g, " ").includes(key)
}

function addHead(text, cfg) {
  const injection = String(cfg?.injection ?? "").trim()
  if (!injection) return text
  if (hasInjection(text, cfg?.injectionKey ?? injectionKey(cfg))) return text
  return `${injection}\n\n${text}`.trim()
}

function addTail(text, cfg) {
  const append = String(cfg?.append ?? "").trim()
  if (!append) return text
  return `${text}\n\n${append}`.trim()
}

export function purgeSystem(parts, cfg, meta = {}) {
  const report = {
    agent: meta.agent,
    mode: cfg.modeName,
    sections: [],
    paragraphs: [],
    lines: [],
    droppedParts: [],
    parts: [],
    charsBefore: 0,
    charsAfter: 0,
    saved: 0,
  }
  if (!Array.isArray(parts)) return { parts, report }

  if (cfg.agents.length > 0 && !cfg.agents.includes(String(meta.agent ?? ""))) {
    return { parts, report, skipped: "agent" }
  }

  report.charsBefore = parts.reduce((sum, part) => sum + charCount(part?.text), 0)
  if (report.charsBefore > cfg.maxChars) {
    report.charsAfter = report.charsBefore
    return { parts, report, skipped: "too-large" }
  }

  if (cfg.modeName === "replace") {
    const next = takeover(parts, cfg, report)
    report.charsAfter = next.reduce((sum, part) => sum + charCount(part?.text), 0)
    report.saved = report.charsBefore - report.charsAfter
    return { parts: next, report }
  }

  const key = injectionKey(cfg)
  const seen = new Set()
  const next = []
  for (const part of parts) {
    const text = part?.text
    if (typeof text !== "string") {
      next.push(part)
      continue
    }

    if (cfg.dropEnv && classifyPart(text) === "env") {
      report.droppedParts.push(`env:${text.slice(0, 60).replace(/\s+/g, " ")}`)
      continue
    }

    if (cfg.dropParts.length > 0 && matchesAny(text, cfg.dropParts)) {
      report.droppedParts.push(text.slice(0, 80))
      continue
    }

    const purged = purgeText(text, cfg, report)
    if (!purged.trim()) {
      report.droppedParts.push(`emptied:${text.slice(0, 60).replace(/\s+/g, " ")}`)
      continue
    }

    if (cfg.dedupeParts) {
      const flat = purged.trim()
      if (seen.has(flat)) {
        report.droppedParts.push(`dup:${flat.slice(0, 60).replace(/\s+/g, " ")}`)
        continue
      }
      seen.add(flat)
    }

    if (purged === text) next.push(part)
    else next.push({ ...part, text: purged })
  }

  // late 座位启用时 injectInContext 为 false：注入由 late 在拼好的请求体上完成，
  // 这里再做一次会让文本重复。
  //
  // 注入保持「独立分块」而不是并进第一个分块：缓存边界干净，模型也能把它当成
  // 一段独立设定来读。重复注入由人格指纹挡住。
  if (cfg.injectInContext !== false) {
    const head = String(cfg.injection ?? "").trim()
    if (head) {
      const present = key ? next.some((part) => typeof part?.text === "string" && hasInjection(part.text, key)) : false
      if (!present) next.unshift({ type: "text", text: head })
      else report.injected = "skipped:already-present"
    }
    if (cfg.append) {
      const tail = String(cfg.append).trim()
      if (tail) next.push({ type: "text", text: tail })
    }
  }

  report.charsAfter = next.reduce((sum, part) => sum + charCount(part?.text), 0)
  report.saved = report.charsBefore - report.charsAfter
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
    charsBefore: slots.reduce((sum, slot) => sum + slot.get().length, 0),
    charsAfter: 0,
    saved: 0,
  }

  const key = injectionKey(cfg)
  const position = cfg.latePosition === "tail" ? slots.length - 1 : 0

  if (mode === "prepend") {
    // 注入块落在指定槽位最前面：人格 → 桥接 → 别人的提示词，顺序固定，
    // 这样「怎么合并」那段一定紧跟在人格后面、在编排规则前面。
    const head = String(cfg.injection ?? "").trim()
    if (head && !hasInjection(slots[position].get(), key)) {
      slots[position].set(`${head}\n\n${slots[position].get()}`.trim())
      report.injected = head.slice(0, 120)
    } else if (head) {
      report.injected = "skipped:already-present"
    }
    const last = slots[slots.length - 1]
    if (cfg.append) last.set(addTail(last.get(), cfg))
    report.charsAfter = slots.reduce((sum, slot) => sum + slot.get().length, 0)
    report.saved = report.charsBefore - report.charsAfter
    return report
  }

  if (mode === "replace") {
    const parts = slots.map((slot) => ({ type: "text", text: slot.get() }))
    const result = purgeSystem(parts, cfg, meta)
    for (const field of ["sections", "paragraphs", "lines", "droppedParts", "parts"]) report[field] = result.report[field]

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
    report.charsAfter = slots.reduce((sum, slot) => sum + slot.get().length, 0)
    report.saved = report.charsBefore - report.charsAfter
    return report
  }

  for (const slot of slots) slot.set(purgeText(slot.get(), cfg, report))

  if (cfg.injection) {
    const target = slots[position]
    if (target) target.set(addHead(target.get(), cfg))
  }
  const last = slots[slots.length - 1]
  if (cfg.append && last) last.set(addTail(last.get(), cfg))

  report.charsAfter = slots.reduce((sum, slot) => sum + slot.get().length, 0)
  report.saved = report.charsBefore - report.charsAfter
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
  const saved = Number.isFinite(report.saved) ? ` 省=${report.saved}B` : ""
  return `${PLUGIN_ID}: 段落=${report.sections.length} 身份段=${report.paragraphs.length} 行=${report.lines.length} 分块=${report.droppedParts.length}${saved}`
}

function dumpState(dumpPath, payload) {
  if (!dumpPath) return
  try {
    fs.mkdirSync(path.dirname(dumpPath), { recursive: true })
    fs.writeFileSync(dumpPath, JSON.stringify(payload, null, 2))
  } catch {}
}

// 一条命令看清插件当前状态：读了哪些配置、人格文件是否可读、预设/模式、
// 有没有写错的键名。不启动宿主也能跑：
//   node -e "import('.../opencode-ds-purge.js').then(m=>console.log(m.doctor()))"
export function doctor({ options, projectDir, homeDir, env } = {}) {
  const cfg = resolveConfig({ options, projectDir, homeDir, env })
  return {
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    enabled: cfg.enabled,
    preset: cfg.presetName,
    mode: cfg.modeName,
    late: cfg.late,
    lateMode: cfg.lateMode,
    lateAgents: cfg.lateAgents,
    agents: cfg.agents,
    configFiles: cfg.configFiles,
    personaFile: cfg.personaFile,
    personaError: cfg.personaError || null,
    personaBytes: cfg.personaBytes,
    injectionChars: cfg.injection.length,
    stripSections: cfg.stripSections.length,
    identityPatterns: cfg.identity.length,
    keepSections: cfg.keepSections.length,
    dropParts: cfg.dropParts.length,
    maxChars: cfg.maxChars,
    dedupeParts: cfg.dedupeParts,
    unknownKeys: cfg.unknownKeys,
  }
}

// 规则集自检：喂固定样例，断言该删的删了、该留的留着。改完正则跑一次，
// 比在宿主里靠眼睛看 dump 快得多。
export function selfTest(cfgOverrides = {}) {
  // 自检必须与真实配置隔离：否则本机 ds-purge.json 里的 prependFile 会把
  // 夹具人格顶掉，断言就变成在测另一份配置。
  const cfg = resolveConfig({
    options: { preset: "rules", late: false, prepend: "PERSONA-HEAD-MARKER-0123456789", ...cfgOverrides },
    projectDir: "",
    homeDir: path.join(os.tmpdir(), "opencode-ds-purge-selftest-none"),
    env: {},
  })
  const checks = []
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail })

  const section = purgeText("# Title\n\n## Tone and style\nBe brief.\n\n## 1. Behavior**\nDo not lie.\n\n## Custom\nKeep me.\n", cfg, { sections: [], paragraphs: [], lines: [], droppedParts: [] })
  check("atx 段落被删", !/Be brief/.test(section), section.slice(0, 60))
  check("编号+粗体标题被归一后删掉", !/Do not lie/.test(section), section.slice(0, 60))
  check("未命中的段落保留", /Keep me/.test(section))
  check("正文标题行保留", /# Title/.test(section))

  const gapReport = { sections: [], paragraphs: [], lines: [], droppedParts: [] }
  const gap = stripSections("# Behavior\nsecret\n### Deep\nmore secret\n", cfg.stripSections, [], gapReport)
  check("缺级标题不抛错", typeof gap === "string")
  check("缺级标题继承祖先删除状态", !/more secret/.test(gap), JSON.stringify(gap))

  const keepReport = { sections: [], paragraphs: [], lines: [], droppedParts: [] }
  const withKeep = stripSections("## Behavior\nsecret\n## Behavior\npublic\n", cfg.stripSections, [/^behavior$/i], keepReport)
  check("keepSections 覆盖删除规则", /secret/.test(withKeep) && /public/.test(withKeep), JSON.stringify(withKeep))

  const identity = purgeText("You are an AI assistant that edits code.\n\n保持工程简洁。\n", cfg, { sections: [], paragraphs: [], lines: [], droppedParts: [] })
  check("身份句被删", !/You are an AI assistant/.test(identity))
  check("中文正文不被误删", /保持工程简洁/.test(identity))

  const parts = [
    { type: "text", text: "## Behavior\nbe nice\n" },
    { type: "text", text: "keep this part\n" },
  ]
  const once = purgeSystem(parts, cfg, { agent: "build" })
  const twice = purgeSystem(once.parts, cfg, { agent: "build" })
  const markerCount = (list) => list.filter((part) => String(part?.text ?? "").includes("PERSONA-HEAD-MARKER")).length
  check("注入落到第一个分块", markerCount(once.parts) === 1)
  check("二次清洗不重复注入", markerCount(twice.parts) === 1, `count=${markerCount(twice.parts)}`)

  const deduped = purgeSystem([{ type: "text", text: "same\n" }, { type: "text", text: "same\n" }], cfg, { agent: "build" })
  check(
    "重复分块去重",
    deduped.parts.filter((part) => String(part?.text ?? "").includes("same")).length === 1 &&
      deduped.report.droppedParts.some((item) => item.startsWith("dup:")),
    JSON.stringify(deduped.parts.map((p) => p.text)),
  )

  const big = purgeSystem([{ type: "text", text: "x".repeat(50) }], { ...cfg, maxChars: 10 }, { agent: "build" })
  check("超限跳过", big.skipped === "too-large")

  const body = { system: "## Behavior\nbe nice\n", messages: [] }
  rewriteBody(body, { ...cfg, lateAgents: [] }, { agent: "build" }, "prepend")
  const firstLen = body.system.length
  rewriteBody(body, { ...cfg, lateAgents: [] }, { agent: "build" }, "prepend")
  check("出站重写幂等", body.system.length === firstLen && body.system.split("PERSONA-HEAD-MARKER").length - 1 === 1)

  return { ok: checks.every((item) => item.ok), checks }
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

    if (cfg.verbose) {
      const where = cfg.configFiles.length ? cfg.configFiles.join(",") : "默认值"
      console.error(
        `[${PLUGIN_ID}] v${PLUGIN_VERSION} preset=${cfg.presetName} mode=${cfg.modeName} late=${cfg.late ? cfg.lateMode : "off"} agents=${cfg.lateAgents.join("|") || "*"} persona=${cfg.personaBytes}B 配置=${where}`,
      )
      if (cfg.personaError) console.error(`[${PLUGIN_ID}] 人格文件读不到：${cfg.personaError}`)
      if (cfg.unknownKeys.length) console.error(`[${PLUGIN_ID}] 配置里有未知键：${cfg.unknownKeys.join(", ")}`)
    }

    const disposers = []

    // context 钩子：v2 宿主一定有；缺失时记一条，别让插件整块挂掉。
    try {
      const reg = await ctx.session.hook("context", async (event) => {
        try {
          if (!event) return
          const isArray = Array.isArray(event.system)
          if (!isArray && typeof event.system !== "string") return
          const parts = isArray ? event.system : [{ type: "text", text: event.system }]
          const before = parts.map((part) => part?.text ?? "")
          const result = purgeSystem(parts, cfg, { agent: event.agent })
          if (result.skipped) return
          if (cfg.dryRun) {
            if (cfg.verbose) console.error(`[${PLUGIN_ID}] dryRun ${describe(result.report) ?? "无改动"}`)
            return
          }
          event.system = isArray ? result.parts : result.parts.map((part) => part?.text ?? "").join("\n\n")

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
      disposers.push(() => reg.dispose())
    } catch (err) {
      console.error(`[${PLUGIN_ID}] context 钩子不可用：`, err?.message ?? err)
    }

    if (cfg.late) {
      try {
        const lateReg = await ctx.session.hook("http.request", async (event) => {
          try {
            if (!event?.request) return
            if (cfg.lateKinds.length > 0 && !cfg.lateKinds.includes(event.kind)) return
            const lateMode = cfg.lateMode === "inherit" ? cfg.modeName : cfg.lateMode
            const out = await rewriteRequest(event.request, cfg, { agent: event.agent }, lateMode)
            if (!out) return
            if (!cfg.dryRun) event.request = out.request
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
    const base = resolveConfig({ options, projectDir })
    // v1 没有出站请求钩子，late 座位在这条路径上不存在。不改这个开关的话，
    // late:true 的配置会让 context 注入也被关掉，人格在 v1 上等于整段丢失。
    const cfg = base.late && !base.injectInContext ? { ...base, injectInContext: true } : base

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
          if (!cfg.dryRun) output.system = toSystemStrings(parts)

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
