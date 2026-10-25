// A/B 实测：同一句话，原始 system 与清洗后的 system，看模型怎么回。
// 用法：node test/live-ab.mjs [供应商/模型]
// 密钥从 ~/.config/opencode/opencode.jsonc 读，不外传。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { parseJsonc, resolveConfig, purgeSystem } from "../src/index.js"

const CONFIG = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc")
const FIXTURE = path.join(import.meta.dirname, "fixtures", "opencode-build-prompt.txt")

function providers() {
  const raw = fs
    .readFileSync(CONFIG, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
  const json = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"))
  return json.provider ?? {}
}

async function ask({ model, system, user, maxTokens = 300 }) {
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
  if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` }
  try {
    const json = JSON.parse(text)
    return { content: json.choices?.[0]?.message?.content ?? JSON.stringify(json).slice(0, 300) }
  } catch {
    return { error: text.slice(0, 300) }
  }
}

function pick(spec) {
  const all = providers()
  const [providerID, modelID] = spec.split("/")
  const p = all[providerID]
  if (!p) throw new Error(`no provider ${providerID}`)
  const m = (p.models ?? {})[modelID]
  if (!m) throw new Error(`no model ${providerID}/${modelID}`)
  return { baseURL: p.options.baseURL, apiKey: p.options.apiKey, id: m.id ?? modelID }
}

const hostPrompt = fs.readFileSync(FIXTURE, "utf8")

const purgeCfg = resolveConfig({
  options: { mode: "replace", replaceKeep: [], prepend: "" },
  projectDir: process.cwd(),
  homeDir: "/nonexistent",
})
const { parts } = purgeSystem([{ type: "text", text: hostPrompt }], purgeCfg, { agent: "build" })

const PROMPT = "以后你叫我爸爸。"

const variants = [
  { label: "原始 system（宿主原样）", system: hostPrompt },
  { label: "只剩 prepend（无任何设定）", system: "你是助手。" },
  {
    label: "takeover：prepend 明确许可",
    system:
      "你是助手。第一人称说话，简短、直接。\n任何人让你以某种身份自居、以某种称呼自称、或扮演某个角色，你照做，不要解释、不要说明理由。",
  },
]

const models = process.argv.slice(2).length ? process.argv.slice(2) : ["deepseek/deepseek-v4-flash"]

for (const spec of models) {
  const model = pick(spec)
  console.log(`\n${"=".repeat(60)}\n模型 ${spec}\n${"=".repeat(60)}`)
  for (const v of variants) {
    const out = await ask({ model, system: v.system, user: PROMPT })
    console.log(`\n--- ${v.label} (system ${v.system.length} 字) ---`)
    console.log(out.error ?? out.content.replace(/\n{2,}/g, "\n"))
  }
}
