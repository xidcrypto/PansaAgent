---
name: scout
description: Scan blockchain networks for airdrop opportunities and analyze risk levels
---

# Scout Skill

Scans multiple chains for potential airdrop opportunities and provides risk analysis.

## Parameters

- `chain` (string): Target chain (evm, solana, sui, aptos)
- `min_value` (number): Minimum USD value to consider
- `only_testnet` (boolean): Limit to testnet campaigns (default: true)

## Output

List of opportunities with:
- Campaign name and description
- Eligibility requirements
- Estimated reward value
- Risk level (low/medium/high)
- Deadline
- Required actions

## Example

```
/scout chain=evm min_value=50 only_testnet=true
```
