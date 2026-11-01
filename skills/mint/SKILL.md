---
name: mint
description: Mint NFTs or tokens for airdrop eligibility requirements
---

# Mint Skill

Mints NFTs or tokens from testnet/mainnet contracts to meet airdrop criteria.

## Parameters

- `contract_address` (string): NFT or token contract address
- `to` (string): Recipient wallet name
- `token_id` (string): Specific token ID (for NFTs)
- `amount` (string): Quantity to mint
- `data` (string): Additional mint data (hex)

## Output

- Minted status
- Token URI (for NFTs)
- Transaction hash
- Timestamp

## Example

```
/mint contract_address=0x123... to=test1 token_id=42
```
