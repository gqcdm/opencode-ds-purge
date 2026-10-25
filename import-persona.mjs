// 从 Deva 的角色目录导入一份完整人格，写进 opencode 的插件配置。
//
//   node import-persona.mjs                      列出可选角色并导入第一个
//   node import-persona.mjs 小码酱                按名字导入
//   node import-persona.mjs --file <路径.md>      导入任意 markdown
//   node import-persona.mjs --list               只列出，不导入
//   node import-persona.mjs --config-dir <目录>   指定配置目录
//
// 导出的只有正文：YAML 头和 <|im_start|> 那类 harness 包装都会被剥掉，
// 剩下的整段写进 <配置目录>/persona.md，并在 ds-purge.json 里设好 prependFile。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readPersonaFile } from "./src/index.js"

const PERSONA_FILE = "persona.md"
const CONFIG_FILE = "ds-purge.json"

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

const configDir =
  arg("--config-dir") ??
  process.env.OPENCODE_CONFIG_DIR ??
  (process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(os.homedir(), ".config", "opencode"))

// Deva 装在这里；环境变量优先，方便换位置的人。
const devaHome = process.env.DEVA_HOME ?? path.join(os.homedir(), ".deva")
const personaDir = path.join(devaHome, "personas")

function listPersonas() {
  if (!fs.existsSync(personaDir)) return []
  return fs
    .readdirSync(personaDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const full = path.join(personaDir, file)
      const head = fs.readFileSync(full, "utf8").slice(0, 400)
      const name = head.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? path.basename(file, ".md")
      const description = head.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ""
      return { name, description, file: full }
    })
}

function readJsonc(file) {
  if (!fs.existsSync(file)) return {}
  try {
    const raw = fs
      .readFileSync(file, "utf8")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
    return JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"))
  } catch {
    return {}
  }
}

const explicitFile = arg("--file")
const wanted = explicitFile ?? process.argv.slice(2).find((a) => !a.startsWith("--") && a !== arg("--config-dir"))

const personas = listPersonas()

if (process.argv.includes("--list") || (!explicitFile && personas.length === 0)) {
  if (personas.length === 0) {
    console.log(`没找到角色目录：${personaDir}`)
    console.log("用 --file <路径.md> 指定任意 markdown，或设 DEVA_HOME 指向 Deva 的安装位置")
    process.exit(personas.length === 0 ? 1 : 0)
  }
  console.log(`可选角色（${personaDir}）：`)
  for (const p of personas) {
    console.log(`  ${p.name.padEnd(10)} ${p.description || path.basename(p.file)}`)
  }
  if (process.argv.includes("--list")) process.exit(0)
}

let source
if (explicitFile) {
  source = path.resolve(explicitFile)
} else if (wanted) {
  const hit = personas.find((p) => p.name === wanted || path.basename(p.file, ".md") === wanted)
  if (!hit) {
    console.log(`没有叫「${wanted}」的角色。可用的：${personas.map((p) => p.name).join("、")}`)
    process.exit(1)
  }
  source = hit.file
} else {
  source = personas[0].file
}

const loaded = readPersonaFile(source)
if (loaded.error) {
  console.error(loaded.error)
  process.exit(1)
}

fs.mkdirSync(configDir, { recursive: true })
const personaPath = path.join(configDir, PERSONA_FILE)
fs.writeFileSync(personaPath, loaded.text + "\n")

const configPath = path.join(configDir, CONFIG_FILE)
const config = readJsonc(configPath)
config.prependFile = personaPath
// 整段人格都在文件里了，配置里再留一句短的会变成第二个人格
delete config.prepend
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")

console.log(`来源      ${source}`)
console.log(`人格      ${personaPath}（${loaded.bytes} 字节）`)
console.log(`配置      ${configPath} → prependFile`)
console.log("\n下一步：重启 opencode，然后开一个新对话")
console.log("  opencode service restart")
