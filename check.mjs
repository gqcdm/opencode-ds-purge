// 检测这台机器跑的是哪一代 opencode，安装脚本和用户都能据此知道
// 可用的钩子位置是哪一个。
//
//   node check.mjs

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function run(cmd, args) {
  // Windows 上 opencode 是个 .cmd 包装脚本，直接 spawn 会报 EINVAL，
  // 所以在 Windows 上走 shell；其他平台直接 spawn。
  if (process.platform === "win32") {
    const result = spawnSync(`${cmd} ${args.join(" ")}`, { shell: true, encoding: "utf8" })
    return result.status === 0 ? (result.stdout ?? "").trim() : null
  }
  const result = spawnSync(cmd, args, { encoding: "utf8" })
  return result.status === 0 ? (result.stdout ?? "").trim() : null
}

// 读 opencode 自己的配置里的插件列表，好让安装脚本判断有没有会抢钩子的插件
// （也就是自己注册了 "context" 钩子的那种）。oh-my-opencode-slim 就是典型：
// 它会在普通的 context 钩子跑完之后，再把 orchestrator 提示词塞回去。
const CONTENDERS = [
  { match: /oh-my-opencode/i, name: "oh-my-opencode-slim", preset: "--with-omo" },
  { match: /opencode-dcp/i, name: "opencode-dcp", preset: null },
]

export function pluginDeclarations(configDir) {
  const names = []
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    const full = path.join(configDir, file)
    if (!fs.existsSync(full)) continue
    try {
      const raw = fs
        .readFileSync(full, "utf8")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
      const json = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"))
      const list = json.plugin ?? json.plugins ?? []
      for (const entry of Array.isArray(list) ? list : []) {
        const name = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : entry?.package
        if (typeof name === "string") names.push(name)
      }
    } catch {}
  }
  return names
}

export function contenders(configDir) {
  const declared = pluginDeclarations(configDir)
  return CONTENDERS.filter((c) => declared.some((name) => c.match.test(name)))
}

export function detect() {
  const version = run("opencode", ["--version"])
  const major = version ? Number((version.match(/(\d+)\.(\d+)\.(\d+)/) ?? [])[1]) : null
  const generation = major === null ? "unknown" : major >= 2 ? "v2" : "v1"

  const configDir =
    process.env.OPENCODE_CONFIG_DIR ??
    (process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
      : path.join(os.homedir(), ".config", "opencode"))

  const pluginDir = path.join(configDir, "plugins")
  const installed = fs.existsSync(pluginDir)
    ? fs
        .readdirSync(pluginDir)
        .filter((file) => /ds-purge/i.test(file))
    : []

  return {
    version: version ?? "not on PATH",
    generation,
    configDir,
    pluginDir,
    installed,
    rivals: contenders(configDir),
    // v2 才有出站请求钩子；v1 只有 system transform，那个位置在别的插件
    // 重新注入之前就执行完了，拦不住。
    lateSeat: generation === "v2",
    fromFile: generation === "v1" ? "server" : "default { id, setup }",
  }
}

if (import.meta.filename === process.argv[1]) {
  const info = detect()
  console.log(`opencode      ${info.version}`)
  console.log(`代际          ${info.generation}`)
  console.log(`配置目录      ${info.configDir}`)
  console.log(`插件目录      ${info.pluginDir}`)
  console.log(`入口形态      ${info.fromFile}`)
  console.log(`late 座位     ${info.lateSeat ? "可用（http.request）" : "不可用——别的插件仍可重新注入"}`)
  console.log(`已安装        ${info.installed.length ? info.installed.join("、") : "无"}`)
  console.log(
    `竞争者        ${info.rivals.length ? info.rivals.map((r) => r.name).join("、") + " ← 它们会在普通 context 钩子之后注入" : "未检测到"}`,
  )
}
