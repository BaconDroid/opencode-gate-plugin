/**
 * opencode-gate-plugin
 *
 * Client-side concurrency gate for OpenCode providers that cap in-flight
 * requests per API key or per account.
 *
 * Why this exists:
 *   Subscription-backed inference endpoints cap how many requests may be in
 *   flight at once, and reject the excess immediately. AIReiter's Coding Plan,
 *   for example, allows 2 concurrent requests per API key and answers with
 *   HTTP 429 `{"error":{"message":"Too many concurrent requests, at most 2 in
 *   flight."}}`. The cap belongs to the key, not to a model, so it is shared by
 *   every model behind that key, by every provider definition that uses it,
 *   by every session, and by every OpenCode process on the host.
 *
 *   No configuration expresses this. oh-my-opencode-slim's
 *   `backgroundJobs.concurrency.providerConcurrency` is keyed by provider id,
 *   so it cannot express "one budget shared by two provider ids", and it
 *   throttles background task admission rather than outbound requests. The
 *   limit has to be enforced at the HTTP layer.
 *
 * How it works:
 *   - `http.request` acquires a slot before the request leaves. The hook is
 *     awaited, so a request that finds the provider saturated waits here
 *     instead of being rejected upstream.
 *   - The slot is held until the response body finishes streaming, because the
 *     provider counts a request as in flight for the whole generation, not
 *     just until the headers arrive.
 *   - Slots are coordinated across processes through lock directories, because
 *     the limit belongs to the key rather than to one OpenCode process.
 *   - Each provider gets its own limit. Providers that share an API key are
 *     declared as members of one group, and the group draws from a single
 *     budget.
 *   - A concurrency rejection that still gets through is retried on the same
 *     model, so a fallback chain is not spent on a condition that waiting
 *     resolves.
 */

import { mkdirSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

import * as Routing from "./src/routing.js"

const DEFAULTS = {
  /**
   * Provider id -> limit.
   *
   *   "aireiter":           { "concurrency": 2, "group": "aireiter-plan" }
   *   "aireiter-anthropic": { "concurrency": 2, "group": "aireiter-plan" }
   *   "opencode-go":        { "concurrency": 4 }
   *
   * `concurrency` is the number of requests that may be in flight for that
   * provider. `group` names the budget the provider draws from; providers that
   * share an API key must share a group, because the provider counts them
   * together. A provider without an entry is not gated.
   */
  providers: {},
  /** Give up waiting for a slot after this many milliseconds. */
  acquireTimeoutMs: 120000,
  /** How often a waiting request re-checks for a free slot. */
  pollIntervalMs: 100,
  /**
   * Longest a response may take to arrive. A request whose response never
   * arrives keeps its slot until this watchdog fires, so it is kept close to
   * the provider's own request timeout rather than to the length of a
   * generation.
   */
  responseTimeoutMs: 300000,
  /**
   * Longest a single request may hold a slot. It bounds the case where the
   * response arrived but its body was never consumed.
   */
  maxHoldMs: 10 * 60 * 1000,
  /**
   * Directory holding the cross-process slot locks. It must be on a filesystem
   * shared by every OpenCode instance that uses the same key.
   */
  lockDir: join(homedir(), ".local/state/opencode/opencode-gate-plugin"),
  /**
   * File the plugin writes its activity to. The OpenCode server's stderr is not
   * captured anywhere durable, so the log file is the only way to see that the
   * gate engaged.
   */
  logFile: join(homedir(), ".local/state/opencode/opencode-gate-plugin/gate.log"),
  /** Log when the gate actually blocks a request. */
  log: true,
  /**
   * Retry a request the provider rejected for concurrency on the same model,
   * instead of letting the session's fallback chain advance. The chain is meant
   * for providers that are actually broken; a saturated provider recovers by
   * waiting.
   */
  holdModelOnConcurrencyError: true,
  /**
   * How long to wait before retrying a request the provider rejected for
   * concurrency. The provider's `Retry-After` wins when it asks for longer.
   */
  concurrencyRetryDelayMs: 2000,
  /**
   * Route a request to the next model in the agent's chain when the provider
   * of the current model is saturated, instead of waiting for a slot. When the
   * provider frees up, the next request goes back to the head of the chain.
   *
   * The chain comes from oh-my-opencode-slim's configuration, so
   * `configPath` points at that file and `preset` names the preset to read.
   */
  routing: {
    enabled: false,
    /**
     * How long a provider stays skipped after an exhausted allowance, when the
     * provider does not say when it resets.
     */
    exhaustedTtlMs: 30 * 60 * 1000,
    configPath: join(homedir(), ".config/opencode/oh-my-opencode-slim.json"),
    preset: undefined,
  },
}

function resolveOptions(raw) {
  const options = { ...DEFAULTS, ...(raw ?? {}) }
  if (!options.providers || typeof options.providers !== "object") options.providers = {}
  if (!Number.isFinite(options.acquireTimeoutMs) || options.acquireTimeoutMs < 0)
    options.acquireTimeoutMs = DEFAULTS.acquireTimeoutMs
  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0)
    options.pollIntervalMs = DEFAULTS.pollIntervalMs
  if (!Number.isFinite(options.responseTimeoutMs) || options.responseTimeoutMs <= 0)
    options.responseTimeoutMs = DEFAULTS.responseTimeoutMs
  if (!Number.isFinite(options.maxHoldMs) || options.maxHoldMs <= 0) options.maxHoldMs = DEFAULTS.maxHoldMs
  if (!Number.isFinite(options.concurrencyRetryDelayMs) || options.concurrencyRetryDelayMs < 0)
    options.concurrencyRetryDelayMs = DEFAULTS.concurrencyRetryDelayMs
  if (typeof options.lockDir !== "string" || options.lockDir.length === 0) options.lockDir = DEFAULTS.lockDir
  if (typeof options.logFile !== "string" || options.logFile.length === 0) options.logFile = DEFAULTS.logFile
  if (!options.routing || typeof options.routing !== "object") options.routing = {}
  options.routing = { ...DEFAULTS.routing, ...options.routing }
  if (typeof options.routing.configPath !== "string" || options.routing.configPath.length === 0)
    options.routing.configPath = DEFAULTS.routing.configPath
  options.routing.enabled = options.routing.enabled === true
  return options
}

/** Writes a line to the gate log. Failures are silent: logging must never break a request. */
function writeLog(path, message) {
  try {
    mkdirSync(join(path, ".."), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // The log is diagnostic only.
  }
}

/**
 * Recognises a provider answer that says "too many requests in flight".
 *
 * OpenCode already separates a throttle from a quota exhaustion before it
 * builds the session error, and reports the difference as the error type. That
 * type is the reliable signal, so it is consulted first; the message is only
 * read to confirm a concurrency rejection.
 */
function isConcurrencyRejection(error) {
  if (error?.status !== 429) return false
  // A quota rejection is not a concurrency problem, whatever its wording.
  if (error?.type === "provider.quota") return false
  const text = `${error?.message ?? ""} ${error?.response?.body ?? ""}`
  if (!text.trim()) return true
  return /too many concurrent|concurren(?:t|cy)|at most \d+ in flight|maximum .* in flight|reduce concurrency|high concurrency/i.test(
    text,
  )
}

/**
 * A slot shared by every OpenCode instance that can see `lockDir`.
 *
 * Each slot is a directory created with `mkdir`, which is atomic and fails when
 * the path already exists, so the filesystem acts as the mutex. A slot whose
 * owner died is reaped after `staleMs` so a crash cannot wedge the gate.
 */
class SharedSlots {
  constructor(dir, limit, staleMs) {
    this.dir = dir
    this.limit = limit
    this.staleMs = staleMs
  }

  #slotPath(index) {
    return join(this.dir, `slot-${index}`)
  }

  #reapStale() {
    let entries
    try {
      entries = readdirSync(this.dir)
    } catch {
      return
    }
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.startsWith("slot-")) continue
      const path = join(this.dir, entry)
      try {
        const stat = statSync(path)
        if (now - stat.mtimeMs <= this.staleMs) continue
        // The owner may have released and re-taken the slot between the stat
        // and the removal. Re-read the timestamp and only remove what is
        // still the same, stale directory.
        const again = statSync(path)
        if (again.mtimeMs !== stat.mtimeMs) continue
        rmSync(path, { recursive: true, force: true })
      } catch {
        // The slot was released while it was being inspected.
      }
    }
  }

  /** Returns the index of the acquired slot, or undefined when none is free. */
  tryAcquire() {
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch (error) {
      // An unusable lock directory is not the same as a busy provider, and
      // silently treating it as one would stall every request.
      if (error?.code === "EEXIST") return undefined
      throw error
    }
    this.#reapStale()
    for (let index = 0; index < this.limit; index++) {
      const path = this.#slotPath(index)
      try {
        mkdirSync(path)
        try {
          writeFileSync(join(path, "owner"), String(process.pid))
        } catch {
          // The lock itself is what matters; the owner file is diagnostic only.
        }
        return index
      } catch (error) {
        // EEXIST means the slot is taken by someone else.
        if (error?.code !== "EEXIST") return undefined
      }
    }
    return undefined
  }

  release(index) {
    try {
      rmSync(this.#slotPath(index), { recursive: true, force: true })
    } catch {
      // A reaped slot is already gone.
    }
  }
}

