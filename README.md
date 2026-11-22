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

### Two providers, one key

`aireiter` and `aireiter-anthropic` below are two provider definitions that
share one API key. The provider counts them against a single limit, so they
must name the same group:

```json
{
  "providers": {
    "aireiter":           { "concurrency": 2, "group": "aireiter-plan" },
    "aireiter-anthropic": { "concurrency": 2, "group": "aireiter-plan" },
    "opencode-go":        { "concurrency": 4 },
    "commandcode":        { "concurrency": 4 }
  }
}
```

Give them separate groups and the plugin would let 4 requests through, which the
provider would reject.

### Order relative to oh-my-opencode-slim

List this plugin **before** `oh-my-opencode-slim` in the `plugins` array so its
retry decision is the one oh-my-opencode-slim reads. See
[Compatibility with oh-my-opencode-slim](#compatibility-with-oh-my-opencode-slim).

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
| `acquireTimeoutMs` | `120000` | Give up waiting for a slot and send ungated. The provider's own rejection is more informative than a local error, and the bypass is logged. |
| `pollIntervalMs` | `100` | How often a waiting request re-checks for a free slot. |
| `responseTimeoutMs` | `300000` | Longest a response may take to arrive. A request whose response never comes releases its slot after this, so a transport error cannot wedge the gate. |
| `maxHoldMs` | `600000` | Longest a single request may hold a slot, covering the case where the response arrived but its body was never consumed. |
| `lockDir` | `~/.local/state/opencode/opencode-gate-plugin` | Where the cross-process slot locks live. Must be on a filesystem shared by every instance using the key. |
| `logFile` | `~/.local/state/opencode/opencode-gate-plugin/gate.log` | Activity log. The OpenCode server's stderr is not captured anywhere durable. |
| `log` | `true` | Log when the gate blocks a request. |
| `holdModelOnConcurrencyError` | `true` | Retry a request the provider rejected for concurrency on the same model, instead of letting the fallback chain advance. See below. |
| `concurrencyRetryDelayMs` | `2000` | How long to wait before retrying a request the provider rejected for concurrency. The provider's `Retry-After` wins when it asks for longer. |

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
own fallback chain: when a provider fails, it switches to the next model.

For a rate-limit error, OpenCode's own session retry already decides
`{retry: true, delay}`, and oh-my-opencode-slim's retry hook reads that decision
and absorbs it rather than switching models, up to `fallback.maxRetries` times
per session. A concurrency rejection therefore does not normally advance the
chain.

The plugin still hooks `session.hook("retry")`, for two reasons:

- It **forces** the retry decision when the host had given up. A concurrency
  rejection is a saturated provider, not a broken one, so retrying the same
  model is the right move even when the host's own policy had declined.
- It never shortens a delay the host computed from the provider's
  `Retry-After`. A provider that says "wait 60 seconds" is obeyed.

Set `holdModelOnConcurrencyError` to `false` to leave the fallback behaviour
untouched.

Two independent mechanisms cover the same ground:

| | Scope | Controls |
| --- | --- | --- |
| `backgroundJobs.concurrency` | oh-my-opencode-slim | Admission of background tasks, per provider id |
| this plugin | HTTP layer | Requests actually in flight, per provider id and shared per API key |

They compose: the admission limit keeps the queue short, the gate keeps the
provider's quota intact.

### Ordering

Hook callbacks run in plugin registration order, which follows the order of the
`plugins` array in the OpenCode config. Listing this plugin **before**
`oh-my-opencode-slim` means its retry decision is the one oh-my-opencode-slim
sees, which is the behaviour described above. The plugin works either way; the
ordering only decides who gets the last word on the delay.

## Elastic routing

With `routing` enabled, a request whose provider is saturated goes to the next
model in the agent's chain instead of waiting for a slot. When the provider
frees up, the next request goes back to the head of the chain.

```json
{
  "providers": {
    "aireiter":           { "concurrency": 2, "group": "aireiter-plan" },
    "aireiter-anthropic": { "concurrency": 2, "group": "aireiter-plan" },
    "opencode-go":        { "concurrency": 4 },
    "commandcode":        { "concurrency": 4 }
  },
  "routing": {
    "enabled": true,
    "configPath": "/root/.config/opencode/oh-my-opencode-slim.json"
  }
}
```

The chains come from oh-my-opencode-slim's configuration, so the two plugins
have to agree on where that file lives.

### What it does

- **Walks the chain from the head, every time.** A provider that was skipped
  because it was busy is picked again as soon as it is free. The routing is
  elastic, not a one-way descent.
- **Skips a provider whose allowance is exhausted.** A saturated provider
  answers again once it has a slot; an exhausted one cannot answer at all
  until its quota resets, so it is left out of the rotation until then. The
  reset time is read from the provider's own message when it gives one.
- **Shares what it learned.** The exhausted state is written to a file under
  `lockDir`, so another OpenCode instance on the same key does not walk into a
  subscription that is already known to be empty.

### The decision is made before the model is resolved

The routing decision happens in the `prompt` hook, which fires when a prompt
is submitted. That is the only point where the session's model can still be
changed: `ctx.session.switchModel` writes the session record, and the model a
turn uses is read from that record when the turn starts. By the time the
`http.request` hook fires, the request body has already been built for the
model that was chosen.

A session that has not run yet carries no agent, and the runner picks the
default agent for it. The plugin makes the same choice, so the chain it
consults is the one the runner will use.

### What it does not do

- It does not change the model of a request that is already in flight.
- It does not reorder the chain, and it does not change which models are in
  it. That is oh-my-opencode-slim's configuration to decide.

The full picture, including what was measured, is in
[docs/PLAN.md](docs/PLAN.md).

## Reading the log

```
setup limits: aireiter->aireiter-plan(2), aireiter-anthropic->aireiter-plan(2), opencode-go->opencode-go(4) ...
wait aireiter: waiting for a free slot (local=2/2)
acquired aireiter waited=14692ms
response aireiter status=429
hold aireiter: concurrency rejection, retrying the same model in 2000ms
watchdog aireiter released a request with no response
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
