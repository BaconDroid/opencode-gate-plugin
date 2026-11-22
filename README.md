# opencode-gate-plugin

Client-side concurrency gate for [OpenCode](https://opencode.ai) providers that
cap how many requests may be in flight at once.

Subscription-backed inference endpoints reject the excess immediately instead of
queueing it. AIReiter's Coding Plan, for example, allows **2 concurrent
requests per API key** and answers the third with:

```
HTTP 429
retry-after: 1
{"error":{"code":null,"message":"Too many concurrent requests, at most 2 in flight.",
          "type":"rate_limit_error"}}
```

The cap belongs to the **key**, not to a model. One key is shared by every model
behind it, by every provider definition that uses it, by every session, and by
every OpenCode process on the host. Running three agents in parallel against a
two-slot plan is enough to hit it.

This plugin makes the client wait for a slot instead of getting rejected.

## Install

Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    {
      "package": "https://github.com/BaconDroid/opencode-gate-plugin",
      "options": {
        "providers": {
          "aireiter":           { "concurrency": 2, "group": "aireiter-plan" },
          "aireiter-anthropic": { "concurrency": 2, "group": "aireiter-plan" },
          "opencode-go":        { "concurrency": 4 },
          "commandcode":        { "concurrency": 4 }
        }
      }
    }
  ]
}
```

Or install from a clone:

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-gate-plugin",
      "options": { "providers": { "aireiter": { "concurrency": 2 } } }
    }
  ]
}
```

## Configuration

### `providers`

Provider id to limit. Each provider gets its own limit, so a provider with a
generous quota does not hold back one with a tight quota.

```json
{
  "providers": {
    "aireiter":           { "concurrency": 2, "group": "aireiter-plan" },
    "aireiter-anthropic": { "concurrency": 2, "group": "aireiter-plan" },
    "opencode-go":        { "concurrency": 4 }
  }
}
```

| Field | Meaning |
| --- | --- |
| `concurrency` | Requests that may be in flight for this provider. `0` disables gating for it. |
| `group` | The budget the provider draws from. Optional; defaults to the provider id. |

**Providers that share an API key must share a `group`.** `aireiter` and
`aireiter-anthropic` above use the same key, so they name the same group and
draw from one budget of 2. Give them separate groups and the plugin would
happily let 4 requests through, which the provider would reject.

A provider that is not listed is not gated.

### Other options

| Option | Default | Meaning |
| --- | --- | --- |
| `acquireTimeoutMs` | `120000` | Give up waiting for a slot and send ungated. The provider's own rejection is more informative than a local error. |
| `pollIntervalMs` | `100` | How often a waiting request re-checks for a free slot. |
| `maxHoldMs` | `900000` | Longest a single request may hold a slot, so an undrained body cannot wedge the gate. |
| `lockDir` | `~/.local/state/opencode/opencode-gate-plugin` | Where the cross-process slot locks live. Must be on a filesystem shared by every instance using the key. |
| `logFile` | `~/.local/state/opencode/opencode-gate-plugin/gate.log` | Activity log. The OpenCode server's stderr is not captured anywhere durable. |
| `log` | `true` | Log when the gate blocks a request. |
| `holdModelOnConcurrencyError` | `true` | Keep the request on the same model when the provider rejects it for concurrency. See below. |
| `concurrencyRetryDelayMs` | `2000` | How long to wait before retrying a request the provider rejected for concurrency. The provider's `Retry-After` wins when it is larger. |

## How it works

The plugin hooks OpenCode v2's `session.hook("http.request")`, the one point
where every outbound provider request passes.

- **Acquire before sending.** The hook is awaited, so a request that finds the
  provider saturated waits for a slot instead of being rejected upstream.
- **Hold the slot until the body ends.** The provider counts a request as in
  flight for the whole generation, not just until the headers arrive, so the
  slot is released when the response stream finishes or is cancelled.
- **Share the budget across processes.** Slots are directories created with
  `mkdir`, which is atomic, so every OpenCode instance that can see the lock
  directory draws from the same budget. A local semaphore alone would let each
  instance take the full budget.

## Compatibility with oh-my-opencode-slim

[oh-my-opencode-slim](https://github.com/BaconDroid/oh-my-opencode-slim) has its
own fallback chain: when a provider fails, it switches to the next model. A
concurrency rejection is a provider failure by that definition, so the chain
would advance even though waiting a few seconds would have resolved the
request.

The plugin therefore also hooks `session.hook("retry")`. When the error is a
concurrency rejection, it keeps the decision as a retry with a delay long
enough for the gate to hand out a slot. oh-my-opencode-slim's own retry hook
reads an existing `retry: true` decision and absorbs it instead of switching
models, so the request stays on its model.

Set `holdModelOnConcurrencyError` to `false` to leave the fallback behaviour
untouched.

Two independent mechanisms therefore cover the same ground:

| | Scope | Controls |
| --- | --- | --- |
| `backgroundJobs.concurrency` | oh-my-opencode-slim | Admission of background tasks, per provider id |
| this plugin | HTTP layer | Requests actually in flight, per provider id and shared per API key |

They compose: the admission limit keeps the queue short, the gate keeps the
provider's quota intact.

## Reading the log

```
setup limits: aireiter->aireiter-plan(2), aireiter-anthropic->aireiter-plan(2), opencode-go->opencode-go(4) ...
wait aireiter: waiting for a free slot (local=2/2)
acquired aireiter waited=14692ms
response aireiter status=429
hold aireiter: concurrency rejection, holding model for 3000ms
```

`waited=` is how long a request queued before it was allowed to go out. Long
waits mean the budget is saturated, which is the gate doing its job rather than
the provider rejecting requests.

## Sizing

A typical agent turn takes about 9 seconds on a small model, so a budget of two
drains roughly one request every 4.5 seconds. Six concurrent sessions against
that budget queue in waves of two, which produces waits of tens of seconds.

That is the arithmetic of the plan, not a defect in the gate. Raising
`concurrency` above the provider's real limit only moves the rejections
upstream. When the plan itself is the constraint, raise the plan.

## License

MIT
