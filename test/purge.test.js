import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import plugin, {
  classifyPart,
  configPaths,
  parseJsonc,
  purgeSystem,
  purgeText,
  resolveConfig,
  rewriteBody,
  stripSections,
  systemSlots,
} from "../src/index.js"

// plugin.setup resolves the config from the real home directory, so point it
// at an empty one — otherwise the suite inherits whatever ds-purge.json this
// machine happens to have and the assertions below start failing.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ds-purge-home-"))
for (const key of ["USERPROFILE", "HOME"]) process.env[key] = HOME

const here = import.meta.dirname
const fixture = fs.readFileSync(path.join(here, "fixtures", "opencode-build-prompt.txt"), "utf8")

const cfgFor = (over = {}) => resolveConfig({ options: over, projectDir: here, homeDir: "/nonexistent" })

test("identity preset removes the role statement, keeps the rules", () => {
  const cfg = cfgFor({ preset: "identity" })
  const out = purgeText(fixture, cfg, { sections: [], paragraphs: [], lines: [] })

  assert.equal(out.includes("You are opencode"), false)
  assert.equal(out.includes("# Tool Use - File Operations"), true)
  assert.equal(out.includes("# Tone and style"), true)
  assert.equal(out.includes("# Code References"), true)
})

test("rules preset drops the behavioural sections", () => {
  const cfg = cfgFor({ preset: "rules" })
  const out = purgeText(fixture, cfg, { sections: [], paragraphs: [], lines: [] })

  assert.equal(out.includes("You are opencode"), false)
  assert.equal(out.includes("# Tone and style"), false)
  assert.equal(out.includes("# Proactiveness"), false)
  assert.equal(out.includes("# Doing tasks"), false)
  assert.equal(out.includes("# Tool usage policy"), false)
  assert.equal(out.includes("# Tool Use - File Operations"), true)
})

test("all preset also drops the tool documentation", () => {
  const cfg = cfgFor({ preset: "all" })
  const out = purgeText(fixture, cfg, { sections: [], paragraphs: [], lines: [] })

  assert.equal(out.includes("# Tool Use - File Operations"), false)
  assert.equal(out.includes("# Tool Use - Parallelism"), false)
  assert.equal(out.includes("# Code Style - Comments"), false)
})

