# Plan: saturation-aware routing

This document records what the gate does today, what it does not do, and the
work needed to close the gap. It was written after measuring the three
subscriptions this plugin is used with, and after reading the OpenCode v2.0.30
plugin API and the oh-my-opencode-slim runtime.

## What the gate does today

The gate holds a slot per provider, shared across processes, and releases it
when the response body ends. A request that finds the provider saturated waits
in the `http.request` hook instead of being rejected.

### Do subagent requests count?

**Yes.** Verified on 2026-11-22 by spawning three parallel Explorer subagents
and reading the gate log:

```
acquired aireiter-anthropic waited=1ms
acquired opencode-go waited=1ms
response opencode-go status=429
response opencode-go status=429
response opencode-go status=429
acquired commandcode waited=1ms
response commandcode status=400
```

The session table confirms the subagent sessions were children (`parent_id`
set). The reason is structural: the plugin registers `session.hook(...)` on the
**location**'s hook service, not on a session. Every session in that location,
parent and child alike, goes through the same hook and therefore the same
budget.

This is the correct behaviour. The provider's limit is per API key, and a
subagent is an independent stream of requests against it. An orchestrator that
fans out five subagents onto one provider spends five slots, not one.

### Does it handle the oh-my-opencode-slim fallback?

Partly, and the interaction is worth stating precisely.

When a provider answers 429, oh-my-opencode-slim classifies it as a provider
failure and **advances the chain**:

- `PROVIDER_STATUS_CODES` contains `429`, so `failoverScope` returns
  `"provider"`.
- In the retry hook, `handleV2Retry` calls `absorbHostRetry`, which returns
  true while `sessionRetries < maxRetries`. The user's `fallback.maxRetries` is
  5, so up to five host retries are absorbed **per session** before the chain
  advances.
- `absorbHostRetry` also refuses to absorb when the host's retry delay exceeds
  `MAX_HOST_RETRY_DELAY_MS` (30 minutes).

So a 429 does not immediately burn the chain, but it does consume the session's
retry budget, and the chain does advance once that budget is spent.

The gate changes this in two ways:

1. It **prevents** most 429s. Measured on 2026-11-22, three parallel requests
   against the live server produced waits of 4.7 s, 9 s, 11 s and 22 s and
   **zero** 429s. A provider that is never rejected does not consume the
   session's retry budget, so the chain survives.
2. When a 429 does get through, the gate's own `retry` hook forces
   `{retry: true, delay}` and takes the maximum of the host's delay and its
   own, so the provider's `Retry-After` is never shortened.

### What it does not do

**It does not route to the next model in the chain when the current provider is
saturated.** The gate queues instead. With a budget of 2 and a 9-second agent
turn, a request can wait minutes.

That is the gap, and it is tracked in
[#1](https://github.com/BaconDroid/opencode-gate-plugin/issues/1).

## Why the routing feature cannot live in the HTTP hook

`ctx.session.switchModel({sessionID, model})` exists in the public plugin API.
Reading the OpenCode v2.0.30 source:

- `Session.switchModel` publishes `SessionEvent.ModelSelected`.
- `session/projector.ts` writes that event to the session record.
- The model is resolved per turn from the session record.

So `switchModel` changes the model for the session's **next** request. It does
not rewrite the request in flight. By the time `http.request` fires, the model
has already been resolved and the request body has been built against it.

The interception point has to be **before the model is resolved for a turn**:
the `session.hook("prompt")` hook, or the `context` hook, which run during
request preparation.

## The other half: providers that are broken, not busy

The three subscriptions on this host, measured on 2026-11-22:

| Provider | Answer | Class |
| --- | --- | --- |
| `opencode-go` | `429 GoUsageLimitError`, monthly limit reached, resets in 15d 8h | exhausted |
| `commandcode` | `400 insufficient credits` | exhausted |
| `aireiter` | works, 2 concurrent per key | saturated, not exhausted |

Only `aireiter` is usable at the moment. A subagent whose chain is
`["opencode-go/hy4", "commandcode/z-ai/glm-5.3-flash", "aireiter-anthropic/minimax-m3.1-flash"]`
therefore burns its first two entries on providers that cannot answer.

The gate makes this worse than it needs to be: it grants a slot to a request
aimed at an exhausted provider, the request fails, and the slot is spent on
nothing. Six parallel subagents produced six such failures, and the message
each time was `insufficient credits`.

Tracked in [#5](https://github.com/BaconDroid/opencode-gate-plugin/issues/5).

The distinction is already available. OpenCode classifies the provider failure
before it builds the session error:

- `provider.rate-limit` for a throttle
- `provider.quota` for an exhausted allowance

The gate uses that for the retry decision today; it should use it for admission
too.

## Work

Ordered by value. Each item is an issue with acceptance criteria.

1. **[#1] Route to the next model in the chain when the current provider is
   saturated.** The headline feature. Intercepts before model resolution, uses
   `switchModel`, and needs a hand-off rule so oh-my-opencode-slim's fallback
   does not immediately switch back.
2. **[#5] Detect an exhausted provider and skip it.** Distinguish
   `provider.quota` from `provider.rate-limit` at admission time, fail fast
   instead of queueing, and honour the reset time the provider reports.
3. **[#2] Document that subagents share the budget**, and make the composition
   of the load visible in the log.
4. **[#3] Name the slot holder.** The log says a request waited, not who held
   the slot. The session id is in the hook event already.
5. **[#4] A status command.** One command that answers "is the gate healthy,
   and who holds the slots", instead of reading log files by hand.
6. **[#6] Honour `Retry-After` on release.** Currently unobservable: the live
   runs produced zero 429s, so the immediate release is already correct in
   practice. It is worth confirming rather than assuming.

## Decisions already taken

- The gate stays a separate plugin. oh-my-opencode-slim's
  `backgroundJobs.concurrency` throttles task admission per provider id; the
  gate throttles requests actually in flight, shared per API key. They compose.
- The plugin is listed **before** `oh-my-opencode-slim` in the `plugins` array
  so its retry decision is the one oh-my-opencode-slim reads.
- Routing to another model changes cost and behaviour, so it is opt-in.
