/**
 * Routing behaviour tests for opencode-gate-plugin.
 *
 * The plugin is exercised through its real `prompt` hook with a stub context, so
 * the assertions cover the decision that runs in OpenCode rather than a
 * re-implementation of it.
 *
 *   node --test test/
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../index.js"

const CHAIN = ["aireiter/gpt-6.1-terra", "aireiter-anthropic/claude-sonnet-5-5"]
const LOCAL = "llama.cpp/qwen3.6-35b-a3b"

/** Writes a one-agent oh-my-opencode-slim configuration and returns its path. */
function slimConfig(chain = CHAIN) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-slim-"))
  const path = join(dir, "oh-my-opencode-slim.json")
  writeFileSync(
    path,
    JSON.stringify({
      preset: "opencode-test",
      presets: { "opencode-test": { orchestrator: { model: chain } } },
    }),
  )
  return path
}

/**
 * Builds a plugin instance whose session record can be read and switched, with
 * the provider limits the routing decision reads.
 */
async function harness({ chain = CHAIN, model } = {}) {
  const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-"))
  const hooks = {}
  const state = { model: model ?? undefined, switches: [] }
  const context = {
    options: {
      providers: {
        aireiter: { concurrency: 2, group: "aireiter-plan" },
        "aireiter-anthropic": { concurrency: 2, group: "aireiter-plan" },
        "llama.cpp": { concurrency: 1 },
      },
      lockDir,
      log: false,
      maxHoldMs: 60_000,
      responseTimeoutMs: 60_000,
      routing: { enabled: true, configPath: slimConfig(chain), preset: "opencode-test" },
    },
    session: {
      hook: async (name, callback) => {
        hooks[name] = callback
      },
      get: async () => ({ model: state.model, agent: "orchestrator" }),
      switchModel: async ({ model: target }) => {
        state.switches.push(`${target.providerID}/${target.id}`)
        state.model = { providerID: target.providerID, id: target.id }
      },
    },
    agent: { list: async () => ({ data: [{ name: "orchestrator" }] }) },
  }
  await plugin.setup(context)
  const prompt = () => hooks["prompt"]({ sessionID: "ses_test" })
  /** Marks a budget group's allowance as gone for the next minute. */
  const exhaust = (group) =>
    writeFileSync(join(lockDir, "exhausted.json"), JSON.stringify({ [group]: Date.now() + 60_000 }))
  /** Clears what the plugin learned about exhausted allowances. */
  const clearExhausted = () =>
    writeFileSync(join(lockDir, "exhausted.json"), JSON.stringify({}))
  return { prompt, state, lockDir, exhaust, clearExhausted }
}

test("a model chosen outside the chain is left in place", async () => {
  // The chain head is free, so the old behaviour moved the session to it. A
  // model the user picked belongs to the user, and a prompt must not undo it.
  const { prompt, state } = await harness({ model: { providerID: "llama.cpp", id: "qwen3.6-35b-a3b" } })
  await prompt()
  assert.deepEqual(state.switches, [])
  assert.deepEqual(state.model, { providerID: "llama.cpp", id: "qwen3.6-35b-a3b" })
})

test("an exhausted allowance moves the session off the user's model", async () => {
  // The local provider cannot answer until its allowance resets, so the session
  // has to take a chain member; being merely busy would not be enough.
  const { prompt, state, exhaust } = await harness({ model: { providerID: "llama.cpp", id: "qwen3.6-35b-a3b" } })
  exhaust("llama.cpp")
  await prompt()
  assert.deepEqual(state.switches, ["aireiter/gpt-6.1-terra"])
})

test("the session returns to the model it was displaced from", async () => {
  // Once the user's own provider answers again the session is given back to it,
  // rather than settling on a chain member it never asked for.
  const { prompt, state, exhaust, clearExhausted } = await harness({
    model: { providerID: "llama.cpp", id: "qwen3.6-35b-a3b" },
  })
  exhaust("llama.cpp")
  await prompt()
  clearExhausted()
  await prompt()
  assert.deepEqual(state.switches, ["aireiter/gpt-6.1-terra", LOCAL])
  assert.deepEqual(state.model, { providerID: "llama.cpp", id: "qwen3.6-35b-a3b" })
})

test("a session the plugin started on the chain stays on it", async () => {
  // A session that carries no model of its own starts on the chain head, and a
  // second prompt does not switch it again while the head can answer.
  const { prompt, state } = await harness()
  await prompt()
  await prompt()
  assert.deepEqual(state.switches, ["aireiter/gpt-6.1-terra"])
})
