/**
 * Behaviour tests for the gate status command.
 *
 * Each test builds the lock directory the plugin would have left behind, then
 * runs the command against it, so the assertions cover what an operator sees.
 *
 *   node --test test/
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { collectStatus, run } from "../scripts/gate-status.mjs"

const script = fileURLToPath(new URL("../scripts/gate-status.mjs", import.meta.url))

const setupRecord = (at) =>
  `${new Date(at).toISOString()} setup limits: aireiter->aireiter-plan(2), opencode-go->opencode-go(4) lockDir=/x\n`

test("an empty lock directory is healthy and reports no held slot", () => {
  const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
  const now = Date.now()
  mkdirSync(join(lockDir, "aireiter-plan"))
  writeFileSync(join(lockDir, "gate.log"), setupRecord(now - 1000))

  const result = run(["--lock-dir", lockDir], now)

  assert.equal(result.code, 0)
  assert.match(result.stdout, /gate: healthy - no slot is held/)
  assert.match(result.stdout, /aireiter-plan: 0 of 2 slots held/)
})

test("a held slot names its session and agent and its age", () => {
  const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
  const now = Date.now()
  mkdirSync(join(lockDir, "aireiter-plan", "slot-1"), { recursive: true })
  writeFileSync(
    join(lockDir, "aireiter-plan", "slot-1", "owner"),
    JSON.stringify({ pid: 4242, sessionID: "ses_abc", agent: "fixer", providerID: "aireiter", since: now - 30_000 }),
  )
  writeFileSync(join(lockDir, "gate.log"), setupRecord(now - 60_000))

  const result = run(["--lock-dir", lockDir], now)

  assert.equal(result.code, 0)
  assert.match(result.stdout, /gate: healthy - 1 slot is held, all younger than the 300s watchdog window/)
  assert.match(result.stdout, /aireiter-plan: 1 of 2 slots held/)
  assert.match(result.stdout, /slot-1 {2}30s {2}session ses_abc agent fixer/)
})

test("a slot whose owner file holds a bare pid falls back to the pid", () => {
  const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
  const now = Date.now()
  mkdirSync(join(lockDir, "opencode-go", "slot-0"), { recursive: true })
  writeFileSync(join(lockDir, "opencode-go", "slot-0", "owner"), "31337")

  const status = collectStatus({ lockDir, now })

  const [slot] = status.groups.find((group) => group.group === "opencode-go").slots
  assert.equal(slot.pid, 31337)
  assert.equal(slot.sessionID, undefined)
  assert.equal(status.health.status, "healthy")
  assert.match(run(["--lock-dir", lockDir], now).stdout, /slot-0 {2}\d+s {2}pid 31337/)
})

test("a slot with a truncated or missing owner file is held by unknown", () => {
  const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
  const now = Date.now()
  mkdirSync(join(lockDir, "opencode-go", "slot-0"), { recursive: true })
  writeFileSync(join(lockDir, "opencode-go", "slot-0", "owner"), '{"pid": 12, "sessionI')
  mkdirSync(join(lockDir, "opencode-go", "slot-1"), { recursive: true })

  const result = run(["--lock-dir", lockDir], now)

  assert.equal(result.code, 0)
  assert.match(result.stdout, /slot-0 {2}\d+s {2}unknown/)
  assert.match(result.stdout, /slot-1 {2}\d+s {2}unknown/)
})

test("a slot older than the response timeout is reported as a leak", () => {
  const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
  const now = Date.now()
  mkdirSync(join(lockDir, "aireiter-plan", "slot-0"), { recursive: true })
  writeFileSync(
    join(lockDir, "aireiter-plan", "slot-0", "owner"),
    JSON.stringify({ pid: 1, sessionID: "ses_old", agent: "oracle", providerID: "aireiter", since: now - 600_000 }),
  )

  const result = run(["--lock-dir", lockDir, "--response-timeout-ms", "60000"], now)

  assert.equal(result.code, 1)
  assert.match(result.stdout, /gate: degraded - aireiter-plan\/slot-0 has been held for 600s, past the 60s response timeout/)
  assert.match(result.stdout, /slot-0 {2}600s {2}session ses_old agent oracle {2}LEAKED/)
})

test("a recent timeout record in the log is degraded, and an old one is not", () => {
  const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
  const now = Date.now()
  writeFileSync(
    join(lockDir, "gate.log"),
    `${new Date(now - 60_000).toISOString()} timeout aireiter: timed out waiting for a slot for ses_x (fixer)\n`,
  )

  const recent = run(["--lock-dir", lockDir], now)
  assert.equal(recent.code, 1)
  assert.match(recent.stdout, /gate: degraded - a timeout record was logged 60s ago/)

  const old = run(["--lock-dir", lockDir], now + 3_600_000)
  assert.equal(old.code, 0)
  assert.match(old.stdout, /gate: healthy/)
})

test("a missing lock directory is degraded and does not crash", () => {
  const parent = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
  const lockDir = join(parent, "absent")

  const result = run(["--lock-dir", lockDir, "--doctor"])

  assert.equal(result.code, 1)
  assert.match(result.stdout, /gate: degraded - the lock directory .* does not exist/)
  assert.match(result.stdout, /lock-dir-unusable/)
})

test("a lock path that is not a directory is degraded", () => {
  const parent = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
  const lockDir = join(parent, "file")
  writeFileSync(lockDir, "")

  const result = run(["--lock-dir", lockDir])

  assert.equal(result.code, 1)
  assert.match(result.stdout, /is not a directory/)
})

// A superuser ignores directory permissions, so the mode change proves nothing there.
test(
  "a lock directory that is not writable is degraded",
  { skip: process.getuid?.() === 0 ? "running as root" : false },
  () => {
    const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
    chmodSync(lockDir, 0o555)

    const result = run(["--lock-dir", lockDir])

    assert.equal(result.code, 1)
    assert.match(result.stdout, /is not writable/)
  },
)

test("the command never writes to the lock directory", () => {
  const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
  mkdirSync(join(lockDir, "aireiter-plan", "slot-0"), { recursive: true })
  writeFileSync(join(lockDir, "aireiter-plan", "slot-0", "owner"), "7")
  writeFileSync(join(lockDir, "exhausted.json"), '{"aireiter-plan": 1}')
  const before = spawnSync("find", [lockDir, "-printf", "%p %s %T@\\n"], { encoding: "utf8" }).stdout

  const result = spawnSync(process.execPath, [script, "--lock-dir", lockDir], { encoding: "utf8" })

  assert.equal(result.status, 0)
  const after = spawnSync("find", [lockDir, "-printf", "%p %s %T@\\n"], { encoding: "utf8" }).stdout
  assert.equal(after, before)
})

test("--json produces parseable output carrying the same verdict and holders", () => {
  const lockDir = mkdtempSync(join(tmpdir(), "opencode-gate-status-"))
  mkdirSync(join(lockDir, "aireiter-plan", "slot-0"), { recursive: true })
  writeFileSync(
    join(lockDir, "aireiter-plan", "slot-0", "owner"),
    JSON.stringify({ pid: 9, sessionID: "ses_json", agent: "explorer", providerID: "aireiter", since: Date.now() }),
  )
  writeFileSync(join(lockDir, "exhausted.json"), "{ truncated")

  const result = spawnSync(process.execPath, [script, "--json", "--lock-dir", lockDir], { encoding: "utf8" })

  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.health.status, "healthy")
  const group = parsed.groups.find((entry) => entry.group === "aireiter-plan")
  assert.equal(group.held, 1)
  assert.equal(group.slots[0].sessionID, "ses_json")
  assert.equal(group.slots[0].agent, "explorer")
  assert.ok(parsed.notes.some((note) => /exhausted\.json/.test(note)))
})

test("an unknown flag exits with a usage error", () => {
  const result = spawnSync(process.execPath, [script, "--bogus"], { encoding: "utf8" })

  assert.equal(result.status, 2)
})
