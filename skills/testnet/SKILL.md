---
name: testnet
description: Perform testnet transactions (swaps, transfers, stakes, bridges) for airdrop farming
---

# Testnet Skill

Executes testnet transactions across multiple chains to fulfill airdrop requirements.

## Parameters

- `chain` (string): Target chain
- `action` (string): Action type (swap, transfer, stake, bridge, mint)
- `from` (string): Source wallet name
- `to` (string): Destination address (for transfers)
- `amount` (string): Amount in token units

## Supported Actions

- **swap** — Token swap on testnet DEX
- **transfer** — Send tokens to address
- **stake** — Stake tokens in testnet protocol
- **bridge** — Bridge tokens between chains
- **mint** — Mint test NFT or token

## Output

- Transaction hash
- Status (success/failed/pending)
- Gas used
- Timestamp

## Example

```
/testnet chain=sepolia action=swap from=test1 amount=0.1
```
