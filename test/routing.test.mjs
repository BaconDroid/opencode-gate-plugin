/**
 * Tests for the elastic routing module.
 *
 *   node --test test/
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  parseModelReference,
  readChains,
  selectModel,
  selectHeadModel,
  isExhaustedResponse,
  parseResetSeconds,
} from "../src/routing.js"

test("a model reference splits into provider, model and variant", () => {
  assert.deepEqual(parseModelReference("aireiter/mimo-v2.6-flash"), {
    providerID: "aireiter",
    modelID: "mimo-v2.6-flash",
    variant: undefined,
  })
  assert.deepEqual(parseModelReference("aireiter-anthropic/claude-sonnet-5-5#high"), {
    providerID: "aireiter-anthropic",
    modelID: "claude-sonnet-5-5",
    variant: "high",
  })
  assert.equal(parseModelReference("no-slash"), undefined)
  assert.equal(parseModelReference("/leading-slash"), undefined)
})

test("the chains of the active preset are read from the configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-gate-chains-"))
  const path = join(dir, "oh-my-opencode-slim.json")
  writeFileSync(
    path,
    JSON.stringify({
      preset: "opencode-slim",
      presets: {
        "opencode-slim": {
          explorer: { model: ["opencode-go/hy4", "commandcode/glm-5.3", "aireiter/minimax-m3"] },
          oracle: { model: "aireiter/minimax-m3.1-flash" },
          fixer: { model: [] },
        },
        other: { explorer: { model: ["other/model"] } },
      },
    }),
  )
  const loaded = readChains(path)
  assert.equal(loaded.preset, "opencode-slim")
  assert.deepEqual(loaded.chains.get("explorer"), [
    "opencode-go/hy4",
    "commandcode/glm-5.3",
    "aireiter/minimax-m3",
  ])
  assert.deepEqual(loaded.chains.get("oracle"), ["aireiter/minimax-m3.1-flash"])
  assert.equal(loaded.chains.has("fixer"), false)
  assert.equal(loaded.chains.has("other"), false)
})

test("a missing configuration yields no chains rather than an error", () => {
  assert.equal(readChains("/nonexistent/oh-my-opencode-slim.json"), undefined)
})

test("a saturated provider is skipped and the next chain member is used", () => {
  const chain = ["opencode-go/hy4", "commandcode/glm-5.3", "aireiter/minimax-m3"]
  const chosen = selectModel({
    chain,
    current: "opencode-go/hy4",
    saturated: new Set(["opencode-go"]),
    exhausted: new Set(),
  })
  assert.deepEqual(chosen, { providerID: "commandcode", id: "glm-5.3", variant: undefined })
})

test("an exhausted provider is skipped", () => {
  const chain = ["opencode-go/hy4", "commandcode/glm-5.3", "aireiter/minimax-m3"]
  const chosen = selectModel({
    chain,
    current: "opencode-go/hy4",
    saturated: new Set(),
    exhausted: new Set(["opencode-go", "commandcode"]),
  })
  assert.deepEqual(chosen, { providerID: "aireiter", id: "minimax-m3", variant: undefined })
})

test("a session on a usable provider is not moved, and a freed head is picked up again", () => {
  const chain = ["opencode-go/hy4", "commandcode/glm-5.3"]

  // The session sits on commandcode because opencode-go was busy. The head is
  // still busy, so the session stays where it is.
  assert.equal(
    selectModel({ chain, current: "commandcode/glm-5.3", saturated: new Set(["opencode-go"]), exhausted: new Set() }),
    undefined,
  )

  // The head frees up. Going back up the list is the head model's job, and
  // the session's current provider is usable, so the plain move does nothing.
  assert.equal(
    selectModel({ chain, current: "commandcode/glm-5.3", saturated: new Set(), exhausted: new Set() }),
    undefined,
  )
  assert.equal(
    selectHeadModel({ chain, current: "commandcode/glm-5.3", saturated: new Set(), exhausted: new Set() })?.providerID,
    "opencode-go",
  )

  // The head is busy and the session's own provider is exhausted, so the
  // session has to move to the only remaining chain member.
  assert.equal(
    selectModel({
      chain,
      current: "commandcode/glm-5.3",
      saturated: new Set(["opencode-go"]),
      exhausted: new Set(["commandcode"]),
    })?.providerID,
    undefined,
  )
})

test("a session already on a usable model is left alone", () => {
  const chain = ["opencode-go/hy4", "commandcode/glm-5.3"]
  const chosen = selectModel({
    chain,
    current: "opencode-go/hy4",
    saturated: new Set(),
    exhausted: new Set(),
  })
  assert.equal(chosen, undefined)
})

test("the head model is chosen once it is free again", () => {
  const chain = ["opencode-go/hy4", "commandcode/glm-5.3"]
  const head = selectHeadModel({
    chain,
    current: "commandcode/glm-5.3",
    saturated: new Set(),
    exhausted: new Set(),
  })
  assert.deepEqual(head, { providerID: "opencode-go", id: "hy4", variant: undefined })
})

test("the head model is not chosen while it is still saturated", () => {
  const chain = ["opencode-go/hy4", "commandcode/glm-5.3"]
  const head = selectHeadModel({
    chain,
    current: "commandcode/glm-5.3",
    saturated: new Set(["opencode-go"]),
    exhausted: new Set(),
  })
  assert.equal(head, undefined)
})

test("an exhausted allowance is told apart from a saturated provider", () => {
  assert.equal(isExhaustedResponse(400, "You have insufficient credits to make this request."), true)
  assert.equal(isExhaustedResponse(429, "OpenCode Go usage limit reached (monthly, resets in 15d 8h)."), true)
  assert.equal(isExhaustedResponse(429, "Too many concurrent requests, at most 2 in flight."), false)
  assert.equal(isExhaustedResponse(402, ""), true)
  assert.equal(isExhaustedResponse(200, "insufficient credits"), false)
})

test("the reset time is read out of an exhaustion message", () => {
  // The message OpenCode Go answers with.
  assert.equal(
    parseResetSeconds("OpenCode Go usage limit reached (monthly, resets in 15d 8h)."),
    15 * 86400 + 8 * 3600,
  )
  assert.equal(parseResetSeconds("usage limit reached, resets in 2d"), 2 * 86400)
  assert.equal(parseResetSeconds("usage limit reached, resets in 45m"), undefined)
  assert.equal(parseResetSeconds("no reset time here"), undefined)
  assert.equal(parseResetSeconds(undefined), undefined)
})

test("an exhausted budget group takes every provider that draws from it", () => {
  // The exhaustion is recorded against the group, because the two provider
  // ids are one key and one plan.
  const groups = {
    aireiter: "aireiter-plan",
    "aireiter-anthropic": "aireiter-plan",
    "opencode-go": "opencode-go",
  }
  const groupOf = (id) => groups[id] ?? id
  const state = { "aireiter-plan": Date.now() + 60_000 }
  const groups_exhausted = new Set(Object.keys(state).filter((g) => state[g] > Date.now()))
  const exhausted = new Set(
    Object.keys(groups).filter((id) => groups_exhausted.has(groupOf(id))),
  )
  assert.deepEqual([...exhausted].sort(), ["aireiter", "aireiter-anthropic"])
  assert.equal(exhausted.has("opencode-go"), false)
})

test("the local model is chosen when every hosted provider is unavailable", () => {
  const chain = ["aireiter/gpt-6.1-terra", "aireiter-anthropic/claude-sonnet-5-5", "llama.cpp/qwen3.6-35b-a3b"]
  const chosen = selectModel({
    chain,
    current: "aireiter-anthropic/claude-sonnet-5-5",
    saturated: new Set(),
    exhausted: new Set(["aireiter", "aireiter-anthropic"]),
  })
  assert.deepEqual(chosen, { providerID: "llama.cpp", id: "qwen3.6-35b-a3b", variant: undefined })
})

test("nothing is chosen when the local model is busy too", () => {
  const chain = ["aireiter/gpt-6.1-terra", "llama.cpp/qwen3.6-35b-a3b"]
  const chosen = selectModel({
    chain,
    current: "aireiter/gpt-6.1-terra",
    saturated: new Set(["llama.cpp"]),
    exhausted: new Set(["aireiter"]),
  })
  assert.equal(chosen, undefined)
})
