// opencode-ds-purge
// Strips role / identity / rule scaffolding out of the system prompt that
// opencode v2 assembles for a session, before it reaches the provider.
//
// Host surface (opencode 2.1.x): a plugin exports { id, setup(ctx) } and
// registers hooks via ctx.session.hook("<name>", cb). The "context" hook
// receives the mutable SessionContext:
//   { sessionID, agent, model, system: SystemPart[], messages, options, tools }
// SystemPart = { type: "text", text, cache?, metadata? }
// Assigning event.system replaces the array for this request.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const PLUGIN_ID = "opencode-ds-purge"

// ---------------------------------------------------------------- presets

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

// AGENTS.md / CLAUDE.md is injected as a system chunk and outranks the host
// prompt: a persona written there survives every identity rule above unless
// the plain "You are a <role>" shape is caught too. This one is deliberately
// broader — it is opt-in through the `agentsMd` switch, not part of a preset.
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
  append: "",
  dump: "",
  verbose: false,
}

// --------------------------------------------------------------- utilities

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

// Paths, lowest priority first.
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

  return {
    ...merged,
    presetName: PRESETS[merged.preset] ? merged.preset : "identity",
    modeName: merged.mode === "replace" ? "replace" : "strip",
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

// ------------------------------------------------------------- part kinds

// opencode v2 assembles the system prompt from keyed instruction chunks
// (core/instructions, core/environment, core/skill-guidance, ...). Anything
// a plugin or an AGENTS.md adds shows up as another chunk of text, so the
// chunks have to be told apart before a takeover can decide what survives.
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

// Replace mode does not edit the host prompt, it throws it away and sends
// only the chunks named in replaceKeep plus whatever the user wrote.
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

// ---------------------------------------------------------------- the purge

const HEADER = /^(#{1,3})\s+(.+?)\s*$/
const FENCE = /^\s*(```|~~~)/

// Walk the prompt line by line, tracking the header stack, so a dropped
// section takes its subsections with it. Fenced code is never treated as
// a header.
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
  if (prepend) next.unshift({ type: "text", text: prepend })
  if (append) next.push({ type: "text", text: append })

  return { parts: next, report }
}

// ----------------------------------------------------------- the late seat

// Another plugin can register its own "context" hook after this one and put
// its identity back into the system array — the orchestrator prompt in
// oh-my-opencode-slim does exactly that when the agent is "orchestrator".
// The only seat after that is the outbound request, so the same purge is run
// once more on the finished JSON body.
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

// Rewrites the finished request body in place. Returns the report, or null
// when there was nothing to touch.
//
// mode: "replace" throws every system slot away and sends the injection plus
// whatever replaceKeep allows. "prepend" only puts the injection in front of
// the first slot and leaves everything else alone — that is the shape to use
// when another plugin's own prompt has to keep working.
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
      // the surviving prompt has to stay first; if every system slot was a
      // message and all of them emptied, put the injection back in front
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

// ------------------------------------------------------------------ plugin

function describe(report) {
  const total =
    report.sections.length + report.paragraphs.length + report.lines.length + report.droppedParts.length
  if (total === 0) return null
  return `${PLUGIN_ID}: sections=${report.sections.length} paragraphs=${report.paragraphs.length} lines=${report.lines.length} parts=${report.droppedParts.length}`
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
      if (cfg.verbose) console.error(`[${PLUGIN_ID}] disabled by config`)
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
        console.error(`[${PLUGIN_ID}] purge failed, prompt left untouched:`, err?.message ?? err)
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
              if (line) console.error(`[${PLUGIN_ID}] late ${line}`)
            }
          } catch (err) {
            console.error(`[${PLUGIN_ID}] late rewrite failed, request left untouched:`, err?.message ?? err)
          }
        })
        disposers.push(() => lateReg.dispose())
      } catch (err) {
        console.error(`[${PLUGIN_ID}] http.request hook unavailable, late seat off:`, err?.message ?? err)
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

// opencode 1.x loads a plugin as `(input, options) => Hooks` and looks for a
// named `server` export, with the system prompt arriving as string[] through
// "experimental.chat.system.transform". Everything below adapts to that shape,
// in the same file, so the plugin dir holds one loadable module and nothing
// else — opencode treats every file in that directory as a plugin.

const v1Log = (cfg, message) => {
  if (cfg.verbose) console.error(`[${PLUGIN_ID}] ${message}`)
}

// v1 hands over strings, not SystemParts; wrapping them keeps one code path.
const toSystemParts = (system) => (Array.isArray(system) ? system.map((text) => ({ type: "text", text })) : [])
const toSystemStrings = (parts) =>
  parts.map((part) => part?.text ?? "").filter((text) => text.length > 0)

export function createV1Plugin(options) {
  return async (input) => {
    const projectDir = input?.directory ?? input?.project?.worktree ?? process.cwd()
    const cfg = resolveConfig({ options, projectDir })

    if (!cfg.enabled) {
      v1Log(cfg, "disabled by config")
      return {}
    }

    v1Log(cfg, `v1 host, mode=${cfg.modeName}`)
    if (!cfg.late) {
      v1Log(cfg, "late is off, and v1 has no outbound-request hook either")
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
          if (touched > 0) v1Log(cfg, `v1 sections=${report.sections.length} lines=${report.lines.length} parts=${report.droppedParts.length}`)
        } catch (err) {
          console.error(`[${PLUGIN_ID}] v1 purge failed, prompt left untouched:`, err?.message ?? err)
        }
      },
    }
  }
}

// opencode 1.x looks for a named `server` export; 2.x uses `default`. Both
// shapes live here so one installed file works on either host.
export const server = async (input, options) => createV1Plugin(options)(input)
