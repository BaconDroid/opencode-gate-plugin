/**
 * Behaviour tests for opencode-gate-plugin.
 *
 * The plugin is exercised through its real hooks with a stub context, so the
 * assertions cover the code that runs in OpenCode rather than a re-implementation
 * of it.
 *
 *   node --test test/
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../index.js"

/** Builds a plugin instance with stub hooks and a throwaway lock directory. */
async function harness(providerOptions = {}, options = {}) {
  const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-"))
  const hooks = {}
  const context = {
    options: {
      providers: providerOptions,
      lockDir,
      log: false,
      maxHoldMs: 60_000,
      responseTimeoutMs: 60_000,
      ...options,
    },
    session: {
      hook: async (name, callback) => {
        hooks[name] = callback
      },
    },
  }
  await plugin.setup(context)
  const slots = (group) => {
    try {
      return readdirSync(join(lockDir, group)).filter((entry) => entry.startsWith("slot-"))
    } catch {
      return []
    }
  }
  return { hooks, slots, lockDir }
}

const request = () => new Request("https://provider.example/v1/chat/completions", { method: "POST" })

/** Drives one request through the acquire and release hooks. */
async function drive(hooks, providerID, holdMs) {
  const req = request()
  const started = Date.now()
  await hooks["http.request"]({ model: { providerID }, request: req })
  const acquiredAt = Date.now() - started
  let close
  const body = new ReadableStream({
    start(controller) {
      close = () => controller.close()
    },
  })
  await new Promise((resolve) => setTimeout(resolve, holdMs))
  const event = { model: { providerID }, request: req, response: new Response(body, { status: 200 }) }
  await hooks["http.response"](event)
  close()
  await event.response.text().catch(() => {})
  return acquiredAt
}

test("a provider gets its own limit", async () => {
  const { hooks } = await harness({
    aireiter: { concurrency: 2 },
    "opencode-go": { concurrency: 4 },
  })
  const started = Date.now()
  await Promise.all([
    drive(hooks, "opencode-go", 300),
    drive(hooks, "opencode-go", 300),
    drive(hooks, "opencode-go", 300),
    drive(hooks, "opencode-go", 300),
  ])
  const elapsed = Date.now() - started
  assert.ok(elapsed < 600, `four requests against a limit of 4 took ${elapsed}ms, expected them to run in parallel`)
})

