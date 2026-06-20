# Tastytrade Bot (minimal)

This small Node.js scaffold fetches and displays positions and account balances from Tastytrade.

Setup

1. Create project folder and install dependencies:

```bash
mkdir -p ~/code/tastytrade-bot
cd ~/code/tastytrade-bot
npm install
```

2. Copy and fill `.env` from the example:

```bash
cp .env.example .env
# open .env and add your API key and account id
```

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

This starts a long-running Node process that listens on a local socket at `.tastytrade-bot.sock`.

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
node run bot:getOptionCandidatesForSymbol RUM
```

```bash
node run bot:getTopOptionCandidateForSymbol RUM
```

Supported IPC commands

- `core:getBidAskForSymbol <symbol> [timeoutMs]`
- `core:getUnderlyingPrice <symbol> [timeoutMs]`
- `core:fetchOptionChainsWithVolume <symbol>`
- `bot:getOptionCandidatesForSymbol <symbol>`
- `bot:getTopOptionCandidateForSymbol <symbol>`

How it works

- `npm run start:tsx` starts the IPC server from the TypeScript source via `tsx`.
- `npm run build` bundles the IPC server to `build/index.js` with `esbuild`.
- `npm run start:build` runs the bundled server with Node.
- `node run ...` starts a separate Node process that sends a request over `node:net`.
- The server executes the command and returns the JSON response.
- The IPC server logs incoming requests, route hits, unknown commands, and outgoing responses.

Notes

- If the client cannot connect, start or restart the IPC server with `npm run start:tsx`.
- The Tastytrade calls depend on the values in `.env`.
- The socket path can be overridden with `TASTYTRADE_BOT_SOCKET`.
- Source imports use extensionless TypeScript paths because runtime execution goes through `tsx` with bundler-style resolution.
