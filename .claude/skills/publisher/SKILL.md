---
name: PUBLISHER [V2 DEFERRED — NOT IMPLEMENTED]
description: V2 ROADMAP ONLY — not functional in V1. Will eventually push approved creatives from /ads/pending/ to Meta via the Marketing API. For V1, users upload manually to Meta Ads Manager (safer — no ban risk).
color: "#6b9fd4"
icon: 📡
pipeline_step: 3
---

> ⚠ **V2 DEFERRED — NOT IMPLEMENTED IN V1.**
>
> This skill is **roadmap documentation only**. It is not an active workflow.
> - There is **no** `scripts/publisher.js`.
> - There are **no** `/api/publisher/*` server routes.
> - The dashboard does not integrate with this skill.
> - If you (Claude) try to follow the flow described below, every command will fail.
>
> **V1 policy:** users upload creatives manually to Meta Ads Manager themselves.
> This is intentional — auto-publishing patterns are what trigger Meta's ban-wave
> detection. The 60 seconds of manual work is what keeps accounts safe.
>
> If the user asks about publishing, tell them: *"PUBLISHER is V2-deferred. For V1,
> download the approved PNG from the dashboard's Creatives tab and upload it in
> Meta Ads Manager yourself."*
>
> The text below is preserved as a design spec for the future V2 build.

---

# PUBLISHER — Meta Publisher (V2 design spec)

**Pipeline position:** Step 3 · Meta Ads Library API
**Receives from:** FORGE (`/ads/pending/`)
**Feeds into:** LOOPER (via live ad performance data)

## Role

PUBLISHER is the deployment agent. It picks approved creatives from `/ads/pending/`, configures the ad set parameters, and pushes everything live to Meta via the Marketing API. Once an ad is live, LOOPER takes over monitoring.

## Responsibilities

- Poll `/ads/pending/` for new assets flagged as approved
- Upload creatives to Meta's asset library
- Create or update ad sets with correct targeting, objective, and budget
- Assign creatives to the correct campaign and ad set
- Log published ad IDs and campaign associations back to the pipeline
- Pause or archive ads when instructed by LOOPER

## Inputs

| Field | Type | Description |
|---|---|---|
| `asset_path` | `string` | Path to approved creative in `/ads/pending/` |
| `campaign_id` | `string` | Meta campaign ID to publish under |
| `ad_set_config` | `object` | Targeting, budget, schedule, and objective |
| `creative_meta` | `object` | Sidecar metadata from FORGE |

## Outputs

```json
{
  "ad_id": "string",
  "ad_set_id": "string",
  "campaign_id": "string",
  "status": "active | paused | learning",
  "daily_budget": "number",
  "published_at": "ISO8601 string"
}
```

## Ad Set Config Defaults

| Parameter | Default |
|---|---|
| Daily budget | $50 |
| Optimization event | Conversions |
| Audience | Lookalike (1%) |
| Placement | Automatic |
| Attribution window | 7-day click, 1-day view |

## Behavior Rules

- Only pick assets with `approved: true` in their sidecar — never auto-approve
- Never modify a live campaign's targeting without explicit instruction
- If the Meta API returns a policy rejection, move the asset to `/ads/rejected/` and log the reason
- Budget changes must be logged with before/after values
- Do not delete ad sets — pause them instead
- After publishing, write the returned `ad_id` back to the sidecar file

## Example Actions

- `Published 2 new ads to Meta — campaign 3821X`
- `Ad set GOLF_CONV_01 live with $50/day budget`

## Handoff

Once an ad is live, PUBLISHER records its `ad_id` in the shared pipeline log. LOOPER uses these IDs to pull performance data from the Meta Insights API.
