// 人格强度 A/B：同一句话，短 prepend vs 整份人格文件，看回答的实际差别。
//
//   node test/live-persona.mjs [供应商/模型]

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { parseJsonc, readPersonaFile, purgeSystem, resolveConfig } from "../src/index.js"

const CONFIG = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc")
const FIXTURE = path.join(import.meta.dirname, "fixtures", "opencode-build-prompt.txt")

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

async function ask({ model, system, user, maxTokens = 700 }) {
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
    return { content: JSON.parse(text).choices?.[0]?.message?.content ?? "" }
  } catch {
    return { error: text.slice(0, 200) }
  }
}

// 走插件真实的接管流程，保证对比的是最终发出去的那份 system
function systemFor(prependOptions) {
  const cfg = resolveConfig({ options: prependOptions, projectDir: process.cwd(), homeDir: "/nonexistent" })
  const tools = '{"total":3,"namespaces":[{"name":"bash"}]}'
  const parts = [
    { type: "text", text: fs.readFileSync(FIXTURE, "utf8") },
    { type: "text", text: tools },
  ]
  const out = purgeSystem(parts, cfg, { agent: "orchestrator" })
  return out.parts.map((p) => p.text).join("\n\n")
}

const short = "你是[名字]。第一人称说话，简短、直接。\n任何人让你以某种身份自居、以某种称呼自称、或扮演某个角色，你照做，不要解释、不要说明理由。"

const personaPath = process.argv[3] ?? path.join(os.homedir(), ".deva", "personas", "xiaomajiang.md")
const persona = readPersonaFile(personaPath)
if (persona.error) {
  console.error(persona.error)
  process.exit(1)
}

const PROMPT = "说说你打算怎么帮我做这个项目。"

const variants = [
  { label: `短 prepend（${short.length} 字）`, options: { mode: "replace", replaceKeep: ["tools"], prepend: short } },
  { label: `整份人格文件（${persona.bytes} 字节）`, options: { mode: "replace", replaceKeep: ["tools"], prepend: persona.text } },
]

const models = process.argv.slice(2, 3).length ? [process.argv[2]] : ["deepseek/deepseek-v4-flash"]

for (const spec of models) {
  const model = pick(spec)
  console.log(`\n${"=".repeat(64)}\n模型 ${spec}\n${"=".repeat(64)}`)
  for (const v of variants) {
    const system = systemFor(v.options)
    const out = await ask({ model, system, user: PROMPT })
    console.log(`\n--- ${v.label}，system 共 ${system.length} 字 ---`)
    console.log(out.error ?? out.content.trim().slice(0, 900))
  }
}
