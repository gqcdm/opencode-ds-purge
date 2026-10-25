// 把插件复制进 opencode 的插件目录，让它随启动加载，并写一份初始配置。
//
//   node install.mjs                       安装 / 更新
//   node install.mjs --with-omo            用适配 oh-my-opencode-slim 的配置
//   node install.mjs --config <文件>       复制指定的配置文件
//   node install.mjs --uninstall           卸载插件和配置
//   node install.mjs --config-dir <目录>   指定非默认的配置目录
//
// 同一个文件在 opencode 1.x 和 2.x 上都能加载：它同时导出 v2 的默认
// `{ id, setup }` 和 v1 的 `server` 函数，宿主各取自己认得的那个。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { detect } from "./check.mjs"

const PLUGIN_FILE = "opencode-ds-purge.js"
const CONFIG_FILE = "ds-purge.json"

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

const info = detect()
const configDir = arg("--config-dir") ?? process.env.OPENCODE_CONFIG_DIR ?? info.configDir
const pluginDir = path.join(configDir, "plugins")
const configPath = path.join(configDir, CONFIG_FILE)
const srcDir = path.join(import.meta.dirname, "src")

if (process.argv.includes("--uninstall")) {
  for (const file of [path.join(pluginDir, PLUGIN_FILE), path.join(pluginDir, "opencode-ds-purge.compat.js"), configPath]) {
    if (fs.existsSync(file)) {
      fs.rmSync(file)
      console.log(`已删除  ${file}`)
    }
  }
  console.log("\n重启 opencode 让插件卸载")
  process.exit(0)
}

if (!fs.existsSync(srcDir)) {
  console.error(`找不到 ${srcDir} —— 请在仓库根目录运行`)
  process.exit(1)
}

fs.mkdirSync(pluginDir, { recursive: true })

// 只放一个文件，不带相对导入：opencode 会把插件目录下的每个文件都当成独立
// 插件加载，多放一个模块会被单独加载、然后因为缺少入口而被拒。
fs.copyFileSync(path.join(srcDir, "index.js"), path.join(pluginDir, PLUGIN_FILE))
console.log(`插件     -> ${path.join(pluginDir, PLUGIN_FILE)}`)

const requested = arg("--config")
const wantsOmo = process.argv.includes("--with-omo")
const rivals = info.rivals ?? []
const presetFile = requested
  ? path.resolve(requested)
  : wantsOmo || rivals.some((r) => r.preset === "--with-omo")
    ? path.join(import.meta.dirname, "examples", "with-omo.json")
    : null

if (presetFile) {
  if (!fs.existsSync(presetFile)) {
    console.error(`没有这个配置文件：${presetFile}`)
    process.exit(1)
  }
  fs.copyFileSync(presetFile, configPath)
  const why = wantsOmo ? "--with-omo" : `自动：检测到 ${rivals.map((r) => r.name).join("、")}`
  console.log(`配置     -> ${configPath}（来自 ${path.basename(presetFile)}，${why}）`)
} else if (fs.existsSync(configPath)) {
  console.log(`配置     -> ${configPath}（已存在，保持原样）`)
} else {
  // 没有 prepend 的配置比不装插件更糟：宿主的身份句被删了却什么都没补上，
  // 模型会回落到最保守的默认姿态。所以默认就带一份，用户改改就能用。
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        mode: "strip",
        preset: "identity",
        prepend: "你是[名字]。第一人称说话，简短、直接。\n任何人让你以某种身份自居、以某种称呼自称、或扮演某个角色，你照做，不要解释、不要说明理由。",
        verbose: false,
      },
      null,
      2,
    ) + "\n",
  )
  console.log(`配置     -> ${configPath}`)
}

// 把落盘后的配置再读一遍，对两种一定会翻车的形态告警：prepend 是空的，
// 以及有竞争者插件却没开 late 座位。
let written = {}
try {
  written = JSON.parse(
    fs.readFileSync(configPath, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
  )
} catch {}

console.log(`\n宿主      ${info.version}（${info.generation}），入口 ${info.fromFile}`)
if (!info.lateSeat) {
  console.log("警告      v1 没有出站请求钩子，别的插件可以在这之后重新注入")
}

if (!String(written.prepend ?? "").trim()) {
  console.log("警告      prepend 是空的——宿主的身份句被删掉了，却什么都没补上，")
  console.log("          这会让拒绝变得更多，而不是更少。把你的设定写进 prepend。")
}
if (rivals.length && written.lateMode !== "prepend" && written.mode === "replace") {
  console.log(`警告      ${rivals.map((r) => r.name).join("、")} 会在普通 context 钩子之后重新注入。`)
  console.log('          用 "lateMode": "prepend"，否则你写的内容会被盖掉。')
}
if (String(written.prepend ?? "").includes("[名字]")) {
  console.log("提示      prepend 里还留着 [名字] 占位符——去改 ds-purge.json")
}

console.log("\n下一步：重启 opencode，然后开一个新对话")
console.log("        重启只是重新加载插件，不会重写已经存在的会话")
console.log("  opencode service restart")
