/**
 * Elastic routing for opencode-gate-plugin.
 *
 * When the provider of an agent's current model is saturated, the request can
 * go to the next model in that agent's chain instead of waiting for a slot.
 * Once the saturated provider frees up, the next request goes back to the head
 * of the chain.
 *
 * Why this is separate from the gate:
 *   The gate owns slots and knows which providers are saturated. This module
 *   owns the decision of which model a request should use, and it needs the
 *   agent's fallback chain, which lives in oh-my-opencode-slim's configuration.
 *
 * How the reversion works:
 *   oh-my-opencode-slim's fallback is a one-way descent. `selectFallbackModel`
 *   picks the first model that is not in the session's `tried` set, and that
 *   set only ever grows, so a session that descended never returns to the head
 *   of its chain on its own.
 *
 *   It does have the machinery for it: `rearmIfFreshDescent` resets `tried`
 *   when the session's observed model is the chain's head again. So the
 *   reversion is a matter of putting the session back on the head model, and
 *   oh-my-opencode-slim does the rest.
 *
 * The interaction with oh-my-opencode-slim's own fallback:
 *   Both mechanisms can move a session off the head model. This module only
 *   moves a session when the head provider is saturated, and it moves it to a
 *   model that oh-my-opencode-slim has not yet tried. When the head frees up,
 *   this module puts the session back, and `rearmIfFreshDescent` lets
 *   oh-my-opencode-slim's chain start over.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Splits "provider/model" or "provider/model#variant" into its parts. */
export function parseModelReference(reference) {
  if (typeof reference !== "string") return undefined
  const [path, variant] = reference.split("#")
  const slash = path.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = path.slice(0, slash)
  const rest = path.slice(slash + 1)
  if (!rest) return undefined
  return { providerID, modelID: rest, variant: variant || undefined }
}

/**
 * Reads the model chain for each agent out of an oh-my-opencode-slim
 * configuration.
 *
 * The configuration holds one preset per subscription profile, and each preset
 * holds one entry per agent whose `model` is either a single reference or an
 * ordered chain. The active preset is named by the `preset` key.
 */
export function readChains(configPath, presetName) {
  let config
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"))
  } catch {
    return undefined
  }
  const preset = presetName ?? config.preset
  const presets = config.presets ?? {}
  const selected = preset && presets[preset] ? presets[preset] : undefined
  if (!selected) return undefined
  const chains = new Map()
  for (const [agent, entry] of Object.entries(selected)) {
    if (!entry || typeof entry !== "object") continue
    const models = entry.model
    if (typeof models === "string") {
      chains.set(agent, [models])
      continue
    }
    if (!Array.isArray(models) || models.length === 0) continue
    chains.set(
      agent,
      models.map((model) => (typeof model === "string" ? model : model?.id)).filter(Boolean),
    )
  }
  return { preset, chains }
}

/** The default location of oh-my-opencode-slim's configuration. */
export function defaultConfigPath() {
  return join(homedir(), ".config/opencode/oh-my-opencode-slim.json")
}

/**
 * Recognises a provider answer that says the allowance is gone.
 *
 * This is different from a provider that is merely saturated. A saturated
 * provider answers again as soon as it has a free slot, so it must stay in the
 * rotation. An exhausted provider cannot answer until its quota resets, so
 * routing to it wastes the request.
 *
 * Both providers measured on 2026-11-22 are covered:
 *   `commandcode` -> 400 "You have insufficient credits to make this request."
 *   `opencode-go` -> 429 "OpenCode Go usage limit reached (monthly, resets
 *                    in 15d 8h)."
 */
export function isExhaustedResponse(status, text) {
  if (status === 402) return true
  if (status !== 429 && status !== 400) return false
  if (!text) return false
  return /insufficient credit|usage limit reached|quota exceeded|billing|out of credit|plan does not|package has expired|subscribe to go/i.test(
    text,
  )
}

/**
 * Reads the reset time out of an exhaustion message.
 *
 * Both providers measured on 2026-11-22 report it: OpenCode Go says
 * "usage limit reached (monthly, resets in 15d 8h)" and AIReiter's quota
 * errors carry a reset time of their own. The value is the number of seconds
 * until the allowance comes back.
 *
 * Returns undefined when the message carries no usable reset time, in which
 * case the caller falls back to a default expiry.
 */
export function parseResetSeconds(text) {
  if (!text) return undefined
  const relative = /resets? in\s+(\d+)\s*d(?:ays?)?\s*(?:(\d+)\s*h(?:ours?)?)?/i.exec(text)
  if (relative) {
    const days = Number(relative[1])
    const hours = relative[2] ? Number(relative[2]) : 0
    return days * 86400 + hours * 3600
  }
  const absolute = /resets? (?:at|on)\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)/i.exec(text)
  if (absolute) {
    const when = Date.parse(absolute[1].replace(" ", "T") + (absolute[1].includes(":") ? "Z" : ""))
    if (Number.isFinite(when)) {
      const seconds = Math.floor((when - Date.now()) / 1000)
      if (seconds > 0) return seconds
    }
  }
  return undefined
}


