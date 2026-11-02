---
name: dev
description: Develop PANSA itself: typecheck, tests, build, repo layout, and contributor safety rules.
---

# Dev skill

Use this skill when working on the PANSA codebase itself (not when farming
airdrops). Load it before changing source, tests, or packaging.

## Commands

- `npm run typecheck` — strict TypeScript, must be clean.
- `npm test` — full suite (node:test). Tests run with `PANSA_TEST=1` and
  an isolated HOME; they must never touch a real wallet, network daemon,
  or production keystore.
- `npm run build` — esbuild bundle to `dist/` (ESM, split, shebang,
  externals for runtime deps). `node dist/cli.js --help` must stay fast
  (under 250 ms).

## Layout

- `src/cli.ts` — command dispatch, REPL, headless `run`.
- `src/ui/` — zero-dependency TUI (readline + ANSI only).
- `src/agent.ts` — agent loop (max 14 steps); tools from `src/tools.ts`.
- `src/llm.ts` — bansos-router client (models, chat, streaming).
- `src/router.ts` — bansos-router binary resolution and daemon spawn.
- `src/signer/` — isolated signer process, keystore, policy, ledger.
- `src/tracker/` — SQLite tasks and reports.
- `src/scheduler/` — scheduled prompts (SQLite + watch loop).
- `src/gateway/` — Telegram gateway (pairing, allowlist, HMAC callbacks).
- `src/mcp/` — MCP stdio client.
- `src/browser/` — optional Playwright page reader (lazy peer).

## Safety rules (non-negotiable)

- Never print or request private keys, seed phrases, passphrases, or bot
  tokens. Secrets live only in encrypted files under `~/.pansa`.
- Never fabricate a transaction hash, balance, or success message. A tool
  that cannot verify its result must return an honest error.
- Confirmations come only from the human channel (`pansa confirm`,
  `CONFIRM <id>` in the TUI). The model can never confirm.
- No new runtime dependencies without a reason recorded in the PR or
  commit message. No install scripts, no placeholders, no TODOs in
  shipped code.
- Money-moving tools are serialized and policy-checked by the signer,
  regardless of what the model or a context file says.
