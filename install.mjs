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
const presetFile = requested
  ? path.resolve(requested)
  : process.argv.includes("--with-omo")
    ? path.join(import.meta.dirname, "examples", "with-omo.json")
    : null

if (presetFile) {
  if (!fs.existsSync(presetFile)) {
    console.error(`no such config: ${presetFile}`)
    process.exit(1)
  }
  fs.copyFileSync(presetFile, configPath)
  console.log(`config   -> ${configPath} (from ${path.basename(presetFile)})`)
} else if (fs.existsSync(configPath)) {
  console.log(`config   -> ${configPath} (kept as is)`)
} else {
  fs.writeFileSync(configPath, JSON.stringify({ mode: "strip", preset: "identity" }, null, 2) + "\n")
  console.log(`config   -> ${configPath}`)
}

console.log(`\nhost      ${info.version} (${info.generation}), entry ${info.fromFile}`)
if (!info.lateSeat) {
  console.log("warning   v1 has no outbound-request hook: other plugins can re-inject after this runs")
}
console.log("\nnext: restart opencode, then start a new conversation")
console.log("  opencode service restart")
