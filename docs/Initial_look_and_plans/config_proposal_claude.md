# Config Experience Proposal — "Set it once, tweak it easily" (Claude)

> **Goal (Stephen's words):** *"defaults set by John, easy to tweak as you see fit, with comments and suggestions."* Make the config the part of this project that makes John go "oh, that's actually really nice."
>
> **Status today:** Codex built a solid *engine* — typed `BotConfig`, safe in-code defaults, deep-merge + clamping validation, cache + `reloadBotConfig()`. What's missing is the *experience* on top of it.

## The gap, precisely

| You want | Today |
|----------|-------|
| Comments & suggestions in the file | ❌ Strict `JSON.parse` — **comments are a syntax error** |
| Defaults John sets and owns | ⚠️ Only `trading-bot.config.example.json`; no committed default; defaults live in TS |
| Easy to tweak | ⚠️ Edits require a **full restart** (`reloadBotConfig()` isn't wired to anything) |
| Hard to misconfigure dangerously | ✅ Good — validation clamps/coerces, live-orders off by default |
| See what's active | ❌ No startup echo of the effective settings |

Four small additions close all of it. None changes the existing engine; they wrap it.

---

## 1. Switch the loader to JSONC (comments allowed)

Keep everything as-is except: strip comments before `JSON.parse`. Use [`strip-json-comments`](https://www.npmjs.com/package/strip-json-comments) — a single-file, **zero-dependency** package (honors Codex's "no heavy parser" instinct), and it correctly ignores `//` that appear *inside* strings (a hand-rolled regex won't).

```ts
// bot-config.ts — readJsonConfig()
import stripJsonComments from "strip-json-comments";

function readJsonConfig(configPath: string): unknown {
  const raw = fs.readFileSync(configPath, "utf8");
  try {
    return JSON.parse(stripJsonComments(raw)); // tolerates // and /* */ comments
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid trading bot config at ${configPath}: ${message}`);
  }
}
```
Rename the file `trading-bot.config.jsonc` (editors then syntax-highlight comments). `getBotConfigPath()` looks for `.jsonc` then `.json`.

> If even one tiny dep is unwanted, the fallback is a README config table (section 5) — but JSONC is the direct hit on "comments and suggestions," so it's the recommendation.

---

## 2. Ship a fully-annotated default (this is the "wow")

Commit this as `config/trading-bot.config.jsonc` — **John's** file, the one he opens and owns. Every line tells him what it does, the allowed values, and a suggested range.

```jsonc
{
  // ── ENVIRONMENT ──────────────────────────────────────────────
  // "sandbox" = paper/cert (safe). "production" = REAL MONEY.
  // Start here. Do NOT change to production until the go-live checklist passes.
  "environment": "sandbox",

  // ── LIVE ORDER SAFETY (two locks) ────────────────────────────
  // Orders are only ACTUALLY sent when BOTH are true AND the env
  // var BOT_ENABLE_LIVE_ORDERS=true. Otherwise it dry-runs only.
  "liveOrders": {
    "enabled": false,            // master switch. false = never submit live orders
    "requireEnvFlag": true,      // also require BOT_ENABLE_LIVE_ORDERS=true (belt + suspenders)
    "alwaysDryRunFirst": true    // always validate with the broker before submitting. Keep true.
  },

  // ── STRATEGY ─────────────────────────────────────────────────
  "strategy": {
    "timezone": "America/Los_Angeles", // the schedule's clock. Leave as Pacific —
                                        // the 12:30/12:55 cutoffs are written for US market close.
    "enabledSides": ["call", "put"],    // which option sides the bot may trade. ["call"] for calls-only.
    "allocationPriority": "underweightThenBestReturn", // | "bestReturn"
                                        // underweight-first spreads risk; bestReturn chases winners.
    "allowAddingToLosingPositions": false, // false = never average down into losers (recommended)
    "maxLossForNewAllocationPct": -0.05,   // skip adding to a group worse than -5%. Range: -0.02…-0.15
    "allowDteFallback": false,          // false = only trade the target DTE band; true = allow nearest
    "costBasisUnit": "perShare"         // ⚠️ VERIFY against a real positions payload before live!
                                        // If average-open-price comes back ~100x the premium, set "perContract".
  },

  // ── LIQUIDITY GATES (hard requirements) ──────────────────────
  "liquidity": {
    "minDayVolume": 120,  // skip contracts below this day volume. Higher = stricter. Range: 50…500
    "minOpenInterest": 0  // skip below this OI. Set ~100+ for tighter spreads.
  },

  // ── END-OF-DAY LIQUIDATION (the 12:55 PT exit) ───────────────
  "liquidation": {
    "mode": "marketableLimit", // | "weightedLimit". marketableLimit crosses the spread to actually fill.
    "slippageTicks": 2         // how many $0.01 ticks past the touch to price the exit. Range: 1…5
  },

  // ── SCHEDULER ────────────────────────────────────────────────
  "scheduler": {
    "openIntervalMs": 240000,  // run cadence while market open (240000 = 4 min)
    "closedIntervalMs": 60000  // poll cadence while closed (checks if the market opened)
  },

  // ── LOGGING / PRIVACY ────────────────────────────────────────
  "logging": {
    "redactAccountNumbers": true,  // mask account numbers in logs. Keep true.
    "logRawBrokerPayloads": false  // true = dump full broker JSON (verbose; debug only)
  }
}
```

Keep `validateConfig()` exactly as-is — it already clamps bad values back to safe defaults, so a fat-fingered edit degrades gracefully instead of crashing.

---

## 3. Named profiles — switch posture without hand-editing

Commit three starting points so John can flip stance in one move:

- `config/profiles/conservative.jsonc` — `minDayVolume: 250`, `minOpenInterest: 250`, `maxLossForNewAllocationPct: -0.02`, `allowDteFallback: false`, smaller exposure.
- `config/profiles/balanced.jsonc` — the defaults above.
- `config/profiles/aggressive.jsonc` — `minDayVolume: 50`, `allowAddingToLosingPositions: true`, `allocationPriority: "bestReturn"`, wider slippage.

Select via `TASTYTRADE_BOT_PROFILE=conservative` (env) or a `config:setProfile` IPC command. Loader order: in-code defaults → selected profile → user's `trading-bot.config.jsonc` overrides. (Each profile only needs to specify the keys it changes — `deepMerge` already handles partials.)

---

## 4. Hot-reload + visibility (closes "easy to tweak")

Add three tiny IPC commands (the engine already supports them):

| Command | Does |
|---------|------|
| `config:show` | returns the **effective, redacted** config — "what am I actually running?" |
| `config:reload` | calls `reloadBotConfig()`, returns the new effective config — tweak without restart |
| `config:setProfile <name>` | switches the active profile and reloads |

And a **startup safety banner** so the mode is never a mystery:

```ts
// after loadBotConfig() at startup
const c = getBotConfig();
const live = isLiveOrderSubmissionEnabled(c);
console.log(
  `🟢 ${c.environment.toUpperCase()} | live-orders ${live ? "🔴 ON" : "OFF"} ` +
  `(${getLiveOrderDisabledReason(c) ?? "armed"}) | dry-run-first=${c.liveOrders.alwaysDryRunFirst} ` +
  `| sides=${c.strategy.enabledSides.join("/")} | minVol=${c.liquidity.minDayVolume}`
);
```

---

## 5. README config table (do this even if you skip JSONC)

A table in the README documenting every field, default, allowed values, and effect — so the config is discoverable without reading TypeScript. (One row per field from section 2.)

---

## Implementation checklist (for the next Codex pass)

```
[ ] add strip-json-comments; load .jsonc then .json (section 1)
[ ] commit annotated config/trading-bot.config.jsonc as the owned default (section 2)
[ ] commit config/profiles/{conservative,balanced,aggressive}.jsonc + profile selection (section 3)
[ ] IPC: config:show, config:reload, config:setProfile (section 4)
[ ] startup safety banner (section 4)
[ ] README config table + document the new commands (section 5)
[ ] .gitignore the user's runtime overrides if desired; keep the committed default tracked
```

**Why this wins:** John opens one well-commented file, sees exactly what each knob does and a safe range for it, can switch between conservative/aggressive with one word, tweak live without a restart, and the bot tells him at startup exactly which mode it's in — all on top of the validation engine that already prevents dangerous misconfiguration.
