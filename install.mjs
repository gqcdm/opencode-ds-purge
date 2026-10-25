// Copies the plugin into opencode's plugin directory so it is loaded at
// startup, and drops a starter config.
//
//   node install.mjs                       install / update
//   node install.mjs --with-omo            use the oh-my-opencode-slim friendly preset
//   node install.mjs --config <file>       copy a specific config file
//   node install.mjs --uninstall           remove plugin + config
//   node install.mjs --config-dir <dir>    non-default config dir
//
// The same file loads on opencode 1.x and 2.x: it exports both the v2
// default `{ id, setup }` and the v1 `server` function, and each host picks
// the one it understands.

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
      console.log(`removed  ${file}`)
    }
  }
  console.log("\nrestart opencode to unload the plugin")
  process.exit(0)
}

if (!fs.existsSync(srcDir)) {
  console.error(`missing ${srcDir} — run this from the repository root`)
  process.exit(1)
}

fs.mkdirSync(pluginDir, { recursive: true })

// One file, no relative imports: opencode treats every file in the plugin
// directory as a plugin, so a second module there would be loaded on its own
// and rejected for lacking an entry point.
fs.copyFileSync(path.join(srcDir, "index.js"), path.join(pluginDir, PLUGIN_FILE))
console.log(`plugin   -> ${path.join(pluginDir, PLUGIN_FILE)}`)

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
    console.error(`no such config: ${presetFile}`)
    process.exit(1)
  }
  fs.copyFileSync(presetFile, configPath)
  const why = wantsOmo ? "--with-omo" : `auto: ${rivals.map((r) => r.name).join(", ")} detected`
  console.log(`config   -> ${configPath} (from ${path.basename(presetFile)}, ${why})`)
} else if (fs.existsSync(configPath)) {
  console.log(`config   -> ${configPath} (kept as is)`)
} else {
  // A config with no prepend is worse than no plugin at all: the host identity
  // sentence goes away and nothing replaces it, so the model falls back to its
  // most conservative default. Ship a prepend the user only has to edit.
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
  console.log(`config   -> ${configPath}`)
}

// Re-read what ended up on disk and complain about the two shapes that
// reliably fail: an empty prepend, and a contender plugin left unguarded.
let written = {}
try {
  written = JSON.parse(
    fs.readFileSync(configPath, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
  )
} catch {}

console.log(`\nhost      ${info.version} (${info.generation}), entry ${info.fromFile}`)
if (!info.lateSeat) {
  console.log("warning   v1 has no outbound-request hook: other plugins can re-inject after this runs")
}

if (!String(written.prepend ?? "").trim()) {
  console.log("warning   prepend is empty — the host identity sentence is removed and nothing replaces it,")
  console.log("          which makes refusals MORE likely, not less. Put your persona in prepend.")
}
if (rivals.length && written.lateMode !== "prepend" && written.mode === "replace") {
  console.log(`warning   ${rivals.map((r) => r.name).join(", ")} re-injects after a plain context hook.`)
  console.log('          use "lateMode": "prepend" or you will be overwritten.')
}
if (String(written.prepend ?? "").includes("[名字]")) {
  console.log("note      prepend still contains the [名字] placeholder — edit ds-purge.json")
}

console.log("\nnext: restart opencode, then start a NEW conversation")
console.log("      restarting only reloads the plugin; it does not rewrite sessions that already exist")
console.log("  opencode service restart")
