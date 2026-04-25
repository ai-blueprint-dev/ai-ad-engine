---
name: LOOPER
description: V1 self-learning feedback loop. Reads live Meta performance, computes an account-level benchmark on the chosen metric, and classifies every eligible ad into three buckets — 🏆 winners, ⚖ contenders, ⚠ losers. Claude views each image and writes structured analysis (winning_elements + improvement_hypotheses for winners; failure_modes + change_hypotheses for losers). FORGE then generates targeted variants — amplifying winners or rewriting losers — and a markdown playbook tells the user how to upload them to Meta Ads Manager.
color: "#b298d6"
icon: 🔁
pipeline_step: 4
---

# LOOPER — Self-Learning Feedback Loop (V1)

**Pipeline position:** Step 4 · Performance → Generator (closes the loop)
**Reads:** local `/api/meta/ads` (Meta Marketing API v25)
**Writes:** `state/winning_patterns.json` · `state/losing_patterns.json` · `state/playbooks/{ad_id}_{ts}.md`
**Triggers:** FORGE — winners with `reference_images` set; losers without (deliberately AVOIDS the failing approach)

## Why three buckets, not two

A real learning loop has to act on both halves of the signal. Winners get amplified — make more of what works. Losers get rewritten — fix what's broken. Contenders just need more time. The script enforces this structurally:
- `winning_patterns.json` and `losing_patterns.json` are separate files with different schemas.
- `amplify` only works on enriched winners (preserves visual style via reference image).
- `rewrite` only works on enriched losers (no reference image — explicitly avoids the failing approach).
- Contenders are never enriched and never amplified — they're informational only until the next analyze tells you which way they tipped.

## What makes a winner / loser (the math)

Eligible = passed all gates: `min_spend`, `min_days`, `image-only` (default), not in Meta's learning phase. Eligible ads are SCORED on the chosen metric.