test("a request waits when the provider is saturated", async () => {
  const { hooks } = await harness({ aireiter: { concurrency: 2 } })
  const order = []
  const started = Date.now()
  await Promise.all(
    ["a", "b", "c"].map(async (tag) => {
      const req = request()
      await hooks["http.request"]({ model: { providerID: "aireiter" }, request: req })
      order.push(`${tag}@${Date.now() - started}`)
      let close
      const body = new ReadableStream({
        start(controller) {
          close = () => controller.close()
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      const event = { model: { providerID: "aireiter" }, request: req, response: new Response(body, { status: 200 }) }
      await hooks["http.response"](event)
      close()
    }),
  )
  assert.equal(order.length, 3)
  const third = Number(order[2].split("@")[1])
  assert.ok(third > 100, `the third request was admitted after ${third}ms, expected it to wait`)
})

test("providers that share a group share one budget", async () => {
  const { hooks } = await harness({
    aireiter: { concurrency: 2, group: "plan" },
    "aireiter-anthropic": { concurrency: 2, group: "plan" },
  })
  const order = []
  const started = Date.now()
  await Promise.all(
    [
      ["oai", "aireiter"],
      ["ant", "aireiter-anthropic"],
      ["oai2", "aireiter"],
    ].map(async ([tag, providerID]) => {
      const req = request()
      await hooks["http.request"]({ model: { providerID }, request: req })
      order.push(`${tag}@${Date.now() - started}`)
      let close
      const body = new ReadableStream({
        start(controller) {
          close = () => controller.close()
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      const event = { model: { providerID }, request: req, response: new Response(body, { status: 200 }) }
      await hooks["http.response"](event)
      close()
    }),
  )
  const last = Math.max(...order.map((entry) => Number(entry.split("@")[1])))
  assert.ok(last > 100, `the third request was admitted after ${last}ms, expected the shared group to serialise it`)
})

test("a provider without a configured limit is not gated", async () => {
  const { hooks } = await harness({ aireiter: { concurrency: 2 } })
  const req = request()
  const started = Date.now()
  await hooks["http.request"]({ model: { providerID: "commandcode" }, request: req })
  await hooks["http.response"]({
    model: { providerID: "commandcode" },
    request: req,
    response: new Response(null, { status: 200 }),
  })
  assert.ok(Date.now() - started < 50)
})

test("the slot is released when the body is consumed", async () => {
  const { hooks, slots } = await harness({ p: { concurrency: 4 } })
  const req = request()
  await hooks["http.request"]({ model: { providerID: "p" }, request: req })
  assert.equal(slots("p").length, 1)
  const event = { model: { providerID: "p" }, request: req, response: new Response("hello", { status: 200 }) }
  await hooks["http.response"](event)
  await event.response.text()
  assert.equal(slots("p").length, 0)
})

test("the slot is released when the body is cancelled", async () => {
  const { hooks, slots } = await harness({ p: { concurrency: 4 } })
  const req = request()
  await hooks["http.request"]({ model: { providerID: "p" }, request: req })
  const event = {
    model: { providerID: "p" },
    request: req,
    response: new Response(new ReadableStream({ start() {} }), { status: 200 }),
  }
  await hooks["http.response"](event)
  await event.response.body.cancel()
  assert.equal(slots("p").length, 0)
})

test("the slot is released when the provider rejects the request", async () => {
  const { hooks, slots } = await harness({ p: { concurrency: 4 } })
  const req = request()
  await hooks["http.request"]({ model: { providerID: "p" }, request: req })
  const event = {
    model: { providerID: "p" },
    request: req,
    response: new Response(JSON.stringify({ error: { message: "Too many concurrent requests" } }), {
      status: 429,
    }),
  }
  await hooks["http.response"](event)
  await event.response.text()
  assert.equal(slots("p").length, 0)
})

test("a request whose response never arrives releases its slot", async () => {
  const { hooks, slots } = await harness({ p: { concurrency: 4 } }, { responseTimeoutMs: 300 })
  const req = request()
  await hooks["http.request"]({ model: { providerID: "p" }, request: req })
  assert.equal(slots("p").length, 1)
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.equal(slots("p").length, 0)
})

test("a concurrency rejection is retried on the same model", async () => {
  const { hooks } = await harness({ p: { concurrency: 4 } })
  const event = {
    model: { providerID: "p" },
    error: {
      status: 429,
      type: "provider.rate-limit",
      message: "Too many concurrent requests, at most 2 in flight.",
    },
    decision: { retry: false, delay: 0 },
  }
  await hooks["retry"](event)
  assert.equal(event.decision.retry, true)
  assert.ok(event.decision.delay >= 2000)
})

test("the provider's Retry-After is never shortened", async () => {
  const { hooks } = await harness({ p: { concurrency: 4 } })
  const event = {
    model: { providerID: "p" },
    error: { status: 429, type: "provider.rate-limit", message: "Too many concurrent requests" },
    decision: { retry: true, delay: 60_000 },
  }
  await hooks["retry"](event)
  assert.equal(event.decision.delay, 60_000)
})

test("a quota rejection is not treated as a concurrency rejection", async () => {
  const { hooks } = await harness({ p: { concurrency: 4 } })
  const event = {
    model: { providerID: "p" },
    error: { status: 429, type: "provider.quota", message: "quota exceeded, rate_limit_error" },
    decision: { retry: false, delay: 0 },
  }
  await hooks["retry"](event)
  assert.equal(event.decision.retry, false)
})

test("a plain rate limit is not treated as a concurrency rejection", async () => {
  const { hooks } = await harness({ p: { concurrency: 4 } })
  const event = {
    model: { providerID: "p" },
    error: { status: 429, type: "provider.rate-limit", message: "Rate limit reached for requests per min" },
    decision: { retry: true, delay: 100 },
  }
  await hooks["retry"](event)
  assert.equal(event.decision.delay, 100)
})

test("a400 concurrency rejection is retried like a429", async () => {
  // OpenDesign rejects an eleventh request with400, not429:
  // {"code":"tier_limit_exceeded","message":"membership concurrency limit
  // exceeded: 11/10"}. The words, not the status, decide.
  const { hooks } = await harness({ p: { concurrency: 4 } })
  const event = {
    model: { providerID: "p" },
    error: {
      status: 400,
      type: "provider.invalid-request",
      message:
        '{"code":"tier_limit_exceeded","message":"membership concurrency limit exceeded: 11/10 resets 2026-11-23T23:21:00Z"}',
    },
    decision: { retry: false, delay: 0 },
  }
  await hooks["retry"](event)
  assert.equal(event.decision.retry, true)
  assert.ok(event.decision.delay >= 2000)
})

test("an ordinary400 is not a concurrency rejection", async () => {
  const { hooks } = await harness({ p: { concurrency: 4 } })
  const event = {
    model: { providerID: "p" },
    error: { status: 400, type: "provider.invalid-request", message: "invalid_request: 'messages' is required" },
    decision: { retry: false, delay: 0 },
  }
  await hooks["retry"](event)
  assert.equal(event.decision.retry, false)
  assert.equal(event.decision.delay, 0)
})

test("a provider without a configured limit has no retry hook effect", async () => {
  const { hooks } = await harness({ p: { concurrency: 4 } })
  const event = {
    model: { providerID: "other" },
    error: { status: 429, type: "provider.rate-limit", message: "Too many concurrent requests" },
    decision: { retry: false, delay: 0 },
  }
  await hooks["retry"](event)
  assert.equal(event.decision.retry, false)
})

test("the slot names the session that holds it", async () => {
  const { hooks, lockDir } = await harness({ aireiter: { concurrency: 1 } })
  const req = request()
  await hooks["http.request"]({
    sessionID: "ses_holder",
    agent: "fixer",
    model: { providerID: "aireiter" },
    request: req,
  })
  const owner = JSON.parse(readFileSync(join(lockDir, "aireiter", "slot-0", "owner"), "utf8"))
  assert.equal(owner.sessionID, "ses_holder")
  assert.equal(owner.agent, "fixer")
  assert.equal(owner.providerID, "aireiter")
  assert.equal(owner.pid, process.pid)
  assert.ok(Number.isFinite(owner.since), "the owner records when it took the slot")

  const body = new ReadableStream({ start(controller) {
    queueMicrotask(() => controller.close())
  } })
  const event = { model: { providerID: "aireiter" }, request: req, response: new Response(body, { status: 200 }) }
  await hooks["http.response"](event)
  await event.response.text().catch(() => {})
})

/** A stub provider answer: a concurrency rejection that carries a `Retry-After` header. */
const rejection = (headers) =>
  new Response(JSON.stringify({ error: { message: "Too many concurrent requests, at most 2 in flight." } }), {
    status: 429,
    headers,
  })

/** Takes a slot, delivers the answer, drains its body, and returns the slot count right after. */
async function rejectedWith(hooks, slots, headers) {
  const req = request()
  await hooks["http.request"]({ model: { providerID: "p" }, request: req })
  const event = { model: { providerID: "p" }, request: req, response: rejection(headers) }
  await hooks["http.response"](event)
  await event.response.text()
  return slots("p").length
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test("with holdReleaseForRetryAfter off, a Retry-After does not hold the slot", async () => {
  const { hooks, slots } = await harness({ p: { concurrency: 1 } })
  assert.equal(await rejectedWith(hooks, slots, { "retry-after": "1" }), 0)
})

test("with holdReleaseForRetryAfter on, the slot is held for the Retry-After seconds", async () => {
  const { hooks, slots } = await harness({ p: { concurrency: 1 } }, { holdReleaseForRetryAfter: true })
  assert.equal(await rejectedWith(hooks, slots, { "retry-after": "1" }), 1)
  await sleep(500)
  assert.equal(slots("p").length, 1, "the slot is still held half way through the Retry-After")
  await sleep(800)
  assert.equal(slots("p").length, 0, "the slot is free after the Retry-After")
})

test("with holdReleaseForRetryAfter on, a Retry-After HTTP date holds the slot", async () => {
  const { hooks, slots } = await harness({ p: { concurrency: 1 } }, { holdReleaseForRetryAfter: true })
  // An HTTP date keeps whole seconds, so a date 3s ahead parses to a hold of
  // between 2000 and 2999ms. The checks sit outside that whole band.
  const date = new Date(Date.now() + 3000).toUTCString()
  assert.equal(await rejectedWith(hooks, slots, { "retry-after": date }), 1)
  await sleep(1500)
  assert.equal(slots("p").length, 1, "the slot is still held until the date")
  await sleep(2000)
  assert.equal(slots("p").length, 0, "the slot is free after the date")
})

test("with holdReleaseForRetryAfter on, an unparseable Retry-After does not hold the slot", async () => {
  const { hooks, slots } = await harness({ p: { concurrency: 1 } }, { holdReleaseForRetryAfter: true })
  assert.equal(await rejectedWith(hooks, slots, { "retry-after": "soon" }), 0)
})

test("with holdReleaseForRetryAfter on, a response without Retry-After does not hold the slot", async () => {
  const { hooks, slots } = await harness({ p: { concurrency: 1 } }, { holdReleaseForRetryAfter: true })
  assert.equal(await rejectedWith(hooks, slots, {}), 0)
})

test("a slot held for Retry-After is still force-released by maxHoldMs", async () => {
  const { hooks, slots } = await harness(
    { p: { concurrency: 1 } },
    { holdReleaseForRetryAfter: true, maxHoldMs: 600 },
  )
  assert.equal(await rejectedWith(hooks, slots, { "retry-after": "30" }), 1)
  await sleep(900)
  assert.equal(slots("p").length, 0)
})