/**
 * The budget a provider draws from. Combines a process-local counter, so
 * waiters inside one OpenCode instance are served in order, with shared slots,
 * so instances that share an API key cannot each take the whole budget.
 */
class Budget {
  constructor(limit, shared, maxHoldMs) {
    this.limit = limit
    this.shared = shared
    this.maxHoldMs = maxHoldMs
    this.local = 0
  }

  get saturated() {
    return this.limit > 0 && this.local >= this.limit
  }

  /**
   * Resolves with a release function, or with `undefined` when the wait timed
   * out. A timeout sends the request ungated rather than failing it: the
   * provider's own rejection is more informative than a local error, and the
   * timeout is logged so the bypass is never silent.
   */
  async acquire(timeoutMs, pollIntervalMs) {
    if (this.limit <= 0) return () => {}
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (this.local < this.limit) {
        const slot = this.shared ? this.shared.tryAcquire() : this.local
        if (slot !== undefined) {
          this.local++
          return this.#lease(slot)
        }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return undefined
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)))
    }
  }

  #lease(slot) {
    let released = false
    let timer
    const release = () => {
      if (released) return
      released = true
      if (timer) clearTimeout(timer)
      if (this.shared) this.shared.release(slot)
      this.local--
    }
    // A response body that is never drained would hold the slot forever, so the
    // lease is force released once it outlives any plausible request.
    timer = setTimeout(release, this.maxHoldMs)
    if (typeof timer.unref === "function") timer.unref()
    return release
  }
}

/**
 * Reads a body into memory so it can be inspected, and hands back a reader for
 * the same bytes. Cloning a response would lock the stream it was taken from,
 * so the bytes are buffered instead.
 */
async function bufferBody(body) {
  const reader = body.getReader()
  const chunks = []
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      // Only the beginning of the body is needed to classify the failure.
      if (text.length < 2048) text += new TextDecoder().decode(value, { stream: true })
    }
  } catch {
    // A body that cannot be read leaves the classification to the status code.
  }
  return { reader: readerFromChunks(chunks), text }
}

