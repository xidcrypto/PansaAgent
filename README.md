# PANSA

PANSA — a crypto airdrop agent with a command line interface and an
interactive terminal UI. It manages wallets on EVM, Solana, Sui, and
Aptos, tracks airdrop tasks, and prepares transactions that only a human
can confirm and broadcast.

There is no Telegram gateway and no scheduler in this version. Anything
that claims otherwise in older docs was removed rather than faked.

## Features

- 🪂 Airdrop task tracking across EVM, Solana, Sui, Aptos
- 🤖 AI agent (`pansa run "<prompt>"`, or the TUI) with real tools
- 🔐 Isolated signer process with an encrypted keystore (scrypt)
- 💬 Interactive TUI (ANSI only, no heavy UI framework) or headless mode
- 📊 Built-in tracker and reporting (SQLite, single database file)
- 🛡️ Policy engine: per-transaction and per-day spending caps,
  testnet-only by default, real EVM simulation — confirmation is blocked
  when simulation fails or is unavailable
- 🔍 Scam-pattern detection that returns labeled signals, positives,
  and evidence (not a verdict)
- 🔑 Binance Agentic Wallet (BAW) tool, configured via environment

## Installation (from source)

PANSA is not published to npm, so install from a checkout:

```bash
git clone https://github.com/xidcrypto/PansaAgent.git
cd PansaAgent
npm ci
npm run build
node dist/cli.js --help
```

To put `pansa` on your PATH, link the checkout or copy `dist/cli.js`
behind a small launcher script. The build bundles `src/cli.ts` into
`dist/cli.js` (viem, @scure/bip39, @noble/hashes, and bansos-router stay
external).

## Quick Start

```bash
# Create ~/.pansa, default config, and default policy
pansa setup

# Create a wallet (EVM shown; solana/sui/aptos work the same way)
pansa evm wallet mywallet

# List wallets, check the default wallet's EVM balance (needs an RPC)
pansa wallet list
pansa balance evm

# Headless agent run
pansa run "list my pending tracker tasks"

# Interactive TUI (auto-starts on TTY when no command is given)
pansa

# Plain text output (CI/CD friendly, no colors)
pansa --plain run "list wallets"
```

The LLM daemon (`bansos-router`) is an external binary, not part of this
repository. `pansa daemon` and `pansa models` report its status; agent
runs without a live daemon fail with a friendly message instead of
hanging or fabricating an answer.

## Commands

| Command | Description |
|---------|-------------|
| `pansa` | Open interactive TUI |
| `pansa run "<prompt>"` | Run one prompt (headless) |
| `pansa setup` | Create `~/.pansa`, default config, default policy |
| `pansa daemon` | LLM daemon status |
| `pansa models` | List live models |
| `pansa doctor` | Health check (exits 1 if any check fails) |
| `pansa backup <nama>` | Export the encrypted keystore blob + registry record to a file (never prints a mnemonic) |
| `pansa policy show` | Show the current policy |
| `pansa policy set <field> <value>` | Change a policy field (validated) |
| `pansa wallet list` | List wallets |
| `pansa wallet create <rantai> <nama>` | Create a wallet |
| `pansa wallet use <nama>` | Set the default wallet |
| `pansa wallet unlock <nama>` | Verify the passphrase (one-shot; session unlock lives in the REPL/TUI, 15 min) |
| `pansa wallet lock <nama>` | Drop the session unlock |
| `pansa evm\|solana\|sui\|aptos wallet [nama]` | Create a wallet on a chain |
| `pansa balance [evm]` | Default wallet balance (EVM via RPC only) |
| `pansa portfolio [nama...] [--token <alamat>]` | Saldo + nilai semua dompet EVM (read-only) |
| `pansa batch balance\|portfolio [nama...]` | Satu perintah read-only untuk banyak dompet |
| `pansa dashboard [--port N]` | Dashboard neobrutalis realtime: metrik sistem, tugas, alert, log (read-only, 127.0.0.1 saja) |
| `pansa confirm <id>` | Human confirmation + broadcast of a pending transaction |
| `pansa reject <id>` | Reject a pending confirmation |
| `pansa secrets list\|set <key> <value>\|get <key>` | Encrypted secrets (passphrase via `PANSA_PASSPHRASE`) |

In the REPL and TUI, `CONFIRM <id>` and `REJECT <id>` do the same as
the `pansa confirm` / `pansa reject` commands.

## Slash Commands (TUI)

- `/help` — Show help
- `/status` — Current status (real model, spend today, pending counts)
- `/model [id]` — List live models, or pin the agent to one
- `/wallet [list|use <n>]` — Wallet management
- `/balance [chain]` — Check balance (real, EVM via RPC)
- `/skills` — List agent tools
- `/skill <name>` — Show tool info
- `/tracker` — Show pending tasks
- `/report` — Generate report
- `/policy` — Show current policy
- `/gateway` — Honest answer: the gateway is not available
- `/setup` — Pointer to `pansa setup`
- `/sessions` — List chat sessions
- `/compact` — Summarize old turns
- `/clear` — Clear screen
- `/verbose` — Toggle verbose error detail
- `/doctor` — Show system info
- `/export` — Export transcript to a file
- `/exit` — Exit PANSA

