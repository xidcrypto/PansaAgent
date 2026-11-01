---
name: tracker
description: Track airdrop tasks, progress, and deadlines
---

# Tracker Skill

Manages airdrop farming tasks with deadlines and progress tracking.

## Parameters

- `action` (string): create, update, list, get, remove
- `task_id` (string): Task identifier
- `title` (string): Task description
- `status` (string): pending, in_progress, completed, failed
- `deadline` (string): ISO 8601 deadline

## Output

- Task list with status
- Progress summary
- Upcoming deadlines
- Completed tasks count

## Example

```
/tracker action=create title="Complete LayerZero testnet bridge" deadline=2024-12-31
/tracker action=list status=pending
```