/** Replays buffered chunks as a readable stream. */
function readerFromChunks(chunks) {
  const iterator = chunks[Symbol.iterator]()
  return {
    async read() {
      const next = iterator.next()
      if (next.done) return { done: true, value: undefined }
      return { done: false, value: next.value }
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  }
}

export default {
  id: "opencode-gate-plugin",
  async setup(ctx) {
    const options = resolveOptions(ctx.options)
    const budgets = new Map()
    // Maps the outgoing Request object to its gate lease. The response hook
    // receives the same Request instance the request hook saw, so the two halves
    // of a lease meet here.
    const leases = new WeakMap()

    /**
     * The budget a provider id draws from. Providers that name the same group
     * share one budget, because the provider counts them against one limit.
     * A provider without a group gets a budget of its own.
     */
    const budgetFor = (providerID) => {
      if (!providerID) return undefined
      const entry = options.providers[providerID]
      if (entry === undefined) return undefined
      const limit = Number(entry?.concurrency ?? entry ?? 0)
      if (!Number.isFinite(limit) || limit <= 0) return undefined
      const group = entry?.group ?? providerID
      if (!budgets.has(group)) {
        const shared = new SharedSlots(join(options.lockDir, group), limit, options.maxHoldMs)
        budgets.set(group, new Budget(limit, shared, options.maxHoldMs))
      }
      return budgets.get(group)
    }

    // Members of one group draw from one budget, so they must agree on its
    // size. A mismatch would silently apply whichever limit was seen first.
    const groupLimits = new Map()
    for (const [providerID, entry] of Object.entries(options.providers)) {
      const limit = Number(entry?.concurrency ?? entry ?? 0)
      const group = entry?.group ?? providerID
      const known = groupLimits.get(group)
      if (known !== undefined && known !== limit) {
        const line = `group "${group}" mixes concurrency ${known} and ${limit}; using ${known} for every member`
        console.error(`[opencode-gate-plugin] ${line}`)
        writeLog(options.logFile, `conflict ${line}`)
      } else if (known === undefined) {
        groupLimits.set(group, limit)
      }
    }

    if (options.log) {
      const summary = Object.entries(options.providers)
        .map(([providerID, entry]) => {
          const limit = Number(entry?.concurrency ?? entry ?? 0)
          const group = entry?.group ?? providerID
          return `${providerID}->${group}(${limit})`
        })
        .join(", ")
      const line = `limits: ${summary || "(none)"} lockDir=${options.lockDir}`
      console.error(`[opencode-gate-plugin] ${line}`)
      writeLog(options.logFile, `setup ${line}`)
    }

    // Providers that answered with an exhausted allowance, and when that
    // allowance comes back. The allowance belongs to the account behind the
    // key, so the state has to be shared between the OpenCode instances using
    // that key: one instance learning that a subscription is exhausted is
    // worth nothing if the next instance walks straight into it.
    const exhaustedFile = join(options.lockDir, "exhausted.json")

    const readExhausted = () => {
      try {
        const parsed = JSON.parse(readFileSync(exhaustedFile, "utf8"))
        return parsed && typeof parsed === "object" ? parsed : {}
      } catch {
        return {}
      }
    }

    const writeExhausted = (state) => {
      try {
        mkdirSync(options.lockDir, { recursive: true })
        writeFileSync(exhaustedFile, JSON.stringify(state))
      } catch {
        // The state is an optimisation; losing it costs one wasted request.
      }
    }

    /** The providers whose allowance is gone, right now. */
    const exhaustedProviders = () => {
      const now = Date.now()
      const state = readExhausted()
      const ids = new Set()
      let changed = false
      for (const [providerID, until] of Object.entries(state)) {
        if (!Number.isFinite(until) || until <= now) {
          changed = true
          continue
        }
        ids.add(providerID)
      }
      if (changed) writeExhausted(state)
      return ids
    }

    /** Records that a provider's allowance is gone, until it says otherwise. */
    const markExhausted = (providerID, until) => {
      const state = readExhausted()
      if (state[providerID] === until) return
      state[providerID] = until
      writeExhausted(state)
    }

    // The agent chains, read once at setup. The routing decision needs the
    // chain of the agent that owns the session, and that lives in
    // oh-my-opencode-slim's configuration.
    let chains
    if (options.routing.enabled) {
      const loaded = Routing.readChains(options.routing.configPath, options.routing.preset)
      chains = loaded?.chains
      if (!chains) {
        const line = `routing enabled but no agent chains were found in ${options.routing.configPath}`
        console.error(`[opencode-gate-plugin] ${line}`)
        writeLog(options.logFile, `setup ${line}`)
      }
    }

    if (options.routing?.enabled && options.log) {
      const line = `routing enabled, ${chains?.size ?? 0} agent chains`
      console.error(`[opencode-gate-plugin] ${line}`)
      writeLog(options.logFile, `setup ${line}`)
    }

    /**
     * The providers that currently have no free slot. A budget that is
     * saturated is one whose every slot is taken, in this process and in the
     * others sharing the key.
     */
    const saturatedProviderIDs = () => {
      const ids = new Set()
      for (const [providerID, entry] of Object.entries(options.providers)) {
        const budget = budgetFor(providerID)
        if (!budget) continue
        if (budget.saturated) ids.add(providerID)
      }
      return ids
    }

    // Decide the model for an upcoming turn, before the session's model is
    // resolved for it. The chain is walked from the head every time, so a
    // provider that was skipped because it was busy is picked again as soon
    // as it is free.
    if (options.routing?.enabled && chains) {
      await ctx.session.hook("prompt", async (event) => {
        try {
          const session = await ctx.session.get({ sessionID: event.sessionID })
          // A session that has not run yet carries no agent, and the runner
          // picks the default one for it. The agent list starts with that
          // default, so it is the same choice the runner would make.
          let agent = session?.agent
          if (!agent) {
            // The agent list starts with the default agent, which is the one
            // the runner would pick for a session that carries none.
            const listed = await ctx.agent.list()
            agent = listed?.data?.[0]?.name
          }
          const chain = agent ? chains.get(agent) : undefined
          if (!chain) return
          const current = session?.model
            ? `${session.model.providerID}/${session.model.id}`
            : undefined
          const saturated = saturatedProviderIDs()
          // A session that is already on a model that is not saturated stays
          // where it is, unless it was moved off the head by this module and
          // the head is free again.
          const exhausted = exhaustedProviders()
          const head = Routing.selectHeadModel({ chain, current, saturated, exhausted })
          const away = Routing.selectModel({ chain, current, saturated, exhausted })
          const target = head ?? away
          if (!target) return
          await ctx.session.switchModel({ sessionID: event.sessionID, model: target })
          if (options.log) {
            const from = current ?? "(none)"
            const line = `${event.sessionID}: routing ${from} -> ${target.providerID}/${target.id}`
            console.error(`[opencode-gate-plugin] ${line}`)
            writeLog(options.logFile, `route ${line}`)
          }
        } catch (error) {
          if (options.log) {
            writeLog(options.logFile, `route failed: ${error?.message ?? error} :: ${error?.stack?.split("\n")[1] ?? ""}`)
          }
        }
      })
    }

    // Acquire before the request leaves the process.
    await ctx.session.hook("http.request", async (event) => {
      const budget = budgetFor(event.model?.providerID)
      if (!budget) return
      const started = Date.now()
      if (budget.saturated && options.log) {
        const line = `${event.model.providerID}: waiting for a free slot (local=${budget.local}/${budget.limit})`
        console.error(`[opencode-gate-plugin] ${line}`)
        writeLog(options.logFile, `wait ${line}`)
      }
      let release
      try {
        release = await budget.acquire(options.acquireTimeoutMs, options.pollIntervalMs)
      } catch (error) {
        // The lock directory is unusable. Without it the budget cannot be
        // shared, so the request goes out ungated and the reason is recorded.
        const line = `${event.model.providerID}: gate unavailable (${error?.code ?? error}), sending ungated`
        console.error(`[opencode-gate-plugin] ${line}`)
        writeLog(options.logFile, `unavailable ${line}`)
        return
      }
      if (!release) {
        const line = `${event.model.providerID}: timed out waiting for a slot after ${options.acquireTimeoutMs}ms, sending ungated`
        console.error(`[opencode-gate-plugin] ${line}`)
        writeLog(options.logFile, `timeout ${line}`)
        return
      }
      const waited = Date.now() - started
      if (waited > 0 && options.log) {
        writeLog(options.logFile, `acquired ${event.model.providerID} waited=${waited}ms`)
      }
      // A response that never arrives leaves the lease held. The watchdog
      // releases it, and the response hook cancels the watchdog once the
      // response is in.
      const watchdog = setTimeout(() => {
        if (!leases.has(event.request)) return
        leases.delete(event.request)
        release()
        writeLog(options.logFile, `watchdog ${event.model.providerID} released a request with no response`)
      }, options.responseTimeoutMs)
      if (typeof watchdog.unref === "function") watchdog.unref()
      leases.set(event.request, { release, providerID: event.model.providerID, watchdog })
    })

    // The response hook is the first point where the body exists, so the slot
    // is held until the body is fully consumed or the stream is torn down.
    await ctx.session.hook("http.response", async (event) => {
      const lease = leases.get(event.request)
      if (!lease) return
      leases.delete(event.request)
      if (lease.watchdog) clearTimeout(lease.watchdog)

      const response = event.response
      const body = response.body
      if (!body) {
        lease.release()
        return
      }
      if (options.log && response.status !== 200) {
        writeLog(options.logFile, `response ${lease.providerID} status=${response.status}`)
      }
      // A provider whose allowance is exhausted cannot answer at all until its
      // quota resets, so the router skips it in the meantime. A provider that is
      // merely saturated is not exhausted: it comes back into rotation as soon
      // as it has a free slot.
      //
      // The body is buffered rather than cloned, because cloning a response
      // locks the stream it was taken from.
      let reader
      // The allowance can be reported with several status codes. Command Code
      // answers a 400 for an empty balance, AIReiter and OpenCode Go answer a
      // 429, and a 402 is the plain payment-required answer.
      if (response.status === 400 || response.status === 402 || response.status === 429) {
        const buffered = await bufferBody(body)
        if (buffered.text && Routing.isExhaustedResponse(response.status, buffered.text)) {
          const resetSeconds = Routing.parseResetSeconds(buffered.text)
          const until = Date.now() + (resetSeconds ? resetSeconds * 1000 : options.routing.exhaustedTtlMs)
          if (!exhaustedProviders().has(lease.providerID)) {
            markExhausted(lease.providerID, until)
            if (options.log) {
              const when = resetSeconds
                ? `resets in ${Math.round(resetSeconds / 3600)}h`
                : `for ${Math.round(options.routing.exhaustedTtlMs / 60000)}min`
              const line = `${lease.providerID}: allowance exhausted, skipping it until it ${when}`
              console.error(`[opencode-gate-plugin] ${line}`)
              writeLog(options.logFile, `exhausted ${line}`)
            }
          }
        }
        reader = buffered.reader
      } else {
        reader = body.getReader()
      }
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              lease.release()
              controller.close()
              return
            }
            controller.enqueue(value)
          } catch (error) {
            lease.release()
            controller.error(error)
          }
        },
        async cancel(reason) {
          lease.release()
          await reader.cancel(reason)
        },
      })

      event.response = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    })

    // Keep a request that the provider rejected for concurrency on the same
    // model. A saturated provider recovers by waiting, so advancing the
    // fallback chain spends the chain on nothing.
    if (options.holdModelOnConcurrencyError) {
      await ctx.session.hook("retry", async (event) => {
        const providerID = event.model?.providerID
        if (!budgetFor(providerID)) return
        if (!isConcurrencyRejection(event.error)) return
        // Never shorten a delay the host already computed from the provider's
        // `Retry-After`; that delay is what keeps a saturated provider from
        // being hammered.
        const delay = Math.max(options.concurrencyRetryDelayMs, event.decision?.delay ?? 0)
        if (options.log) {
          const line = `${providerID}: concurrency rejection, retrying the same model in ${delay}ms`
          console.error(`[opencode-gate-plugin] ${line}`)
          writeLog(options.logFile, `hold ${line}`)
        }
        event.decision = { retry: true, delay }
      })
    }

    return () => {
      budgets.clear()
    }
  },
}
