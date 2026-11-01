---
name: baw
description: Binance Agentic Wallet adapter for cross-chain operations and BAW-specific features
---

# BAW Skill

Integrates with Binance Agentic Wallet for enhanced cross-chain capabilities.

## Features

- BAW balance queries
- Cross-chain transfers via BAW
- BAW-specific airdrop campaigns
- Integration with Binance ecosystem

## Parameters

- `action` (string): baw_balance, baw_transfer, baw_claims
- `chain` (string): Source/destination chain
- `wallet` (string): BAW wallet identifier

## Example

```
/baw action=baw_balance chain=bnb
```