The **benchmark** = median score across all eligible ads (or the user's `--benchmark` override, e.g. *"my target CPL is £30"*). Bucket assignment:
- **🏆 Winner** — score is ≥`winner_margin`% better than benchmark (default 20%).
- **⚠ Loser** — score is ≥`loser_margin`% worse than benchmark (default 50%) **OR** has zero conversions on substantial spend.
- **⚖ Contender** — anything in between, OR the only data point (no benchmark possible yet).

If only one ad is eligible, it lands in **contenders** — there's no benchmark, so calling it a "winner" would be dishonest. The system tells the user this directly: *"Only one eligible ad — keep spending so we can build a benchmark."*

## Customisation conversation (up front)

When the user says `/looper`, **ask before running**. The defaults are sensible but customisation is the whole point — different users have different definitions of winning.

> *"Before I run analyse, let me confirm what 'winning' means for your account.*
>
> *Defaults: lowest CPL, image-only, ≥£50 spent and ≥7 days running per ad. Winners must beat the account benchmark by 20%; losers fall behind by 50%.*
>
> *Common alternatives:*
> - *'I want to score by lead volume, not CPL'* → `--metric leads`
> - *'My target CPL is £30 — make that the benchmark'* → `--benchmark 30`
> - *'Stricter — ≥£100 spent and 14 days minimum'* → `--min-spend 100 --min-days 14`
> - *'Last 30 days only'* → `--range 30d`
> - *'Looser winner margin — 10% beats benchmark'* → `--winner-margin 10`
> - *'Include video ads even though we can't amplify them'* → `--include-video`
>
> *Want defaults or custom?"*

## Standard skill flow

### 1. Run analyze (with confirmed criteria)

```bash
node scripts/looper.js analyze [--metric ...] [--min-spend ...] ...
```

Output is structured: `{ ok, criteria, benchmark, winners: [], contenders: [], losers: [], rejected_summary: [] }`. Each winner/loser has a `why` field — a one-sentence explanation of why it landed there. Read these — they're the truth.

### 2. Report the result honestly

Tell the user the count in each bucket, the benchmark, and the dominant signal. **Lead with the unsexy answer if that's what's true** — *"You don't have winners yet, just contenders. Keep spending, re-run in 7 days."*

If there ARE winners or losers, say what the dominant pattern is across them. *"All 3 winners avoid product photography in favour of illustration."* / *"Both losers have product-on-white-background composition — that's not converting for your audience."*

### 3. Enrich each winner

For each ad in `needs_winner_enrichment`:
- **View the image** (open `pattern.thumb_url` — your vision capability is the analyser).
- **Write structured analysis:**
  - `confidence: { enough_data: bool, reason: string }` — be honest. Borderline data → say so.
  - `hook` — short label (`urgency`, `transformation`, `social_proof`, `problem_solution`, `comparison`, `before_after`, `lifestyle`, `founder_story`).
  - `copyable_pattern` — de-branded structural template a copywriter could fill for any product.
  - `visual_notes` — 2-3 sentences on composition, color, faces, text-in-image, format.
  - `winning_elements` (≥2) — concrete observations of what's working that variants should preserve.
  - `improvement_hypotheses` (≥2) — testable hypotheses; each becomes one FORGE prompt.
  - `meta_settings` — campaign objective, audience to clone, daily budget, A/B structure, target CPL/CTR, kill threshold.
  - `brief_addendum` — 1-2 sentences appended to every variant prompt.
- Save: `node scripts/looper.js save '<json>'`

### 4. Enrich each loser

For each ad in `needs_loser_enrichment`:
- **View the image.**
- **Write loser analysis:**
  - `confidence: { enough_data: bool, reason: string }`.
  - `hook_observed` — what hook the loser was attempting (so the rewrite can pick a different one).
  - `visual_notes` — 2-3 sentences on what's there now.
  - `failure_modes` (≥2) — concrete observations of what's not working. *"Product shown directly with no human context"*, *"Cluttered composition with three competing focal points"*.
  - `change_hypotheses` (≥2) — specific changes to try; each becomes one rewrite prompt.
  - `rewrite_or_pause` — `'rewrite'` if alternatives are likely to do better, `'pause'` if you think the audience/offer is wrong (rewriting won't help).
  - `meta_settings` — same shape as winners; if `rewrite_or_pause: 'pause'` you can leave most fields and just include a kill instruction.
  - `rewrite_brief_addendum` — direction for FORGE, e.g. *"Lead with the human outcome, hide the product"*.
- Save: `node scripts/looper.js save '<json>'` (auto-routes to losing_patterns.json based on `failure_modes` field).

### 5. Recommend next action

After enriching, tell the user concretely:
- *"Run `/looper amplify <winner_id>` to generate 4 variants of [winner name]. Each variant tests one of the hypotheses I wrote."*
- *"Run `/looper rewrite <loser_id>` to generate 4 alternatives to [loser name]. The rewrites do NOT use it as a reference — they explicitly avoid the failing approach."*
- *"The third loser is recommended for `pause` — Claude judged the audience/offer is the issue, not the creative. No rewrite will fix it."*

## Amplify (winners) vs Rewrite (losers)

| | Amplify | Rewrite |
|---|---|---|
| Bucket | 🏆 winner | ⚠ loser |
| fal.ai reference image | YES — winner's image attached, variants stay visually on-brand | NO — explicitly avoids the loser's approach |
| Prompt frame | "Test this hypothesis while preserving these winning elements" | "Try this approach, AVOID these failure modes" |
| Pattern fields | improvement_hypotheses · winning_elements | change_hypotheses · failure_modes |
| Refuses if | not enriched · video format | not enriched · `rewrite_or_pause: 'pause'` |
| Output | variants in `ads/pending/`, grouped under source winner | alternatives in `ads/pending/`, tagged as rewrites |
| Playbook tone | "Duplicate the winning ad set, run new variants alongside" | "Pause the loser first, then run alternatives" |

## Hard rules

- **Never enrich without viewing the image.** The whole loop's value depends on Claude's vision.
- **Be honest about confidence.** If `metrics.spend < 2× min_spend` or `days_running < 1.5× min_days`, mark `confidence.enough_data: false` and say so.
- **`winning_elements`/`failure_modes` ≥ 2, `improvement_hypotheses`/`change_hypotheses` ≥ 2.** The save command rejects below that.
- **The `why` field is generated by the script — don't fabricate it.** Repeat it verbatim to the user. It's grounded in the math.
- **`pause` is a valid recommendation** for losers. If your analysis says "the audience is wrong, no creative change will help", say `rewrite_or_pause: 'pause'`. The rewrite command will refuse, which is correct — don't waste fal.ai credits on doomed variants.
- **The dashboard is read-only.** All criteria customisation runs through Claude Code → CLI flags. Don't suggest UI knobs that don't exist.
- **Image-only is the default.** Video patterns can be analysed (for understanding) but can't be amplified — the script enforces this.

## CLI reference

| Command | Purpose |
|---|---|
| `analyze [--flags]` | Score, classify, save skeletons for both buckets |
| `list [--bucket winners\|losers]` | Print saved patterns |
| `show <ad_id>` | Print one pattern (auto-finds across both buckets) |
| `save '<json>'` | Save enrichment (auto-routes by category / schema) |
| `delete <ad_id>` | Drop a saved pattern |
| `amplify <ad_id>` | Generate winner variants (refuses without enrichment) |
| `rewrite <ad_id>` | Generate loser alternatives (refuses without enrichment or if `pause`) |

### Customisation flags (analyze)

| Flag | Default | Purpose |
|---|---|---|
| `--metric` | `cpl` | What to score on. Lead-gen: `cpl`, `leads`, `ctr`. Sales: `roas`. |
| `--direction` | inferred | `asc` (lower=better) or `desc`. CPL/CPC/CPM are asc; everything else desc. |
| `--min-spend` | `50` | £ floor for confidence. Raise to 3× target_cpl for high-CPL niches. |
| `--min-days` | `7` | Days running. Matches Meta's learning-phase exit window. |
| `--top` | `3` | Max winners + max losers (each capped separately). |
| `--include-video` | off | Image-only by default since FORGE generates images. |
| `--range` | `180d` | Lookback window. |
| `--winner-margin` | `20` | % better than benchmark to qualify as winner. |
| `--loser-margin` | `50` | % worse than benchmark to qualify as loser. |
| `--benchmark` | median | Override with a fixed target value (e.g. `--benchmark 30` for £30 CPL). |

## Pattern schemas

### Winner

```json
{
  "category": "winner",
  "source_ad_id": "...", "source_ad_name": "...", "source_campaign": "...", "source_adset": "...",
  "score": 24.95, "score_metric": "cpl", "score_direction": "asc",
  "benchmark": 62.0, "why": "£24.95 CPL — 60% better than your account benchmark of £62.00.",
  "criteria": { ...flags used... },
  "metrics": { ...spend/leads/cpl/ctr/etc... },
  "days_running": 65, "creative_format": "image", "thumb_url": "...", "headline": "...", "objective": "...",

  "confidence": { "enough_data": true, "reason": "..." },
  "hook": "transformation",
  "copyable_pattern": "...",
  "visual_notes": "...",
  "winning_elements": [ "...", "..." ],
  "improvement_hypotheses": [ "...", "..." ],
  "meta_settings": { "campaign_objective": "...", "audience_clone_from": "...", "daily_budget_each": "...", "ab_test_structure": "...", "target_cpl": "...", "target_ctr": "...", "kill_threshold": "..." },
  "brief_addendum": "...",

  "captured_at": "...", "enriched_at": "...",
  "amplified_runs": [ { "ts": "...", "n_succeeded": 4, "playbook_path": "..." } ]
}
```

### Loser

```json
{
  "category": "loser",
  "source_ad_id": "...", "source_ad_name": "...", ...,
  "score": 104.7, "benchmark": 62.0,
  "why": "£104.70 CPL — 69% worse than your account benchmark of £62.00. Time to rewrite or pause.",

  "confidence": { "enough_data": true, "reason": "..." },
  "hook_observed": "problem_aware",
  "visual_notes": "...",
  "failure_modes": [ "...", "..." ],
  "change_hypotheses": [ "...", "..." ],
  "rewrite_or_pause": "rewrite",
  "rewrite_brief_addendum": "...",
  "meta_settings": { ... },

  "captured_at": "...", "enriched_at": "...",
  "rewrite_runs": [ { "ts": "...", "n_succeeded": 4, "playbook_path": "..." } ]
}
```

## Self-invocation & pipeline chaining

This skill is callable two ways:
- **User-invoked:** `/looper`, `/looper amplify <id>`, `/looper rewrite <id>` typed in chat.
- **Self-invoked:** Claude invokes via the Skill tool, OR runs the CLI commands directly. Each `amplify` or `rewrite` call internally self-invokes FORGE — that chain is already wired in `scripts/looper.js` via `child_process.spawn`.

**Natural next step:** the playbook markdown contains explicit Meta Ads Manager upload instructions. After amplify/rewrite, surface the playbook to the user. They upload manually (V1 — no PUBLISHER yet).

**Auto-chain rules:**
- Always confirm fal.ai cost before amplify/rewrite. ~£0.32 per run at default 4 variants.
- Don't auto-amplify after analyse — enrichment requires Claude actually viewing each image, which is the value-add. Auto-running would skip the intelligence step.
- After enrichment, suggest the next command (`/looper amplify <id>` or `/looper rewrite <id>`). The user picks which winners/losers to act on.
