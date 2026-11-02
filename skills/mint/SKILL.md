---
name: mint
description: Prepare an EVM mint transaction for human confirmation. Never fabricates a token or hash.
---

# Mint Skill

Prepares a mint as a pending confirmation through the sign flow. It does
not mint by itself, and it never invents a token URI, a token id, or a
transaction hash.

## Parameters

- `contract_address` (string, required): Contract to call (also the
  transaction destination)
- `from_wallet` (string, required): Wallet name that will sign
- `data` (string, required): Encoded mint calldata (hex). Without it
  the skill errors — it cannot guess what to call.
- `to`, `token_id`, `amount`: declared for compatibility but currently
  ignored; the call target is always `contract_address` and no native
  value is sent.

## Output

- A pending confirmation (id, policy check, simulation result), or a
  clear error (missing calldata, policy refusal, simulation failure).
- The transaction only executes after a human runs
  `pansa confirm <id>` (or `CONFIRM <id>`), and only then is a real
  broadcast hash returned.

## Example

```
/mint contract_address=0x123... from_wallet=mywallet data=0x1234 amount=0
```
