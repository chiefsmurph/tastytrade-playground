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

3. Run:

```bash
npm start
```

Notes

- The wrapper tries common endpoints; adjust `TASTYTRADE_BASE_URL` if you have a different host or paper endpoint.
- If Tastytrade requires OAuth instead of a bearer API key, let me know and I will change the auth flow.
