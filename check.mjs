// Detects which opencode generation this machine runs, so the installer and
// the user both know which hook seat is available.
//
//   node check.mjs

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function run(cmd, args) {
  // Windows resolves the launcher through a .cmd shim; spawning it directly
  // fails with EINVAL, so this goes through the shell there and spawns
  // directly everywhere else.
  if (process.platform === "win32") {
    const result = spawnSync(`${cmd} ${args.join(" ")}`, { shell: true, encoding: "utf8" })
    return result.status === 0 ? (result.stdout ?? "").trim() : null
  }
  const result = spawnSync(cmd, args, { encoding: "utf8" })
  return result.status === 0 ? (result.stdout ?? "").trim() : null
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
    // v2 added the outbound-request hook; v1 has only the system transform,
    // which runs before other plugins can re-inject anything.
    lateSeat: generation === "v2",
    fromFile: generation === "v1" ? "server" : "default { id, setup }",
  }
}

if (import.meta.filename === process.argv[1]) {
  const info = detect()
  console.log(`opencode      ${info.version}`)
  console.log(`generation    ${info.generation}`)
  console.log(`config dir    ${info.configDir}`)
  console.log(`plugin dir    ${info.pluginDir}`)
  console.log(`entry shape   ${info.fromFile}`)
  console.log(`late seat     ${info.lateSeat ? "available (http.request)" : "unavailable — other plugins can still re-inject"}`)
  console.log(`installed     ${info.installed.length ? info.installed.join(", ") : "none"}`)
}
