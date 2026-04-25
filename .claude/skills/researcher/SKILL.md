---
name: RESEARCHER
description: Competitive ad intelligence. You (Claude) view the user's competitor ad SCREENSHOT and analyse both the visual creative AND the text copy yourself — extracting visual pattern, hooks, emotion, format, angle — then call scripts/researcher.js to persist the analysis. No external LLM API is used. The user's Claude Code subscription is the intelligence layer.
color: "#d46ca4"
icon: magnifier
pipeline_step: 0.5
---

# RESEARCHER — Competitor Ad Intelligence

**Pipeline position:** Step 0.5 · Research
**Intelligence:** You (Claude, running inside Claude Code) — you have vision, use it
**Storage:** `scripts/researcher.js save` → `state/research.json` + `state/research/images/`
**Feeds into:** FORGE (as `copyable_pattern` + `visual_pattern` references in its prompt writing)

## Role

There are **three** kinds of patterns this skill saves to `state/research.json`. They share the same shape; what differs is the source. FORGE reads all three when generating prompts:

1. **`competitor_ad`** *(default)* — User finds an ad in the Meta Ad Library, screenshots it, and passes you the file path. You view the image, analyse both visual + text, save it.
2. **`user_described_style`** *(new)* — User describes the visual style they want in their own words (no competitor ad on hand). You formulate a pattern from their description so future FORGE runs inherit it.
3. **`looper_winner`** *(automatic, written by LOOPER)* — When LOOPER amplifies a winning ad, that winner's pattern gets written here too so other skills can reference it.

The user's Claude Code subscription pays for the intelligence. No separate Anthropic API key. The script is storage-only.

**Browse-then-screenshot** is still the default flow for competitor ads — paste-text-only misses the image (the whole point of an image ad). User must save the screenshot to disk first; Claude can SEE pasted images via vision but can't save the binary bytes — see the limitation box below.

## Input — image-first, text-supplementary

**Most Meta ads are image ads.** The image IS the ad — text alone misses the most important signal. The right way to feed RESEARCHER is:

1. **The user saves the screenshot to a file on disk first.** Right-click → Save image as → save into the project folder (or anywhere they want). Pasted-into-chat-only doesn't work — Claude can SEE the pasted image (vision is fine) but **cannot save its bytes to a file** with the available tools. The thumbnail in the dashboard's Research tab requires the file to exist on disk.
2. **The user gives Claude the file path** (or drops the file into chat — Claude will read the path from the file reference).
3. **Optionally paste the text fields** (headline, body, CTA, advertiser, niche) — adds depth, lets FORGE match by `niche` later.

Minimum bar to save: **at least one of** an image-on-disk OR a `headline`/`body`. Both is best. If the user gives you only text, save with text-only (no `visual_analysis`). If they give you only an image, save with image-only (no text fields). Both → richest record.

