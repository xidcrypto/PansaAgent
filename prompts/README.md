# PANSA - crypto airdrop agent

Lightweight CLI + gateway AI agent focused on crypto airdrops.

## Features

- Interactive TUI interface (press `?` for help)
- Headless mode: `pansa run "<prompt>"`
- Wallet management for EVM, Solana, Sui, Aptos
- Encrypted keystore with scrypt KDF
- bansos-router integration for LLM models
- Policy-based transaction confirmation
- Skills system for multi-step tasks

## Quick Start

```bash
# Install
npm i -g .

# Setup
pansa setup

# Use
pansa evm wallet mywallet
pansa balance evm
pansa run "check my balance"
```

## CLI Usage

```
pansa                    REPL interaktif
pansa run "<prompt>"     Jalankan satu prompt
pansa setup              Setup wizard
pansa setup gateway      Setup gateway (telegram)
panga gateway <cmd>      Gateway control (start|stop|status|test|logout)
pansa daemon             Jalankan gateway daemon
pansa backup <nama>      Backup mnemonik (hanya TTY)
pansa doctor             Pemeriksaan kesehatan
pansa models             Lihat model live
pansa policy show|edit   Lihat/edit kebijakan
pansa --help             Bantuan ini
```

## Wallets

Support for EVM, Solana, Sui, and Aptos chains with mnemonic-based accounts.

## Security

- Never store secrets in plain config
- All passphrases encrypted with scrypt
- Mainnet transfers require explicit user confirmation
- Testnet by default

## License

MIT @ 2026 xidcrypto