---
name: scam_check
description: Analyze text, URLs, or transactions for scam patterns and phishing attempts
---

# Scam Check Skill

Detects potential scams, phishing attempts, and rug-pull patterns in airdrop campaigns.

## Parameters

- `text` (string): Content to analyze (can be URL, message, or transaction data)
- `strict` (boolean): Enable strict mode with lower false-positive tolerance

## Patterns Detected

- Phishing (fake wallet connection requests)
- Rug-pull indicators (renounced ownership, liquidity removal)
- Token dump schemes
- Sybil attack patterns
- Fake airdrop links

## Output

- `ok` (boolean): True if no scam patterns detected
- `signs` (string[]): List of detected risk indicators
- `risks` (string[]): Recommended actions

## Example

```
/scam_check text="Click here to claim your free airdrop: bit.ly/claim-now" strict=true
```
