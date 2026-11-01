---
name: report
description: Generate airdrop farming reports and summaries
---

# Report Skill

Generates comprehensive reports on airdrop farming activities.

## Parameters

- `type` (string): scam_report, risk_report, task_report, earnings_report
- `period` (string): Time period (7d, 30d, all)
- `include_data` (boolean): Include detailed transaction data

## Output

- Summary statistics
- Earnings breakdown
- Risk analysis
- Task completion rate
- Recommendations

## Example

```
/report type=earnings_report period=30d include_data=true
```