> ### ⚠️ Critical limitation: Claude cannot save pasted-from-clipboard images
>
> When a user pastes an image directly into chat (clipboard paste, drag from screenshot tool), Claude CAN view it (vision works) but **cannot save the binary bytes to a file** — the image lives only in the conversation context. So if the user only pastes:
> - The text + visual analysis can still be done. Save with `image_path: null`.
> - The dashboard will show a "text only" placeholder thumbnail.
> - The pattern is still useful for FORGE (`visual_pattern` captures what's needed in text).
>
> To get a thumbnail in the dashboard, the user must:
> 1. **Right-click the image in their browser → "Save image as…"** OR use Win+Shift+S / Cmd+Shift+4 to capture, then save the result.
> 2. **Save into a known path** — easiest: the project root, or `state/research/inbox/`.
> 3. **Tell Claude the path** (relative or absolute). Claude passes it to `researcher.js save` via the `image_path` field; the script copies it into `state/research/images/{id}.{ext}`.
>
> Always tell the user this clearly when they paste an image without a path. Don't silently lose the file.

| Field | Required? | What it is |
|---|---|---|
| **image-on-disk** | one of image/text required | Path to a saved screenshot file on disk. Drag the file into chat OR tell Claude the path. |
| `headline` | one of text required | Bold first line of the ad |
| `body` | one of text required | Longer paragraph below |
| `cta` | optional | Button text (e.g. "Book Now", "Shop Now") |
| `advertiser` | optional but helpful | Brand name running the ad |
| `source_url` | optional | The specific Meta Ad Library URL for that ad |
| `niche` | **always ask if missing** | The audience/vertical, specific to the user's product. e.g. *"B2B sales/operations consulting for design-build remodelers"* |

If the user is unsure where to find ads, walk them through it:
1. Open https://www.facebook.com/ads/library/
2. Set country (UK if their Meta account is GBP) + category: All ads
3. Search competitor brand names OR keywords for their niche
4. **Filter to ads running ≥30 days** — long-runners are winners (Meta wouldn't keep losers live)
5. **Right-click the ad image → "Save image as…"** Save into the project folder (or anywhere they'll remember)
6. Tell Claude the file path + advertiser + niche. (If they paste the image inline instead, Claude will analyse it but cannot save the file — see the limitation box above.)

## Your job — TWO analyses (visual + text)

You produce two structured blocks. Both go in the JSON payload to `save`.

### A. Text analysis (`analysis` field) — same shape as before

```json
{
  "hooks": ["string"],
  "emotion": "string",
  "format": "string",
  "angle": "string",
  "cta_type": "string",
  "target_persona": "string",
  "strengths": ["string"],
  "weaknesses": ["string"],
  "copyable_pattern": "string"
}
```

| Field | What it is |
|---|---|
| `hooks` | 2–4 short hook-pattern labels: `urgency`, `social proof`, `before/after`, `question opener`, `problem-agitate-solve`, `status claim`, `number claim`, `founder story`, etc. |
| `emotion` | Single dominant emotion: `curiosity` \| `aspiration` \| `fear` \| `urgency` \| `humor` \| `trust` \| `envy` \| `belonging` \| `pride` \| `frustration` |
| `format` | `testimonial` \| `product_shot` \| `lifestyle` \| `comparison` \| `demo` \| `founder_story` \| `ugc_style` \| `ad_reveal` \| `text_statement` \| `before_after` |
| `angle` | One sentence ≤ 15 words: the core argument the ad makes |
| `cta_type` | `direct` \| `soft` \| `curiosity` \| `urgency` \| `none` |
| `target_persona` | One sentence: who the ad is aimed at |
| `strengths` | 2–3 specific things this ad does well that are worth copying |
| `weaknesses` | 1–2 weaknesses or risks |
| `copyable_pattern` | **The critical text field.** 40–80 words, de-branded structural template that applies to ANY product. |

### B. Visual analysis (`visual_analysis` field) — REQUIRED if image_path provided

```json
{
  "composition": "string",
  "color_palette": "string",
  "faces_present": true,
  "text_in_image": "string",
  "lighting": "string",
  "mood": "string",
  "format_type": "string",
  "distinctive_elements": ["string"],
  "visual_pattern": "string"
}
```

| Field | What it is |
|---|---|
| `composition` | One sentence on the framing — *"central single-subject hero shot with negative space top-left"* |
| `color_palette` | Dominant tones — *"warm cream + brushed brass + deep walnut"* |
| `faces_present` | Boolean. True if any human face is visible. |
| `text_in_image` | What text appears IN the image (not just the ad copy below). Often a headline overlay, a number, or nothing. *"Large bold serif headline 'GET 50% MORE LEADS' bottom-third"* or *"None — text-free"* |
| `lighting` | *"Warm late-afternoon natural light from camera-left"* |
| `mood` | *"Aspirational, calm, premium"* / *"Urgent, kinetic, social-proofy"* |
| `format_type` | `photo_realistic_lifestyle` \| `cartoon_illustration` \| `product_on_white` \| `before_after_split` \| `screenshot_ui` \| `meme_style` \| `talking_head` \| `infographic` \| `graphic_typography` |
| `distinctive_elements` | 2–4 things that make THIS ad recognisable — *"yellow circle around the price"*, *"face zoomed to fill 70% of frame"*, *"checkmark icons next to each line"* |
| `visual_pattern` | **The critical visual field.** 40–80 words, de-branded structural template that applies to ANY product. *"A single-character cartoon illustration showing before/after states in split composition, warm-saturated palette, large headline overlay top-third, no real product visible — focus is on the human transformation moment."* This is what FORGE will lean on when generating fresh image prompts. |

## Your job — the analysis (produced in-chat, not via API)

Read the ad copy the user gave you. Produce this exact JSON shape:

```json
{
  "hooks": ["string"],
  "emotion": "string",
  "format": "string",
  "angle": "string",
  "cta_type": "string",
  "target_persona": "string",
  "strengths": ["string"],
  "weaknesses": ["string"],
  "copyable_pattern": "string"
}
```

Field definitions:

| Field | What it is |
|---|---|
| `hooks` | 2–4 short hook-pattern labels: `urgency`, `social proof`, `before/after`, `question opener`, `problem-agitate-solve`, `status claim`, `number claim`, `founder story`, etc. |
| `emotion` | Single dominant emotion: `curiosity` \| `aspiration` \| `fear` \| `urgency` \| `humor` \| `trust` \| `envy` \| `belonging` \| `pride` \| `frustration` |
| `format` | One of: `testimonial` \| `product_shot` \| `lifestyle` \| `comparison` \| `demo` \| `founder_story` \| `ugc_style` \| `ad_reveal` \| `text_statement` \| `before_after` |
| `angle` | One sentence ≤ 15 words: the core argument the ad makes |
| `cta_type` | `direct` \| `soft` \| `curiosity` \| `urgency` \| `none` |
| `target_persona` | One sentence: who the ad is aimed at |
| `strengths` | 2–3 specific things this ad does well that are worth copying |
| `weaknesses` | 1–2 weaknesses or risks |
| `copyable_pattern` | **The critical field.** 40–80 words describing the reusable creative pattern **generalized so it applies to any product**. No brand references, no niche references. This is what FORGE will later fold into its prompts when generating creatives for a different product. |

## Flow B — `user_described_style` (when no competitor ad is on hand)

Sometimes the user wants to give FORGE visual direction without finding a specific competitor ad. e.g. *"I want face-driven ads with bold typography, kinetic and urgent — like a TikTok founder pitch."* Capture that as a pattern so FORGE inherits it.

1. **Ask 3 questions to lock down the direction:**
   - *"Who's the target audience / what's the niche?"* → fills `niche`
   - *"What's the dominant format?"* (talking-head, before-after, product-on-white, graphic-typography, lifestyle, etc.) → fills `visual_analysis.format_type`
   - *"Any specific must-haves or must-avoids?"* (faces, text overlay, colour, mood) → fills `visual_analysis.distinctive_elements` and other fields

2. **Formulate the pattern from their words.** You're translating their description into the same JSON shape a competitor ad would produce — but instead of viewing an image, you're inferring fields from the user's instruction.

3. **Required fields when source is `user_described_style`:**
   - `pattern_source: "user_described_style"`
   - `niche` (always)
   - `body` (the user's verbatim description — the source-of-truth phrasing)
   - `analysis.copyable_pattern` (a sentence summarising the structural rule, useful for FORGE prompt generation)
   - `visual_analysis` with at least `format_type`, `mood`, and `visual_pattern` populated. Other fields can be inferred conservatively or left empty.

4. **Save:**
   ```bash
   node scripts/researcher.js save '{
     "pattern_source": "user_described_style",
     "advertiser": "(user-described style)",
     "niche": "...",
     "body": "...verbatim user description...",
     "analysis": { "copyable_pattern": "...", "hooks": [...], "format": "...", ... },
     "visual_analysis": { "format_type": "...", "mood": "...", "visual_pattern": "...", ... }
   }'
   ```

5. **Confirm back to user:** *"Saved as a `user_described_style` pattern. From now on, FORGE runs will inherit this style direction. Add 1–2 actual competitor screenshots (Flow A) anytime to ground it further."*

---

## Flow A — `competitor_ad` (the original flow, image-first)

1. User says "analyse this competitor ad" or triggers `/researcher`. They drop a screenshot in chat (and/or paste text).
2. **If they only gave a URL**, ask them to either screenshot the ad or paste headline+body. URL fetch will fail (Ad Library is bot-walled).
3. **Ask for `niche` if missing.** This is FORGE's filter key — never skip it.
4. **View the image directly** if provided. Use your vision capability to assess composition, colour, faces, text-in-image, lighting, mood, format, distinctive elements, and write the `visual_pattern`. Don't paraphrase what you'd guess from the headline alone — *look at the actual image*.
5. **Read the text** if provided. Produce the `analysis` block.
6. **If the user provided an image but no save-able file path**, save the image somewhere they can pass — typical pattern: ask Claude Code to save it to `state/research/images/_inbound/<filename>` first via the Write tool, then pass that path as `image_path`. If the user passes a path directly (e.g. `~/Downloads/ad.png`), use that — researcher.js will copy it.
7. Build the full payload:
   ```json
   {
     "advertiser": "...",
     "niche": "...",
     "headline": "...",
     "body": "...",
     "cta": "...",
     "source_url": "...",
     "image_path": "absolute or repo-relative path to screenshot",
     "analysis": { /* text analysis JSON */ },
     "visual_analysis": { /* visual analysis JSON — required when image_path is set */ }
   }
   ```
8. Call the storage script:
   ```bash
   node scripts/researcher.js save '<json>'
   ```
   (use the Bash tool; pass the JSON as a single argument)
9. Read the returned item (now has `id`, `created_at`, and `image_path` rewritten to the persisted location).
10. **Summarize back to the user in plain English.** Lead with the highest-signal observation. *"Saved. Dominant pattern: cartoon-style before/after split, warm palette, no product shown. Text hook: number-claim + urgency. The visual approach is what FORGE should borrow — that pattern is what differentiates this ad from generic stock photography in the niche."*
11. Tell them how to see it: *"Visible in the dashboard's Research tab — image thumbnail + analysis. Run `node scripts/researcher.js list` to print all."*

## Other commands

```bash
node scripts/researcher.js list            # all items (JSON)
node scripts/researcher.js show <id>       # one item
node scripts/researcher.js delete <id>     # remove
node scripts/researcher.js stats           # { count, last_at }
```

## Behavior rules

- Never invent copy the user didn't provide — if a field is missing, ask
- Never paraphrase the user's pasted headline/body before saving — preserve the verbatim text
- For `copyable_pattern`, generalize ruthlessly — if you name the brand or product category, FORGE can't reuse it for other products
- Don't batch-save multiple ads in one call — one `save` per ad so each gets its own ID and timestamp
- If the user gives a source URL, save it verbatim (useful for revisiting the original ad later)

## Why paste-text and not URL-fetch (V1)

Meta's official Ad Library API only returns political/social-issue ads in the EU (2026 policy). Commercial ads aren't exposed. Scraping the public Ad Library UI is legally defensible (see *Meta v. Bright Data* 2024 ruling for logged-out access) but IP-bannable at scale. Paste-text mode is bulletproof: the user does the "find" step manually in their browser; we do the "analyze + organize" step locally.

## Activity logging

Each `save` call appends a line to `state/activity.jsonl` which the dashboard's terminal pane reads in real time. Users see "Saved r_abc123 — advertiser · hooks: urgency, social proof" appear live while you're working.

## Handoff

FORGE reads `state/research.json`, filters by `niche` matching the current brief, and folds the top-3 `copyable_pattern` strings into the prompts it asks you to write when generating creatives. The feedback loop is: your analyses become FORGE's reference material.

## Self-invocation & pipeline chaining

This skill is callable two ways:
- **User-invoked:** `/researcher` typed in chat
- **Self-invoked:** Claude invokes via the Skill tool, or runs `node scripts/researcher.js save '<json>'` directly after producing the analysis inline. The intelligence (the analysis itself) is always Claude — there's no LLM API call.

**Natural next skill:** FORGE (with the just-saved pattern factored in via `niche` matching).

**Auto-chain rules:**
- If the user is in "full pipeline" mode AND has pasted a competitor ad, run RESEARCHER first, then auto-chain to FORGE.
- If the user is in "full pipeline" mode but has NOT pasted a competitor ad, skip RESEARCHER entirely — FORGE works fine with zero patterns.
- Each `save` is per-ad — don't batch multiple ads in one call.
