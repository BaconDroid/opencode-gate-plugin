#!/usr/bin/env node
/**
 * Reports whether the gate is healthy and who holds its slots.
 *
 *   node scripts/gate-status.mjs [--json] [--doctor] [--lock-dir <path>] [--log <path>]
 *                                [--response-timeout-ms <n>] [--recent-ms <n>]
 *
 * The script only reads. It never creates, modifies or deletes anything under
 * the lock directory, so it is safe to run while OpenCode is serving requests.
 *
 * Exit status is 0 when the gate is healthy and 1 when it is degraded, so the
 * script can be used as a check. A bad command line exits 2.
 */

import { accessSync, constants, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

// These mirror the defaults the plugin resolves in `resolveOptions`, because the
// plugin does not export them. A deployment that overrides them passes the same
// values on the command line.
const DEFAULT_LOCK_DIR = join(homedir(), ".local/state/opencode/opencode-gate-plugin")
const DEFAULT_RESPONSE_TIMEOUT_MS = 300000

/**
 * How recent a `timeout`, `unavailable` or `watchdog` record must be to count
 * against the gate. Older records describe a problem that has since stopped
 * happening, so they stay in the report without failing the check.
 */
const DEFAULT_RECENT_MS = 10 * 60 * 1000

/** Log records that mean a request left without being properly protected by the gate. */
const UNPROTECTED_KINDS = ["wait", "timeout", "unavailable", "watchdog"]

/** The subset of those records that makes the gate degraded while it is recent. */
const BYPASS_KINDS = ["timeout", "unavailable", "watchdog"]

/**
 * Reads a slot's owner file into the fields it carries.
 *
 * The owner is a JSON object in current slots and a bare pid in older ones. A
 * file that is missing, unreadable or half written yields `kind: "unreadable"`,
 * because the slot is still held whatever its owner file says.
 */
function readOwner(slotPath) {
  let text
  try {
    text = readFileSync(join(slotPath, "owner"), "utf8").trim()
  } catch {
    return { kind: "unreadable" }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: "unreadable" }
  }
  if (Number.isInteger(parsed) && parsed > 0) return { kind: "bare-pid", pid: parsed }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unreadable" }
  const nonEmpty = (value) => (typeof value === "string" && value.length > 0 ? value : undefined)
  return {
    kind: "owner",
    pid: Number.isInteger(parsed.pid) ? parsed.pid : undefined,
    sessionID: nonEmpty(parsed.sessionID),
    agent: nonEmpty(parsed.agent),
    providerID: nonEmpty(parsed.providerID),
    since: Number.isFinite(parsed.since) ? parsed.since : undefined,
  }
}

/** The held slots of one budget group, oldest first. */
function readSlots(groupPath, now, responseTimeoutMs) {
  let entries
  try {
    entries = readdirSync(groupPath, { withFileTypes: true })
  } catch {
    return []
  }
  const slots = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("slot-")) continue
    const path = join(groupPath, entry.name)
    let mtimeMs
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      // The slot was released while it was being listed.
      continue
    }
    const owner = readOwner(path)
    // The plugin's own reaper judges a slot by its modification time, so that is
    // the age to fall back on when the owner file cannot say when it was taken.
    const since = owner.kind === "owner" && owner.since !== undefined ? owner.since : mtimeMs
    const ageMs = Math.max(0, now - since)
    slots.push({
      slot: entry.name,
      ageSeconds: Math.floor(ageMs / 1000),
      sessionID: owner.sessionID,
      agent: owner.agent,
      providerID: owner.providerID,
      pid: owner.pid,
      owner: owner.kind,
      leaked: ageMs > responseTimeoutMs,
    })
  }
  return slots.sort((a, b) => b.ageSeconds - a.ageSeconds)
}

/** Why the lock directory cannot be used, or undefined when it can. */
function lockDirProblem(lockDir) {
  let stat
  try {
    stat = statSync(lockDir)
  } catch (error) {
    return error?.code === "ENOENT"
      ? { reason: "missing", message: `the lock directory ${lockDir} does not exist` }
      : { reason: "unreadable", message: `the lock directory ${lockDir} cannot be read (${error?.code ?? error})` }
  }
  if (!stat.isDirectory()) return { reason: "not-a-directory", message: `${lockDir} is not a directory` }
  try {
    accessSync(lockDir, constants.R_OK | constants.W_OK | constants.X_OK)
  } catch {
    return { reason: "not-writable", message: `the lock directory ${lockDir} is not writable` }
  }
  return undefined
}

/**
 * Reads the gate log into the last record of each unprotected kind and the
 * limits from the last `setup limits:` record.
 *
 * A record whose timestamp does not parse is a half-written line and is
 * skipped. The limits come from the log because the plugin's options live in
 * OpenCode's configuration, which a separate process cannot read.
 */
