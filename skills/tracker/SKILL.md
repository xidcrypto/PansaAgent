---
name: tracker
description: Track airdrop tasks, progress, and deadlines
---

# Tracker Skill

Manages airdrop farming tasks in the local SQLite database. All ids are
real (`task_` + random suffix); nothing is hardcoded.

## Parameters

- `action` (string): create, update, list, get, remove
- `task_id` (string): Task identifier (for update, get, remove)
- `title` (string): Task description
- `description` (string): Longer description
- `status` (string): pending, in_progress, completed, failed, cancelled
- `priority` (string): low, medium, high
- `chain` (string): evm, solana, sui, aptos
- `campaign` (string): Campaign name
- `deadline` (string): ISO 8601 deadline (tasks without a deadline sort
  last)

## Notes

- Updates validate `status` and `priority` against the enums above and
  reject invalid values instead of storing them.
- Unknown fields are ignored, never interpolated into SQL.

## Example

```
/tracker action=create title="Complete LayerZero testnet bridge" deadline=2024-12-31
/tracker action=list status=pending
```