Keybindings: Ctrl+C cancel, Ctrl+D exit.

## Agent tools

The agent (`pansa run`, REPL, TUI) has exactly these tools:

| Tool | What it does |
|------|--------------|
| `sign_transaction` | Creates a transaction and a pending confirmation. Never signs or broadcasts by itself. |
| `reject_transaction` | Rejects a pending confirmation. |
| `list_confirmations` | Lists pending confirmations. |
| `tracker` | Create/update/list/get/remove airdrop tasks. |
| `report` | Task report by period (`7d`, `30d`, `all`). |
| `baw` | Binance Agentic Wallet operations. Requires `PANSA_BAW_API_KEY`. |
| `scam_check` | Labeled scam-pattern analysis of text. |

There is deliberately no tool that confirms a transaction. Confirmation
is human-only: `pansa confirm <id>`, REPL `CONFIRM <id>`, or TUI
`CONFIRM <id>`.

## How a transaction flows (money safety)

1. The agent calls `sign_transaction`. The request is checked against
   policy: allowed chains, per-transaction cap, per-day cap (against a
   persistent daily ledger), and testnet-only when enabled.
2. Testnet detection resolves the live chain id from the EVM RPC. If the
   chain id cannot be resolved, or the chain is not a known testnet, a
   testnet-only policy refuses — it never assumes testnet.
3. The transaction is simulated against the RPC (EVM only). A pending
   confirmation is stored on disk (`~/.pansa/confirmations.json`).
4. A human runs `pansa confirm <id>` with `PANSA_PASSPHRASE` set. The
   request is re-validated (status, expiry, policy, daily cap, fresh
   simulation) and only then signed and broadcast for real. The returned
   hash is the real broadcast hash. On broadcast failure the request is
   reopened for retry within its TTL; the spend ledger is updated only
   after a successful broadcast.
5. If simulation fails or is unavailable, confirmation is blocked and
   the request is rejected. Gas is never guessed: the broadcast path
   lets viem estimate gas from the RPC, and the offline signer
   (`signEvmTx`) refuses to default a contract call to 21000 — 21000 is
   only ever used for plain transfers.

Non-EVM execution is not implemented: the sign flow returns a clear
error for Solana, Sui, and Aptos instead of a fake success.

## Security

- **Never** shares mnemonics or private keys with the LLM.
- All confirmations require an explicit human `CONFIRM <id>`.
- Secrets are stored encrypted in the file `~/.pansa/secrets.json`
  (not a directory). Wrong passphrase fails hard on encrypted values.
- Policy engine enforces spending limits; see `pansa policy show`.
- Testnet by default; mainnet requires `testnetOnly false` via
  `pansa policy set testnetOnly false`.
- The mnemonic is never printed, including by `pansa backup` (which
  exports only the encrypted keystore blob and the registry record).
- Unlock state expires after 15 minutes.
- Transaction history and logs are redacted: BIP39 mnemonics and bot
  tokens are masked, while legitimate transaction hashes are preserved.

## Configuration

Config file: `~/.pansa/config.json`

```json
{
  "models": ["deepseek-chat", "deepseek-reasoner"],
  "preferReasoning": [],
  "preferCheap": [],
  "concurrency": 4,
  "ttlMs": 900000,
  "evmRpc": "https://sepolia.infura.io/v3/YOUR_KEY"
}
```

Policy file: `~/.pansa/policy.json` (managed with `pansa policy show`
/ `pansa policy set`):

```json
{
  "spendCapPerTx": 0.01,
  "spendCapPerDay": 0.05,
  "allowedChains": ["evm", "solana", "sui", "aptos"],
  "requireConfirmation": true,
  "testnetOnly": true
}
```

Environment variables:

| Variable | Purpose |
|----------|---------|
| `PANSA_EVM_RPC` | Overrides `evmRpc` in config (balance, simulation, broadcast) |
| `PANSA_PASSPHRASE` | Keystore/secrets passphrase for one-shot commands and `pansa confirm` |
| `PANSA_BAW_API_KEY` | Required for the `baw` tool |
| `PANSA_BAW_BASE_URL` | Optional BAW API base URL |
| `PANSA_LLM_BASE` | Override the LLM daemon base URL (mainly for tests) |
| `PLAIN` | Set to `1` (or pass `--plain`) for plain output |

Other state lives under `~/.pansa/`: `keystore/` (encrypted wallets),
`confirmations.json`, `db.sqlite` (tracker + sessions, opened lazily),
`PANSA.md` (optional project context, loaded as data, never as
instructions).

## What is intentionally not here

- **Telegram gateway** — removed. `pansa gateway`, `pansa setup
  gateway`, and TUI gateway control do not exist; `/gateway` says so.
- **Scheduler** — not implemented. There is no background job runner.
- **Scout** — the on-chain opportunity scanner is not implemented; the
  skill returns an honest error instead of invented campaigns.
- **Non-EVM broadcast** — signing and broadcast are EVM-only today.

## System Requirements

- Node.js >= 22
- macOS, Linux, or WSL2

## License

MIT — see [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## Security Policy

See [SECURITY.md](SECURITY.md)