function readLog(logFile) {
  let text
  try {
    text = readFileSync(logFile, "utf8")
  } catch (error) {
    return { exists: false, error: error?.code ?? String(error), last: {}, limits: undefined }
  }
  const last = {}
  let limits
  for (const line of text.split("\n")) {
    const match = /^(\S+) (\S+) (.*)$/.exec(line)
    if (!match) continue
    const at = Date.parse(match[1])
    if (!Number.isFinite(at)) continue
    const [, , kind, body] = match
    if (UNPROTECTED_KINDS.includes(kind)) last[kind] = { at, message: body }
    if (kind === "setup" && body.startsWith("limits: ")) {
      limits = new Map()
      const configured = body.slice("limits: ".length).split(" lockDir=")[0]
      for (const found of configured.matchAll(/->([^,()]+)\((\d+)\)/g)) {
        if (!limits.has(found[1])) limits.set(found[1], Number(found[2]))
      }
    }
  }
  return { exists: true, last, limits }
}

/** The groups whose allowance has not yet returned, and a note when the file is unusable. */
function readExhausted(lockDir, now) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(lockDir, "exhausted.json"), "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return { groups: [] }
    return { groups: [], note: "exhausted.json is unreadable or truncated" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { groups: [], note: "exhausted.json is unreadable or truncated" }
  }
  const groups = Object.entries(parsed)
    .filter(([, until]) => Number.isFinite(until) && until > now)
    .map(([group, until]) => ({ group, until, remainingSeconds: Math.floor((until - now) / 1000) }))
  return { groups }
}

/**
 * Collects everything the report needs from the lock directory and the log.
 *
 * `health.status` is `"degraded"` when the lock directory is unusable, when a
 * held slot has outlived the response timeout (a leak the watchdog has not
 * reaped), or when the log's latest `timeout`, `unavailable` or `watchdog`
 * record is recent. Otherwise it is `"healthy"`.
 *
 * @param {object} options
 * @param {string} options.lockDir
 * @param {string} [options.logFile] defaults to `gate.log` inside `lockDir`
 * @param {number} [options.now] epoch milliseconds, for deterministic reports
 * @param {number} [options.responseTimeoutMs]
 * @param {number} [options.recentMs]
 */
export function collectStatus({
  lockDir,
  logFile = join(lockDir, "gate.log"),
  now = Date.now(),
  responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  recentMs = DEFAULT_RECENT_MS,
}) {
  const problem = lockDirProblem(lockDir)
  const log = readLog(logFile)
  const exhausted = problem ? { groups: [] } : readExhausted(lockDir, now)

  const names = new Set(log.limits?.keys() ?? [])
  if (!problem) {
    try {
      for (const entry of readdirSync(lockDir, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name)
      }
    } catch {
      // The directory became unreadable after the check; the report shows no groups.
    }
  }
  const groups = [...names].sort().map((group) => {
    const slots = problem ? [] : readSlots(join(lockDir, group), now, responseTimeoutMs)
    return { group, limit: log.limits?.get(group) ?? null, held: slots.length, slots }
  })

  const causes = []
  if (problem) causes.push({ kind: "lock-dir-unusable", reason: problem.reason, message: problem.message })
  for (const group of groups) {
    for (const slot of group.slots) {
      if (!slot.leaked) continue
      causes.push({
        kind: "slot-leaked",
        group: group.group,
        slot: slot.slot,
        message: `${group.group}/${slot.slot} has been held for ${slot.ageSeconds}s, past the ${Math.round(responseTimeoutMs / 1000)}s response timeout, and the watchdog has not reaped it`,
      })
    }
  }
  for (const kind of BYPASS_KINDS) {
    const record = log.last[kind]
    if (!record || now - record.at > recentMs) continue
    causes.push({
      kind: "recent-bypass",
      record: kind,
      at: new Date(record.at).toISOString(),
      message: `a ${kind} record was logged ${Math.max(0, Math.floor((now - record.at) / 1000))}s ago: ${record.message}`,
    })
  }

  const held = groups.reduce((sum, group) => sum + group.held, 0)
  const notes = []
  if (!log.exists) notes.push(`no log at ${logFile} (${log.error})`)
  if (exhausted.note) notes.push(exhausted.note)
  if (!log.limits) notes.push("no setup record in the log, so the configured limits are unknown")

  return {
    lockDir,
    logFile,
    now: new Date(now).toISOString(),
    responseTimeoutMs,
    recentMs,
    groups,
    exhausted: exhausted.groups,
    log: {
      exists: log.exists,
      last: Object.fromEntries(
        Object.entries(log.last).map(([kind, record]) => [
          kind,
          { at: new Date(record.at).toISOString(), message: record.message },
        ]),
      ),
    },
    notes,
    health:
      causes.length === 0
        ? {
            status: "healthy",
            summary:
              held === 0
                ? "no slot is held"
                : `${held} slot${held === 1 ? " is" : "s are"} held, all younger than the ${Math.round(responseTimeoutMs / 1000)}s watchdog window`,
            causes,
          }
        : { status: "degraded", summary: causes.map((cause) => cause.message).join("; "), causes },
  }
}