/**
 * Appends the local fallback to a chain.
 *
 * A local model has no quota and no account, so it is the last resort when
 * every subscription is busy or exhausted. It is appended rather than
 * inserted, because the chain is ordered by preference and the local model is
 * the least preferred of them: it is slower and weaker than the hosted ones.
 */
export function withLocalFallback(chain, fallback) {
  if (!Array.isArray(chain)) return chain
  if (!fallback) return chain
  const parsed = parseModelReference(fallback)
  if (!parsed) return chain
  const key = `${parsed.providerID}/${parsed.modelID}`
  if (chain.some((entry) => {
    const other = parseModelReference(entry)
    return other && `${other.providerID}/${other.modelID}` === key
  })) {
    return chain
  }
  return [...chain, key]
}

/**
 * Picks the local fallback for a session whose agent has no chain.
 *
 * A preset names the agents it knows, and an agent outside it has nothing but
 * its own provider. The local model is still its last resort once that
 * provider's allowance is gone. Saturation alone is not enough to move it: the
 * provider will answer again in a moment, while the local model has a single
 * slow slot.
 *
 * Returns undefined when the session should stay where it is.
 */
export function selectLocalFallback({ current, fallback, exhausted }) {
  if (!current || !fallback) return undefined
  const fallbackRef = parseModelReference(fallback)
  if (!fallbackRef) return undefined
  if (!exhausted?.has(current.providerID)) return undefined
  if (exhausted.has(fallbackRef.providerID)) return undefined
  return { providerID: fallbackRef.providerID, id: fallbackRef.modelID, variant: fallbackRef.variant }
}

/**
 * Picks the model a session should use.
 *
 * The chain is walked from the head every time, which is what makes the
 * routing elastic: a provider that was skipped because it was busy is picked
 * again as soon as it is free. Providers marked as exhausted are skipped
 * entirely, because they cannot answer at all.
 *
 * Returns undefined when the chain offers nothing better than what the
 * session already uses, in which case the caller leaves the session alone.
 */
export function selectModel({ chain, current, saturated, exhausted }) {
  if (!Array.isArray(chain) || chain.length === 0) return undefined
  const currentRef = current ? parseModelReference(current) : undefined
  if (!currentRef) return undefined

  // A session whose current model is on a provider that can answer stays
  // where it is. Only a saturated or exhausted provider justifies a move.
  const currentProviderUsable =
    !exhausted?.has(currentRef.providerID) && !saturated?.has(currentRef.providerID)
  if (currentProviderUsable) return undefined

  const currentKey = `${currentRef.providerID}/${currentRef.modelID}`
  for (const reference of chain) {
    const parsed = parseModelReference(reference)
    if (!parsed) continue
    const key = `${parsed.providerID}/${parsed.modelID}`
    // The model the session already uses is not a candidate, but the walk
    // continues: a better model may sit further down the chain.
    if (key === currentKey) continue
    if (exhausted?.has(parsed.providerID)) continue
    if (saturated?.has(parsed.providerID)) continue
    return { providerID: parsed.providerID, id: parsed.modelID, variant: parsed.variant }
  }
  return undefined
}

/**
 * Picks a chain model for a session the plugin did not put on its current
 * model, and only when that model's allowance is gone.
 *
 * A model outside the agent's chain is the user's own choice, so a provider
 * that is merely saturated must not override it: it answers again as soon as a
 * slot frees, and the wait belongs to the gate. An exhausted provider cannot
 * answer at all until its quota resets, which is the one case where the session
 * has to move.
 *
 * Returns undefined when the session should stay where it is.
 */
export function selectModelWhenExhausted({ chain, current, saturated, exhausted }) {
  if (!Array.isArray(chain) || chain.length === 0) return undefined
  const currentRef = current ? parseModelReference(current) : undefined
  if (!currentRef) return undefined
  if (!exhausted?.has(currentRef.providerID)) return undefined
  const currentKey = `${currentRef.providerID}/${currentRef.modelID}`
  for (const reference of chain) {
    const parsed = parseModelReference(reference)
    if (!parsed) continue
    if (`${parsed.providerID}/${parsed.modelID}` === currentKey) continue
    if (exhausted?.has(parsed.providerID)) continue
    if (saturated?.has(parsed.providerID)) continue
    return { providerID: parsed.providerID, id: parsed.modelID, variant: parsed.variant }
  }
  return undefined
}

/**
 * Picks the model to return to when the head of the chain is free again.
 *
 * The head is the agent's preferred model, so the session goes back to it as
 * soon as its provider is no longer saturated.
 */
export function selectHeadModel({ chain, current, saturated, exhausted }) {
  if (!Array.isArray(chain) || chain.length === 0) return undefined
  const currentRef = current ? parseModelReference(current) : undefined
  const currentKey = currentRef ? `${currentRef.providerID}/${currentRef.modelID}` : undefined
  const head = chain[0]
  const parsed = parseModelReference(head)
  if (!parsed) return undefined
  const key = `${parsed.providerID}/${parsed.modelID}`
  if (key === currentKey) return undefined
  if (exhausted?.has(parsed.providerID)) return undefined
  if (saturated?.has(parsed.providerID)) return undefined
  return { providerID: parsed.providerID, id: parsed.modelID, variant: parsed.variant }
}
