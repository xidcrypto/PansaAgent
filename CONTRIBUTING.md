# Contributing to PANSA

Thank you for considering contributing to PANSA! This document provides guidelines and instructions.

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Prioritize security in all contributions

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/PansaAgent.git`
3. Install dependencies: `npm ci`
4. Create a branch: `git checkout -b feature/your-feature`

## Development Setup

```bash
# Install dependencies
npm ci

# Run typecheck
npm run typecheck

# Run tests
npm test

# Build
npm run build

# Run in development mode
npm run dev
```

## Coding Standards

- **TypeScript strict mode** — `strict` and `noUnusedLocals` are on and
  must stay clean. `as any` is not banned outright, but it is confined
  to narrow, justified spots (13 occurrences at last count: CLI
  string-to-chain-family casts, the untyped `defaultWallets` config
  extension, untyped viem option shapes, tracker enum casts). A new
  `as any` needs a justification in review; a cast that hides a real
  type error is a review failure.
- **ESM modules** — use `import`/`export`, not CommonJS
- **Node >= 22** — can use modern APIs
- **No install scripts** — avoid `postinstall`, `preinstall`
- **Minimal dependencies** — only add if essential

### Runtime Dependencies

Allowed runtime deps:
- `viem` — EVM interactions
- `@scure/bip39` — mnemonic generation
- `@noble/hashes` — cryptographic hashing
- `bansos-router` — local LLM routing

Optional (lazy-loaded):
- `@solana/web3.js` — Solana support
- `playwright` — browser automation

**NOT allowed for UI**: Ink, chalk, blessed, or other heavy UI frameworks (use ANSI escape codes only)

## Testing

- Write tests for new features
- Core modules must have tests that pass: keystore, policy,
  transactions, tracker, agent, llm, cli, signer server/client, skills,
  secrets, and crypto primitives. There is no coverage gate and no
  coverage tooling configured — do not claim a coverage percentage.
- Test both TTY and non-TTY modes
- Include security-focused tests (redaction, confirmation flow)
- Isolate HOME to a tmp dir in tests so they never touch the user's
  real `~/.pansa`

```bash
# Run all tests
npm test

# Run specific test file
npx tsx --test test/keystore.test.ts
```

## Commit Messages

Follow conventional commits:

```
feat: add Solana wallet support
fix: correct scrypt memory calculation
docs: update README installation steps
test: add keystore unlock tests
refactor: extract confirmation card rendering
```

## Pull Request Process

1. Ensure all tests pass: `npm run typecheck && npm test`
2. Update documentation if needed
3. Add changelog entry (if applicable)
4. Request review from maintainers
5. Address review feedback

## Security Considerations

**CRITICAL**: Never commit:
- Private keys or mnemonics
- API tokens or secrets
- `.env` files
- Keystore files

All PRs are scanned for secrets. Violations will be rejected immediately.

## Areas We Need Help

- [ ] Additional chain support (Cosmos, Polkadot)
- [ ] More LLM provider integrations
- [ ] Enhanced scam detection patterns
- [ ] Mobile-friendly TUI
- [ ] Multi-language support
- [ ] Plugin system for custom skills

## Questions?

Open an issue with the `question` label.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
