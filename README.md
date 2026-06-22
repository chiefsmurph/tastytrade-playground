# Tastytrade Playground (minimal)

This small Node.js scaffold fetches and displays positions and account balances from Tastytrade.

Setup

1. Create project folder and install dependencies:

```bash
mkdir -p ~/code/tastytrade-playground
cd ~/code/tastytrade-playground
npm install
```

2. Copy and fill `.env` from the example:

```bash
cp .env.example .env
# open .env and set the required values
```

Required `.env` values (from `.env.example`):

- `BASE_URL` (default: `https://api.tastyworks.com`)
- `API_CLIENT_SECRET`
- `API_REFRESH_TOKEN`
- `BOT_RUN_ON_SCHEDULE` (`true` or `false`)

Optional runtime env values:

- `TASTYTRADE_BOT_SOCKET` (override IPC socket path)

3. Type-check the project:

```bash
npm run typecheck
```

4. Optional: create a bundled JavaScript build:

```bash
npm run build
```

This project normally runs directly from TypeScript via `tsx`. `typecheck` validates types only, while `build` creates a bundled server entrypoint at `build/index.js`.

Run With IPC

Start the IPC server in one terminal:

```bash
npm run start:tsx
```

Or run the bundled build instead:

```bash
npm run start:build
```

This starts a long-running Node process that listens on a local socket at `.tastytrade-playground.sock`.

In a second terminal, call commands through IPC:

```bash
node run core:getBidAskForSymbol AAPL
```

```bash
node run core:getUnderlyingPrice AAPL
```

```bash
node run core:fetchOptionChainsWithVolume RUM
```

```bash
node run bot:getOptionCandidates RUM call
```

```bash
node run bot:getTopOptionCandidateForSymbol RUM call
```

```bash
node run bot:getOptionHealthForSymbol RUM call
```

This returns keyed target checks for `7`, `14`, and `30` DTE plus a compact summary of `healthyTargets`, `missingTargets`, and `fallbackTargets`.

```bash
node run bot:getCurrentAllocationBudget
```

```bash
node run bot:getTimeOfDayExecutionTargets 10:14
```

Pass `HH:mm` in Pacific time.

```bash
node run bot:getRecentRunHistory 20
```

Supported IPC commands

- `core:getBidAskForSymbol <symbol> [timeoutMs]`
- `core:getUnderlyingPrice <symbol> [timeoutMs]`
- `core:fetchOptionChainsWithVolume <symbol>`
- `bot:getOptionCandidates <symbol> [call|put]`
- `bot:getTopOptionCandidateForSymbol <symbol> [call|put]`
- `bot:getOptionHealthForSymbol <symbol> [call|put]`
- `bot:getCurrentAllocationBudget [accountNumber]`
- `bot:getTimeOfDayExecutionTargets <HH:mm>`
- `bot:getRecentRunHistory [limit]`
- `bot:everyFourMinutes`
- `bot:startMarketOpenScheduler`
- `bot:stopMarketOpenScheduler`
- `bot:getMarketOpenSchedulerStatus`

Market-open scheduler

The tastytrade market sessions docs expose `GET /market-time/equities/sessions/current`, which is the right source of truth for whether the equity-options session is open. This bot now uses that endpoint and only runs the live four-minute loop during the regular equities session.

Important: equity options trade during the regular session only. Extended-hours equity sessions are not treated as open for this scheduler.

To auto-start the scheduler when the IPC server boots:

```bash
BOT_RUN_ON_SCHEDULE=true npm run start:tsx
```

To manage it manually over IPC:

```bash
node run bot:startMarketOpenScheduler
node run bot:getMarketOpenSchedulerStatus
node run bot:stopMarketOpenScheduler
```

For another Node process on the same machine, prefer the reusable IPC client instead of spawning `node run ...`:

```js
import { sendIpcCommand } from "./ipc-client.js";

const optionHealth = await sendIpcCommand(
	"bot:getOptionHealthForSymbol",
	["RUM", "call"],
	{
		socketPath: "/absolute/path/to/tastytrade-playground/.tastytrade-playground.sock",
	},
);
```

If you copy `ipc-client.js` into another project, the only repo-specific default is the socket filename. You can either pass `socketPath` explicitly, or override `socketFileName` / `envVarName` when resolving the socket path.

How it works

- `npm run start:tsx` starts the IPC server from the TypeScript source via `tsx`.
- `npm run build` bundles the IPC server to `build/index.js` with `esbuild`.
- `npm run start:build` runs the bundled server with Node.
- `ipc-client.js` sends JSON requests over `node:net` to the local socket.
- `node run ...` is a thin CLI wrapper around `ipc-client.js`.
- The server executes the command and returns the JSON response.
- The IPC server logs incoming requests, route hits, unknown commands, and outgoing responses.

Notes

- If the client cannot connect, start or restart the IPC server with `npm run start:tsx`.
- The Tastytrade calls depend on the values in `.env`.
- The socket path can be overridden with `TASTYTRADE_BOT_SOCKET`.
- Run history path can be overridden with `TASTYTRADE_BOT_RUN_HISTORY_PATH` (default: `data/runs.ndjson`).
- Source imports use extensionless TypeScript paths because runtime execution goes through `tsx` with bundler-style resolution.
