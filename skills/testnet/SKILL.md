---
name: testnet
description: Prepare a testnet transaction for human confirmation. Never fabricates a hash.
---

# Testnet Skill

Prepares a transaction (transfer or contract call) as a pending
confirmation through the sign flow. It does not execute by itself, and
it never invents a transaction hash, gas used, or success status.

## Parameters

- `chain` (string): Target chain (currently EVM only for execution)
- `action` (string): Informational only; the call is a plain transfer
  or contract call
- `from_wallet` (string): Source wallet name
- `to` (string): Destination address
- `amount` (string): Native value to send
- `data` (string): Optional calldata for contract calls. Gas is
  estimated from the RPC at broadcast time, never guessed.

## Output

- A pending confirmation (id, policy check, simulation result), or a
  clear error (policy refusal, simulation failure, non-EVM chain).
- The transaction only executes after a human runs
  `pansa confirm <id>` (or `CONFIRM <id>`), and only then is a real
  broadcast hash returned.

## Example

```
/testnet chain=evm from_wallet=mywallet to=0x123... amount=0.01
```
