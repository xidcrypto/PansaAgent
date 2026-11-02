---
name: baw
description: Binance Agentic Wallet adapter. Requires PANSA_BAW_API_KEY; fails fast without it.
---

# BAW Skill

Calls the Binance Agentic Wallet API for wallet, balance, transfer, swap,
and claim operations. Configuration comes only from the environment:
`PANSA_BAW_API_KEY` (required) and `PANSA_BAW_BASE_URL` (optional,
default `https://api.agenticwallet.binance.com/v1`).

Without `PANSA_BAW_API_KEY` the tool returns a clear "not configured"
error and never sends an unauthenticated request.

## Parameters

- `action` (string): list_wallets, get_wallet, balance, transfer, swap,
  list_claims, claim
- `wallet_id` (string): BAW wallet identifier
- `to_address` (string): Recipient address (for transfer)
- `amount` (string): Amount
- `token` (string): Token symbol
- `chain` (string): Chain (bsc, eth, arb, op, base, polygon)
- `from_token`, `to_token` (string): Swap pair
- `slippage` (number): Slippage tolerance (for swap)
- `claim_id` (string): Claim identifier (for claim)

## Notes

- Transfers and swaps are signing actions: they go through the
  human-confirmation flow, never execute from the tool alone.
- The tool never returns a fabricated transaction id; ids come from the
  API response.
