---
name: scam_check
description: Analyze text, URLs, or transactions for scam patterns and phishing attempts
---

# Scam Check Skill

Detects scam, phishing, and rug-pull patterns in text. This is a
pattern matcher, not an on-chain audit: it returns labeled signals, not
a verdict.

## Parameters

- `text` (string): Content to analyze (can be URL, message, or transaction data)

## Output

- `ok` (boolean): True when no risk signal matched
- `signs` (string[]): Detected risk labels, e.g. `phishing`,
  `rug-pull`, `honeypot`. Labels, never booleans.
- `positives` (string[]): Reassuring labels, e.g. `renounced
  ownership`, `liquidity locked`, `contract verified`
- `evidence` (string[]): The matched text for each signal
- `severity`: `low`, `medium`, or `high`

## Matching rules

- Patterns are word-boundary only: "dumped" or "dumpster" do not match
  "dump", and "free tokens" alone does not flag a legitimate airdrop.
- "Renounced ownership" and "liquidity locked" count as positives, not
  as rug-pull signals.

## Example

```
/scam_check text="Click here to claim your free airdrop: bit.ly/claim-now"
```