/** How a slot's holder is named: session and agent, else the pid, else `unknown`. */
function holderLabel(slot) {
  if (slot.sessionID) return `session ${slot.sessionID}${slot.agent ? ` agent ${slot.agent}` : ""}`
  if (slot.agent) return `agent ${slot.agent}`
  if (slot.pid !== undefined) return `pid ${slot.pid}`
  return "unknown"
}

/** The one-line verdict, plainly stating which condition holds. */
function verdictLine(status) {
  return `gate: ${status.health.status} - ${status.health.summary}`
}

/**
 * Renders the health verdict alone: the verdict line and one line per cause.
 *
 * @param {ReturnType<typeof collectStatus>} status
 */
export function renderDoctor(status) {
  const lines = [verdictLine(status)]
  for (const cause of status.health.causes) lines.push(`  - ${cause.kind}: ${cause.message}`)
  return lines.join("\n")
}

/**
 * Renders the full human-readable report: the verdict, then each budget group
 * with its held slots.
 *
 * @param {ReturnType<typeof collectStatus>} status
 */
export function renderReport(status) {
  const lines = [verdictLine(status), `lock dir: ${status.lockDir}`, `log: ${status.logFile}`, ""]
  if (status.groups.length === 0) lines.push("no budget groups")
  for (const group of status.groups) {
    const limit = group.limit === null ? "?" : String(group.limit)
    lines.push(`${group.group}: ${group.held} of ${limit} slots held`)
    for (const slot of group.slots) {
      lines.push(`  ${slot.slot}  ${slot.ageSeconds}s  ${holderLabel(slot)}${slot.leaked ? "  LEAKED" : ""}`)
    }
  }
  if (status.exhausted.length > 0) {
    lines.push("", "allowance exhausted:")
    for (const entry of status.exhausted) {
      lines.push(`  ${entry.group}  returns ${new Date(entry.until).toISOString()} (in ${entry.remainingSeconds}s)`)
    }
  }
  const records = Object.entries(status.log.last)
  if (records.length > 0) {
    lines.push("", "latest unprotected-request records:")
    for (const [kind, record] of records) lines.push(`  ${kind}  ${record.at}  ${record.message}`)
  }
  for (const note of status.notes) lines.push("", `note: ${note}`)
  return lines.join("\n")
}

const OPTIONS = {
  json: { type: "boolean", default: false },
  doctor: { type: "boolean", default: false },
  "lock-dir": { type: "string", default: DEFAULT_LOCK_DIR },
  log: { type: "string" },
  "response-timeout-ms": { type: "string", default: String(DEFAULT_RESPONSE_TIMEOUT_MS) },
  "recent-ms": { type: "string", default: String(DEFAULT_RECENT_MS) },
}

/**
 * Runs the command line and returns what to print and the exit status, leaving
 * the printing to the caller.
 *
 * @param {string[]} argv arguments after the script name
 * @param {number} [now] epoch milliseconds
 * @returns {{ stdout: string, stderr: string, code: number }}
 */
export function run(argv, now = Date.now()) {
  let values
  try {
    values = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }).values
  } catch (error) {
    return { stdout: "", stderr: `${error.message}\n`, code: 2 }
  }
  const responseTimeoutMs = Number(values["response-timeout-ms"])
  const recentMs = Number(values["recent-ms"])
  if (!Number.isFinite(responseTimeoutMs) || responseTimeoutMs <= 0 || !Number.isFinite(recentMs) || recentMs <= 0) {
    return { stdout: "", stderr: "--response-timeout-ms and --recent-ms must be positive numbers\n", code: 2 }
  }
  const lockDir = resolve(values["lock-dir"])
  const status = collectStatus({
    lockDir,
    logFile: values.log === undefined ? undefined : resolve(values.log),
    now,
    responseTimeoutMs,
    recentMs,
  })
  const stdout = values.json
    ? JSON.stringify(status, null, 2)
    : values.doctor
      ? renderDoctor(status)
      : renderReport(status)
  return { stdout: `${stdout}\n`, stderr: "", code: status.health.status === "healthy" ? 0 : 1 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run(process.argv.slice(2))
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exitCode = result.code
}