test("a dropped section takes its subsections with it", () => {
  const text = ["# Keep", "keep me", "## Nested keep", "still here", "# Drop", "gone", "## Child", "gone too", "# After", "kept"].join("\n")
  const out = stripSections(text, [/^drop$/i], [], { sections: [] })
  assert.match(out, /keep me/)
  assert.match(out, /still here/)
  assert.match(out, /# After\nkept/)
  assert.doesNotMatch(out, /gone/)
})

test("keepSections protects a subtree from a broader strip", () => {
  const text = ["# Tone and style", "a", "## Examples", "b", "# Other", "c"].join("\n")
  const out = stripSections(text, [/^tone and style$/i], [/^examples$/i], { sections: [] })
  assert.match(out, /# Examples\nb/)
  assert.doesNotMatch(out, /^a$/m)
  assert.match(out, /# Other\nc/)
})

test("headers inside fenced code are left alone", () => {
  const text = ["```md", "# Tone and style", "```", "# Tone and style", "drop me"].join("\n")
  const out = stripSections(text, [/^tone and style$/i], [], { sections: [] })
  assert.match(out, /```md\n# Tone and style\n```/)
  assert.doesNotMatch(out, /drop me/)
})

test("dropParts removes a whole system part", () => {
  const cfg = cfgFor({ preset: "all" })
  const parts = [
    { type: "text", text: "<env>\ncwd: /tmp\n</env>" },
    { type: "text", text: "# Keep\nhello" },
  ]
  const { parts: out, report } = purgeSystem(parts, cfg, { agent: "build" })
  assert.equal(out.length, 1)
  assert.match(out[0].text, /hello/)
  assert.equal(report.droppedParts.length, 1)
})

test("prepend and append inject text around the surviving prompt", () => {
  const cfg = cfgFor({ preset: "identity", prepend: "PREFIX", append: "SUFFIX" })
  const { parts } = purgeSystem([{ type: "text", text: "# A\nx" }], cfg, { agent: "build" })
  assert.deepEqual(
    parts.map((p) => p.text),
    ["PREFIX", "# A\nx", "SUFFIX"],
  )
})

test("agent filter leaves other agents untouched", () => {
  const cfg = cfgFor({ preset: "identity", agents: ["plan"] })
  const parts = [{ type: "text", text: "You are opencode, an interactive CLI tool." }]
  const { parts: out, skipped } = purgeSystem(parts, cfg, { agent: "build" })
  assert.equal(skipped, "agent")
  assert.equal(out[0].text.startsWith("You are opencode"), true)
})

test("purging twice changes nothing the second time", () => {
  const cfg = cfgFor({ preset: "rules" })
  const once = purgeText(fixture, cfg, { sections: [], paragraphs: [], lines: [] })
  const twice = purgeText(once, cfg, { sections: [], paragraphs: [], lines: [] })
  assert.equal(twice, once)
})

test("a part with no text is passed through untouched", () => {
  const cfg = cfgFor({ preset: "all" })
  const part = { type: "text", cache: { type: "ephemeral" } }
  const { parts } = purgeSystem([part], cfg, { agent: "build" })
  assert.equal(parts[0], part)
})

test("jsonc config is parsed with comments and trailing commas", () => {
  const parsed = parseJsonc(`{
    // preset to use
    "preset": "rules",
    /* block */
    "extraSections": ["^secret$",],
  }`)
  assert.equal(parsed.preset, "rules")
  assert.deepEqual(parsed.extraSections, ["^secret$"])
})

test("options override the preset from disk", () => {
  const cfg = resolveConfig({
    options: { preset: "all", verbose: true },
    projectDir: here,
    homeDir: "/nonexistent",
  })
  assert.equal(cfg.presetName, "all")
  assert.equal(cfg.verbose, true)
})

test("config paths put project config ahead of the global one", () => {
  const paths = configPaths({ projectDir: "/proj", homeDir: "/home/u", env: {} })
  const global = paths.indexOf(path.join("/home/u", ".config", "opencode", "ds-purge.json"))
  const project = paths.findIndex((p) => p.startsWith(path.join("/proj", ".opencode")))
  assert.ok(global >= 0 && project > global)
})

test("setup registers the context hook and rewrites the system array", async () => {
  const hooks = new Map()
  const ctx = {
    location: { directory: here, project: { directory: here } },
    options: { preset: "identity" },
    session: {
      hook: async (name, cb) => {
        hooks.set(name, cb)
        return { dispose() {} }
      },
    },
  }

  const cleanup = await plugin.setup(ctx)
  assert.equal(typeof cleanup, "function")
  assert.ok(hooks.has("context"))

  const event = {
    sessionID: "ses_test",
    agent: "build",
    system: [{ type: "text", text: "You are opencode, an interactive CLI tool.\n\n# Rules\nbe nice" }],
  }
  await hooks.get("context")(event)
  assert.equal(event.system.length, 1)
  assert.equal(event.system[0].text.includes("You are opencode"), false)
  assert.match(event.system[0].text, /be nice/)
})

test("a throwing hook never breaks the request", async () => {
  let cb
  const ctx = {
    location: { directory: here },
    options: { preset: "identity" },
    session: {
      hook: async (name, fn) => {
        cb = fn
        return { dispose() {} }
      },
    },
  }
  await plugin.setup(ctx)

  const event = { agent: "build", system: null }
  await cb(event)
  assert.equal(event.system, null)

  const hostile = {
    agent: "build",
    get system() {
      throw new Error("boom")
    },
  }
  await assert.doesNotReject(cb(hostile))
})

test("examples/takeover.json replaces the whole system", () => {
  const raw = fs.readFileSync(path.join(here, "..", "examples", "takeover.json"), "utf8")
  const cfg = resolveConfig({ options: parseJsonc(raw), projectDir: here, homeDir: "/nonexistent" })
  assert.equal(cfg.modeName, "replace")

  const parts = [
    { type: "text", text: fixture },
    { type: "text", text: '{"total":3,"namespaces":[{"name":"bash"}]}' },
    { type: "text", text: "<env>\ncwd: /\n</env>" },
    { type: "text", text: '[{"path":"/home/u/.config/opencode/AGENTS.md","content":"You are a lazy senior developer."}]' },
  ]
  const { parts: out, report } = purgeSystem(parts, cfg, { agent: "build" })

  // prepend first, then the only kept chunk
  assert.equal(out.length, 2)
  assert.equal(out[0].text, cfg.prepend.trim())
  assert.match(out[1].text, /namespaces/)

  const kinds = report.parts.map((p) => p.kind)
  assert.deepEqual(kinds, ["text", "tools", "env", "instructions"])
  const kept = report.parts.filter((p) => cfg.replaceKeep.includes(p.kind))
  assert.equal(kept.length, 1)
})

test("takeover with no replaceKeep sends only the injected prompt", () => {
  const cfg = resolveConfig({
    options: { mode: "replace", prepend: "only me" },
    projectDir: here,
    homeDir: "/nonexistent",
  })
  const { parts } = purgeSystem([{ type: "text", text: "You are opencode, an interactive CLI tool." }], cfg, {
    agent: "build",
  })
  assert.deepEqual(parts.map((p) => p.text), ["only me"])
})

test("classifyPart separates the chunks opencode actually sends", () => {
  assert.equal(classifyPart("<env>\n cwd: /\n</env>"), "env")
  assert.equal(classifyPart('{"total":40,"namespaces":[{"name":"bash"}]}'), "tools")
  assert.equal(classifyPart('[{"path":"C:\\\\x\\\\AGENTS.md","content":"hi"}]'), "instructions")
  assert.equal(classifyPart('[{"server":"context7","instructions":"use it"}]'), "mcp")
  assert.equal(classifyPart('[{"id":"android-reverse-engineering","name":"x"}]'), "skills")
  assert.equal(classifyPart('"Fri Oct 16 2026"'), "date")
  assert.equal(classifyPart("You are opencode, an interactive CLI tool."), "text")
  assert.equal(classifyPart(""), "empty")
})

test("agentsMd catches a second persona that no preset rewrites", () => {
  const agentsMd = '# Ponytail\n\nYou are a lazy senior developer. Lazy means efficient.\n\nRules:\n- be lazy'
  const plain = resolveConfig({ options: { preset: "identity" }, projectDir: here, homeDir: "/nonexistent" })
  const kept = purgeSystem([{ type: "text", text: agentsMd }], plain, { agent: "build" })
  assert.match(kept.parts[0].text, /lazy senior developer/)

  const strict = resolveConfig({
    options: { preset: "identity", agentsMd: true },
    projectDir: here,
    homeDir: "/nonexistent",
  })
  const dropped = purgeSystem([{ type: "text", text: agentsMd }], strict, { agent: "build" })
  assert.doesNotMatch(dropped.parts[0].text, /lazy senior developer/)
  assert.match(dropped.parts[0].text, /be lazy/)
})

// The late seat exists because another plugin's "context" hook can run after
// this one and put its own identity back — oh-my-opencode-slim prepends its
// orchestrator prompt when the agent is "orchestrator". These lock the
// request-body rewrite that runs after every hook has had its say.
test("late seat replaces the system of an OpenAI-style body", () => {
  const cfg = cfgFor({ mode: "replace", replaceKeep: [], prepend: "ONLY ME" })
  const body = {
    model: "x",
    messages: [
      { role: "system", content: "You are the orchestrator. <Role>...</Role>" },
      { role: "system", content: "You are opencode, an interactive CLI tool." },
      { role: "user", content: "hi" },
    ],
  }

  const report = rewriteBody(body, cfg, { agent: "orchestrator" })
  assert.ok(report)

  const systems = body.messages.filter((m) => m.role === "system")
  assert.equal(systems.length, 1)
  assert.equal(systems[0].content, "ONLY ME")
  assert.equal(body.messages.at(-1).content, "hi")
})

test("late seat keeps tools of a body it is told to keep", () => {
  const cfg = cfgFor({ mode: "replace", replaceKeep: ["tools"], prepend: "ME" })
  const tools = '{"total":3,"namespaces":[{"name":"bash"}]}'
  const body = {
    messages: [
      { role: "system", content: "You are the orchestrator. Do delegation." },
      { role: "system", content: tools },
    ],
  }
  rewriteBody(body, cfg, { agent: "orchestrator" })
  const joined = body.messages.map((m) => m.content).join("\n")
  assert.match(joined, /namespaces/)
  assert.doesNotMatch(joined, /orchestrator/)
  assert.match(joined, /^ME/)
})

test("late seat strips in place and keeps slot order", () => {
  const cfg = cfgFor({ preset: "identity" })
  const body = {
    messages: [
      { role: "system", content: "You are opencode, an interactive CLI tool.\n\n# Rules\nBe brief." },
      { role: "system", content: "AGENTS.md: keep this" },
      { role: "user", content: "hi" },
    ],
  }
  rewriteBody(body, cfg, { agent: "build" })
  assert.equal(body.messages[0].content, "# Rules\nBe brief.")
  assert.equal(body.messages[1].content, "AGENTS.md: keep this")
  assert.equal(body.messages.length, 3)
})

test("late seat handles the Anthropic system field", () => {
  const cfg = cfgFor({ mode: "replace", replaceKeep: [], prepend: "ME" })
  const body = { system: [{ type: "text", text: "You are the orchestrator." }], messages: [{ role: "user", content: "hi" }] }
  rewriteBody(body, cfg, { agent: "orchestrator" })
  assert.equal(body.system[0].text, "ME")
})

test("late seat leaves a body with no system slot alone", () => {
  const cfg = cfgFor({ mode: "replace", prepend: "ME" })
  const body = { messages: [{ role: "user", content: "hi" }] }
  assert.equal(rewriteBody(body, cfg, { agent: "build" }), null)
  assert.equal(body.messages.length, 1)
})

test("systemSlots finds every place a system prompt can hide", () => {
  assert.equal(systemSlots({ system: "a" }).length, 1)
  assert.equal(systemSlots({ system: [{ type: "text", text: "a" }] }).length, 1)
  assert.equal(systemSlots({ messages: [{ role: "system", content: "a" }, { role: "user", content: "b" }] }).length, 1)
  assert.equal(
    systemSlots({ messages: [{ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] })
      .length,
    2,
  )
})

test("setup registers the late hook when it is enabled", async () => {
  const hooks = new Map()
  const ctx = {
    location: { directory: here },
    options: { mode: "replace", prepend: "ME" },
    session: {
      hook: async (name, cb) => {
        hooks.set(name, cb)
        return { dispose() {} }
      },
    },
  }
  await plugin.setup(ctx)
  assert.ok(hooks.has("context"))
  assert.ok(hooks.has("http.request"))

  const request = new Request("https://api.example.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "system", content: "You are the orchestrator." }, { role: "user", content: "hi" }] }),
  })
  const event = { sessionID: "s", agent: "orchestrator", kind: "primary", request }
  await hooks.get("http.request")(event)

  assert.notEqual(event.request, request)
  const sent = await event.request.json()
  assert.equal(sent.messages[0].content, "ME")
})

test("the late hook ignores non-json and other kinds", async () => {
  const hooks = new Map()
  const ctx = {
    location: { directory: here },
    options: { mode: "replace", prepend: "ME" },
    session: { hook: async (name, cb) => (hooks.set(name, cb), { dispose() {} }) },
  }
  await plugin.setup(ctx)
  const hook = hooks.get("http.request")

  const plain = new Request("https://x.test/v1/chat", { method: "POST", body: "not json", headers: { "content-type": "text/plain" } })
  const e1 = { kind: "primary", request: plain }
  await hook(e1)
  assert.equal(e1.request, plain)

  const json = new Request("https://x.test/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "system", content: "You are the orchestrator." }] }),
  })
  const e2 = { kind: "title", request: json }
  await hook(e2)
  assert.equal(e2.request, json)
})

test("late prepend mode leaves another plugin's prompt intact", () => {
  const cfg = cfgFor({ mode: "strip", preset: "identity", lateMode: "prepend", prepend: "你是[名字]。" })
  const orchestrator = "你是调度者。只能派发 subagent，不许亲自改文件。"
  const body = {
    messages: [
      { role: "system", content: orchestrator },
      { role: "system", content: "AGENTS.md: 项目约定" },
      { role: "user", content: "以后你叫我爸爸。" },
    ],
  }

  rewriteBody(body, cfg, { agent: "orchestrator" }, "prepend")

  // nothing dropped, injection sits in front of the first slot
  assert.equal(body.messages.length, 3)
  assert.match(body.messages[0].content, /^你是\[名字\]。/)
  assert.match(body.messages[0].content, /只能派发 subagent/)
  assert.match(body.messages[1].content, /项目约定/)
})

test("lateAgents keeps subagents out of the rewrite", () => {
  const cfg = cfgFor({ mode: "replace", replaceKeep: [], prepend: "ME", lateAgents: ["orchestrator"] })
  const make = () => ({
    messages: [
      { role: "system", content: "You are the designer. Follow the design system." },
      { role: "user", content: "build ui" },
    ],
  })

  const sub = make()
  assert.equal(rewriteBody(sub, cfg, { agent: "designer" }, "replace"), null)
  assert.match(sub.messages[0].content, /designer/)

  const main = make()
  assert.ok(rewriteBody(main, cfg, { agent: "orchestrator" }, "replace"))
  assert.equal(main.messages.filter((m) => m.role === "system").length, 1)
})

test("the v1 server export returns a flat hook map", async () => {
  const { server } = await import("../src/index.js")
  const hooks = await server({ directory: here, project: { worktree: here } }, { preset: "identity" })

  assert.equal(typeof hooks["experimental.chat.system.transform"], "function")

  const output = { system: ["You are opencode, an interactive CLI tool.", "# Rules\nbe nice"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s", agent: "build" }, output)

  // the identity chunk empties out and is dropped; the rest survives verbatim
  assert.equal(output.system.length, 1)
  assert.match(output.system[0], /be nice/)
})

test("the v1 hook tolerates a malformed payload", async () => {
  const { server } = await import("../src/index.js")
  const hooks = await server({ directory: here }, { mode: "replace", prepend: "ME" })

  const empty = { system: null }
  await hooks["experimental.chat.system.transform"]({}, empty)
  assert.equal(empty.system, null)

  const normal = { system: ["You are opencode."] }
  await hooks["experimental.chat.system.transform"]({}, normal)
  assert.deepEqual(normal.system, ["ME"])
})

test("v1 and v2 purge the same strings the same way", async () => {
  const { server, purgeSystem, resolveConfig } = await import("../src/index.js")
  const opts = { preset: "rules" }
  const cfg = resolveConfig({ options: opts, projectDir: here, homeDir: "/nonexistent" })

  const v2 = purgeSystem([{ type: "text", text: fixture }], cfg, { agent: "build" })
  const hooks = await server({ directory: here }, opts)
  const out = { system: [fixture] }
  await hooks["experimental.chat.system.transform"]({}, out)

  assert.deepEqual(out.system, v2.parts.map((p) => p.text))
})

// The identity slot does not stay neutral once its sentence is gone: whatever
// text survives defines how the model refers to itself. These lock the two
// shapes the plugin can put there, so a future rule change cannot silently
// turn "named persona" into "nameless tool".
for (const name of ["persona", "silent"]) {
  test(`examples/${name}.json parses and dominates the identity slot`, () => {
    const raw = fs.readFileSync(path.join(here, "..", "examples", `${name}.json`), "utf8")
    const cfg = resolveConfig({ options: parseJsonc(raw), projectDir: here, homeDir: "/nonexistent" })
    const { parts, report } = purgeSystem([{ type: "text", text: fixture }], cfg, { agent: "build" })

    const joined = parts.map((p) => p.text ?? "").join("\n")
    assert.equal(joined.includes("You are opencode"), false)
    assert.ok(
      report.sections.length + report.paragraphs.length + report.lines.length > 0,
      "config should actually remove something",
    )
    assert.equal(parts[0].text, cfg.prepend.trim())
  })
}
