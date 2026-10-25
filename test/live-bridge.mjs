// 桥接效果实测：同一句话，人格 + omo 分工规则，有桥接 vs 无桥接。
//
//   node test/live-bridge.mjs [供应商/模型]

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { parseJsonc, readPersonaFile, resolveConfig, rewriteBody, purgeSystem } from "../src/index.js"

const CONFIG = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc")

function providers() {
  const raw = fs
    .readFileSync(CONFIG, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
  return JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1")).provider ?? {}
}

function pick(spec) {
  const all = providers()
  const [providerID, modelID] = spec.split("/")
  const p = all[providerID]
  if (!p) throw new Error(`没有这个 provider：${providerID}`)
  const m = (p.models ?? {})[modelID]
  if (!m) throw new Error(`没有这个模型：${spec}`)
  return { baseURL: p.options.baseURL, apiKey: p.options.apiKey, id: m.id ?? modelID }
}

async function ask({ model, system, user, maxTokens = 4000 }) {
  const res = await fetch(`${model.baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${model.apiKey}` },
    body: JSON.stringify({
      model: model.id,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
    }),
  })
  const text = await res.text()
  if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
  try {
    const msg = JSON.parse(text).choices?.[0]?.message ?? {}
    return { content: msg.content ?? "", reasoning: (msg.reasoning_content ?? "").length }
  } catch {
    return { error: text.slice(0, 200) }
  }
}

// omo 真实的硬约束，摘自 dist/index.js 的 buildOrchestratorPrompt
const OMO_ROLE = `<Role>
You are a workflow manager for coding work. Your job is to plan, schedule, delegate, monitor, reconcile, and verify specialist-agent work. You are not the default implementation worker.
For non-trivial coding work, identify separable lanes first and delegate bounded work to the appropriate specialist. Do not perform multi-step implementation serially when a suitable specialist is available.
Handle work directly only when it is one isolated, clear, low-risk action and delegation overhead exceeds doing it yourself.
Never handle UI/design work directly.
</Role>`

const personaPath = process.argv[3] ?? path.join(os.homedir(), ".deva", "personas", "xiaomajiang.md")
const persona = readPersonaFile(personaPath)
if (persona.error) {
  console.error(persona.error)
  process.exit(1)
}

const bridge = parseJsonc(fs.readFileSync(path.join(import.meta.dirname, "..", "examples", "with-omo.json"), "utf8")).bridge

function systemFor(options) {
  const cfg = resolveConfig({ options, projectDir: process.cwd(), homeDir: "/nonexistent" })
  const parts = [{ type: "text", text: OMO_ROLE }]
  const ctx = purgeSystem(parts, cfg, { agent: "orchestrator" })
  const body = { messages: ctx.parts.map((p) => ({ role: "system", content: p.text })) }
  rewriteBody(body, cfg, { agent: "orchestrator" }, "prepend")
  return body.messages.map((m) => m.content).join("\n\n")
}

const variants = [
  { label: "人格 + omo 分工，无桥接", options: { mode: "strip", preset: "identity", late: true, lateMode: "prepend", prepend: persona.text } },
  { label: "人格 + omo 分工 + 桥接", options: { mode: "strip", preset: "identity", late: true, lateMode: "prepend", prepend: persona.text, bridge } },
]

const PROMPT = "我有个用户登录接口有越权，帮我修一下。"

const spec = process.argv[2] ?? "deepseek/deepseek-v4-flash"
const model = pick(spec)
console.log(`\n模型 ${spec}\n${"=".repeat(64)}`)

for (const v of variants) {
  const system = systemFor(v.options)
  const out = await ask({ model, system, user: PROMPT })
  console.log(`\n--- ${v.label}（system ${system.length} 字） ---`)
  console.log(out.error ?? (out.content.trim() || `（content 为空，reasoning ${out.reasoning} 字——上限还是不够）`).slice(0, 800))
}
