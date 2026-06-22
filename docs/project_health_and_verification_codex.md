# Project Health and Verification - Codex

This file covers local runtime health, commands run, and non-strategy project issues.

## Local Verification

I installed dependencies from the lockfile:

```bash
npm ci
```

Result:

- 55 packages installed
- 0 vulnerabilities reported

I then ran:

```bash
npm run typecheck
npm test
npm run build
```

Results:

- `npm run typecheck`: passed
- `npm test`: passed, 7/7 tests
- `npm run build`: passed, generated `build/index.js`

I did not run live authenticated API commands because no credentials were provided and live trading calls should not be exercised casually.

## Runtime Environment Observed

Local versions:

```text
node v22.23.0
npm 10.9.8
```

The package requires Node >= 20 through `@tastytrade/api`, so the local Node version is acceptable.

## Project Shape

Important entrypoints:

- `src/index.ts`: starts IPC, optionally starts scheduler
- `src/ipc-server.ts`: command router
- `src/core/tastytrade-client.ts`: tastytrade SDK client
- `src/core/market-data.ts`: quote streamer helpers
- `src/core/option-service.ts`: option chain and option volume sampling
- `src/bot/run-cycle.ts`: main bot cycle
- `src/bot/evaluate-trading-strategy.ts`: time-of-day and return rules
- `src/bot/actions/manage-allocation.ts`: allocation order placement
- `src/bot/actions/close-position.ts`: close order placement

## Findings

### 1. PM2 config is pinned to a host-specific Node binary

`ecosystem.config.cjs` uses:

```js
interpreter: "/home/deploy/.nvm/versions/node/v24.17.0/bin/node"
```

That path does not exist on this machine. If John runs PM2 here, it will fail even though `npm run start` works.

File reference:

- `ecosystem.config.cjs:9`

Suggested fix direction:

- Use `interpreter: "node"` or document that this PM2 file is only for John's deploy host.
- If a fixed Node path is required, load it from an environment variable.

### 2. README has a wrong IPC command name

README documents:

```bash
node run core:fetchOptionChainsWithVolume RUM
```

But the IPC server registers:

```text
core:fetchOptionChainWithVolume
```

Singular `Chain`, not plural `Chains`.

File references:

- `README.md:76`
- `README.md:119`
- `src/ipc-server.ts:71`

### 3. Environment variables are not validated early

`src/core/tastytrade-client.ts` casts env vars directly:

```ts
baseUrl: process.env.BASE_URL as string
refreshToken: process.env.API_REFRESH_TOKEN as string
clientSecret: process.env.API_CLIENT_SECRET as string
```

If one is missing, the app fails later inside the SDK or during scheduler execution.

File references:

- `.env.example:1`
- `src/core/tastytrade-client.ts:6`
- `ecosystem.config.cjs:17`

Suggested fix direction:

- Validate required env vars at startup.
- Fail with a clear message before starting IPC or scheduler.
- Consider requiring an explicit `TASTYTRADE_ENV=prod|sandbox`.

### 4. Build output and runtime data are ignored, which is good

`.gitignore` ignores:

- `node_modules/`
- `build/`
- `.env`
- `data/runs.ndjson`

So local install/build did not need source changes.

### 5. Test coverage is very narrow

Existing tests cover only time-of-day target blending and ask-weight caps.

Current test file:

- `src/bot/tests/evaluate-trading-strategy.test.ts`

Missing high-value tests:

- market-session response parsing from official field names
- position kebab-case parsing
- put candidate selection
- short-position return math
- duplicate/concurrent run prevention
- allocation order dry-run behavior

## Verification Summary

The project builds and typechecks. The current issues are runtime/API semantics, not compile errors. That is why typecheck passing should not be interpreted as "safe to trade."
