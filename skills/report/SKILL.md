---
name: report
description: Generate airdrop farming reports from real tracker tasks
---

# Report Skill

Generates a report from the real task database. Nothing is estimated or
invented: counts come from stored tasks.

## Parameters

- `period` (string): `7d`, `30d`, or `all` (default `all`). Tasks are
  filtered by creation date inside the window.

## Output

- Summary statistics (total, pending, in progress, completed, failed,
  overdue — zero on an empty database, never null)
- Tasks by status, including `cancelled`
- Task list for the period

## Example

```
/report period=30d
```
