# PANSA

PANSA — lightweight crypto airdrop agent (CLI + gateway)

## Features

- 🪂 Airdrop hunting across EVM, Solana, Sui, Aptos
- 🤖 AI-powered task planning with local LLM support
- 🔐 Isolated signer process with encrypted keystore
- 💬 Interactive TUI (zero dependencies) or headless mode
- 📊 Built-in tracker, scheduler, and reporting
- 🛡️ Policy engine with simulation and human-only confirmations
- 🔍 Scam detection and research tools
- 📱 Telegram gateway with pairing code authentication

## Installation

```bash
npm install -g pansa
```

## Quick Start

```bash
# Interactive TUI (auto-starts on TTY)
pansa

# Headless mode
pansa run "check my EVM balance on Sepolia"

# Plain text output (CI/CD friendly)
pansa --plain run "list wallets"

# Setup wizard (first run)
pansa setup
```

## Commands

| Command | Description |
|---------|-------------|
| `pansa` | Open interactive TUI |
| `pansa run "<prompt>"` | Run single prompt (headless) |
| `pansa setup` | First-run setup wizard |
| `pansa wallet list` | List all wallets |
| `pansa balance evm` | Check EVM balance |
| `pansa backup <name>` | Export encrypted backup |
| `pansa doctor` | Health check |

## Slash Commands (TUI)

- `/help` — Show help
- `/status` — Current status
- `/model [id]` — Select LLM model
- `/wallet [list|use <n>|new evm]` — Wallet management
- `/balance` — Check balance
- `/skills` — List available skills
- `/tracker` — Show pending tasks
- `/sessions` — List chat sessions
- `/export` — Export session transcript
- `/exit` — Exit PANSA

## Security

- **Never** shares mnemonics or private keys with LLM
- All confirmations require explicit `CONFIRM <id>` from human
- Secrets stored encrypted in `~/.pansa/secrets/`
- Policy engine enforces spending limits
- Testnet by default, mainnet requires explicit opt-in

## Configuration

Config file: `~/.pansa/config.json`

```json
{
  "model": "deepseek-v4-flash-free",
  "testnet": true,
  "spendCap": 0.05,
  "gateway": {
    "enabled": false,
    "telegram": {
      "allowlist": []
    }
  }
}
```

## System Requirements

- Node.js >= 22
- macOS, Linux, or WSL2

## License

MIT — see [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## Security Policy

See [SECURITY.md](SECURITY.md)
