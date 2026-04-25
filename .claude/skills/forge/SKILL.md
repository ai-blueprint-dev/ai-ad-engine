---
name: FORGE
description: Image ad creative generator. Claude Code writes N diverse image prompts from a brief + top competitor patterns, then hands them to scripts/forge.js which renders each via fal.ai. Supports two models through one fal.ai key — Nano Banana 2 (default) and GPT Image 2 (text-heavy ads).
color: "#e09020"
icon: flame
pipeline_step: 2
---

# FORGE — Image Ad Generator (V1: image-only)

**Pipeline position:** Step 2 · Creative Generation
**Intelligence:** You (Claude, running inside Claude Code) — writes the image prompts
**Renderer:** `scripts/forge.js` — calls fal.ai, saves PNGs to `ads/pending/`

## Role

You read a brief (from SCRAPER) and the top competitor patterns (from RESEARCHER) that match the niche, then write N diverse image-generation prompts yourself. Save them to a file. The script picks them up, renders each via the chosen model, and saves PNGs + `.meta.json` sidecars into `ads/pending/`.

**V1 scope: image ads only.** Video is explicitly deferred.

## Models (one fal.ai key unlocks both)

Both models are hosted by fal.ai. A single `FAL_KEY` credential covers both. No OpenAI key needed.

| Model | When to use | Cost @ 1024² | Strength |
|---|---|---|---|
| `nano-banana-2` (default) | Photorealistic product shots, lifestyle, rapid iteration, 100+ variants | **$0.08/image** | Fastest, cheapest, best photorealism, supports up to 14 reference images for brand consistency |
| `gpt-image-2` | Ads that genuinely need text rendered *inside* the image (headline, CTA, product name baked into pixels) | **$0.22/image high-quality** | 99% text rendering accuracy — the only option when creative is text-heavy |

Default to `nano-banana-2`. Only switch to `gpt-image-2` when the user explicitly needs text baked into the creative. Most Meta ads put text in the ad-set copy fields (not the image) — keep that in mind.

## Standard flow (what you, Claude, do in Claude Code)

1. **Load the brief.** The user gives you a `brief_id` (e.g. `b_aHR0cHM`). Run:
   ```bash
   node scripts/scraper.js show <brief_id>
   ```
   Read the JSON output: `product_name`, `price`, `hooks`, `headlines`, `visual_refs`, `tone`, `description`.

2. **Load all saved patterns.** These are the source of every aesthetic decision in the prompts you'll write. The skill carries no aesthetic opinions of its own — composition, text-overlay, faces, colour, mood all derive from what the user has saved.

   ```bash
   node scripts/researcher.js list
   node scripts/looper.js list
   ```

   Pattern priority order:
   1. **LOOPER winners with `enriched_at` set** — proven in the user's own account. Highest weight.
   2. **RESEARCHER competitor ads** with `niche` matching the current brief's product category.
   3. **RESEARCHER user-described styles** (`pattern_source: 'user_described_style'`) — user's stated preferences.

   **If all sources are empty,** the user has given the skill no aesthetic basis. Don't refuse and don't invent one. Have a short conversation:

   > *"I have no saved patterns yet. Two ways to give me visual direction:*
   > *A. **Save 1–3 competitor screenshots first** via `/researcher` — concrete patterns from the Meta Ad Library. (Preferred — gives me grounded examples.)*
   > *B. **Describe the style you want** in your own words — e.g. 'face-driven, bold typography, urgent tone' or 'minimal product-on-white, premium feel'. I'll formulate that into a pattern via `/researcher` and save it persistently — so future FORGE runs inherit it without you having to re-describe.*
   > *Which?"*

   If they pick B, capture their description and save it as a `user_described_style` pattern via RESEARCHER (see RESEARCHER skill for the exact flow). It persists in `state/research.json` and behaves like any other pattern.

   **Read each loaded pattern's `visual_analysis` carefully.** Note distribution across patterns:
   - What `format_type` values appear? (`talking_head`, `before_after_split`, `product_on_white`, `graphic_typography`, etc.) Each pattern in your N prompts should structurally match one of the loaded format_types — proportionally to how many patterns of that type are saved.
   - Do any have `text_in_image` populated? If yes, text overlay is in the user's competitive landscape — at least some prompts should include it. If all `text_in_image` are "None", skip text overlay.
   - Are `faces_present: true` patterns saved? If yes, faces belong in some prompts. If no, the user's saved patterns are face-less — don't impose faces.
   - What `color_palette`, `lighting`, `mood`, `composition` strings appear across patterns? Reuse that vocabulary in prompts. Don't introduce vocabulary from outside (no "Architectural Digest", "editorial magazine", "Pinterest aesthetic" unless the saved patterns explicitly use those words).

3. **Write the prompts.** Produce exactly `N` (default 4) prompts. Every aesthetic decision must be **traceable to a saved pattern OR an explicit user instruction** — never invented by the skill.

   Each prompt MUST:

   - **Map to a specific hook from `brief.hooks[]`.** Name the hook in the prompt's `hook` field. The visual must literally embody that hook (if brief mentions *"pipeline leaks"*, depict that; if *"45-min diagnostic"*, depict that). Don't write 4 generic shots of the niche — write 4 prompts each grounded in a different brief hook.

   - **Structurally match a saved pattern's `format_type`.** Open the loaded patterns. For each prompt you write, you should be able to point to a saved pattern and say *"prompt 1 mirrors pattern X (format_type: talking_head), prompt 2 mirrors pattern Y (format_type: graphic_typography)…"*. The proportion of formats across your N prompts should roughly mirror the proportion of formats across saved patterns. If 3 of 4 saved patterns are `talking_head` and 1 is `before_after_split`, write 3 talking-head prompts and 1 split prompt — not 4 magazine hero shots.

   - **Inherit aesthetic vocabulary from the patterns.** Use the actual phrases and words from the patterns' `visual_analysis.color_palette`, `lighting`, `mood`, `composition`, `distinctive_elements`, and `visual_pattern` fields. Don't introduce aesthetic adjectives the patterns don't use.

   - **Decide text-overlay from the patterns + user instruction:**
     - If any saved pattern has `text_in_image` populated AND `format_type` is text-led (e.g. `graphic_typography`), include text overlay matching that pattern's structure (e.g. *"bold all-caps headline overlay bottom-third + light-cyan subhead + solid pill CTA"*). Adapt the actual text to the brief's hooks — never copy the competitor's words.
     - If the user explicitly asked for text overlay in chat, include it.
     - If neither — skip text overlay. (User can add their own copy in Ads Manager if needed.)
     - The old "no text in the image" rule is gone. Meta dropped that policy in 2020. Both nano-banana-2 and gpt-image-2 render text well; gpt-image-2 is marginally cleaner for text-heavy creatives.

   - **Decide whether faces appear from the patterns:**
     - If any saved pattern has `faces_present: true`, faces are in the user's competitive landscape — include them in some prompts.
     - If all saved patterns are face-less, don't add faces — the user's saved competitive set deliberately doesn't use them.
     - If the user explicitly asks for face-driven ads in chat, override and include faces regardless of patterns.

   - **Be 50–80 words.** Include camera direction, lighting, composition — but use the patterns' own vocabulary.

   - **Never name any brand or use real product names visible in the image.**

   ### Forbidden phrases unless they appear in a saved pattern's `visual_analysis`
   These phrases consistently push fal.ai toward art photography rather than ad creative. If you find yourself reaching for them, it's a sign you're inventing aesthetic instead of inheriting it:
   - *"Architectural Digest cover quality"*, *"editorial magazine quality"*, *"Pinterest-grade"*, *"premium-craft aesthetic"*, *"art photography"*, *"editorial portrait"*
   - Any "magazine X" or "editorial Y" phrasing
   - *"Magic hour"* (overused — only use if patterns explicitly mention twilight/golden lighting)
   - *"Hero shot"* without further composition specifics

   Use only if a loaded pattern's text uses them.

   ### Self-check before saving
   For each prompt, you must be able to fill in this sentence:
   > *"Prompt N tests brief hook **__**, structurally mirrors saved pattern **__** (format_type: **__**), and uses aesthetic vocabulary from that pattern's `visual_analysis`."*
   If you can't fill in those blanks, rewrite the prompt.

4. **Save the prompts to a temp file.** Use the Write tool:
   ```
   state/tmp/forge-prompts-<timestamp>.json
   ```
   Shape:
   ```json
   [
     { "hook": "urgency_claim",    "prompt": "...", "reference_images": ["state/research/images/r_xyz.jpg"] },
     { "hook": "social_proof",     "prompt": "...", "reference_images": ["state/research/images/r_abc.jpg"] },
     { "hook": "problem_solution", "prompt": "...", "reference_images": [] },
     { "hook": "lifestyle",        "prompt": "...", "reference_images": ["state/research/images/r_xyz.jpg"] }
   ]
   ```

   **`reference_images` is the visual anchor.** When you write a prompt that structurally mirrors saved pattern X, include `pattern.image_path` in that prompt's `reference_images` array. fal.ai will use it as a visual style reference (composition, palette, mood, faces, text-overlay style — all flow from the reference image, not from your prompt's adjectives). This is what makes pattern-grounded FORGE actually look like the pattern, not generic photography.

   - If a saved pattern has `image_path` set, USE it as the reference for any prompt mirroring that pattern.
   - If a saved pattern is `user_described_style` (no image), reference_images is `[]` for prompts mirroring it — the prompt text alone carries the direction.
   - You can pass multiple references per prompt (up to 14) if a prompt blends two patterns.
   - forge.js auto-uploads local paths to fal.storage and switches to the model's `/edit` endpoint when references are present. URLs (Meta CDN, etc.) pass through unchanged.

5. **Run the renderer:**
   ```bash
   node scripts/forge.js generate <brief_id> --prompts-file state/tmp/forge-prompts-<ts>.json
   ```
   Default model is `nano-banana-2`. Add `--model gpt-image-2` only if you need text-baking.

6. **Report results.** Read the script's JSON output. Tell the user how many succeeded vs failed, which hooks were used, and where to find the creatives:
   - *"4/4 variants rendered via nano-banana-2. Total cost ≈ $0.32. Visible in the dashboard's Creatives tab."*

## Output shape

Each successful generation produces two files in `ads/pending/`:

- `{creative_id}.png`
- `{creative_id}.meta.json`:
  ```json
  {
    "id": "{brief_id}_{timestamp}_{i}",
    "brief_id": "...",
    "product_name": "...",
    "hook_used": "short label",
    "prompt": "full image prompt that was rendered",
    "model": "nano-banana-2",
    "provider": "fal:fal-ai/nano-banana-2",
    "aspect_ratio": "1:1",
    "created_at": "ISO8601",
    "source_url": "...",
    "fal_request_id": "...",
    "approved": false
  }
  ```

## Other commands

```bash
node scripts/forge.js list-pending            # all pending creatives (JSON)
node scripts/forge.js delete <creative_id>    # remove one
```

## Behavior rules

- Default model is `nano-banana-2`. Only switch when the user explicitly asks for text-baked creatives.
- Always produce at least 2 prompts per batch — never just 1.
- If one variant fails at render time, the script logs and continues — don't abort the whole batch.
- `approved` starts `false`. Future work will add an approval UI; for now, "approval" happens when the user downloads + uploads to Meta Ads Manager themselves.
- Never auto-publish to Meta — FORGE ends at `ads/pending/`.
- Temp prompt files live at `state/tmp/forge-prompts-*.json`. Leave them for debugging; don't auto-delete.

## Cost transparency

Tell the user the cost up front. At defaults (4 variants, 1024², nano-banana-2): **~$0.32 per brief**. With `gpt-image-2`: **~$0.88 per brief**. 10 briefs/day at the default is ~$100/month.

## Transient API errors are auto-retried

fal.ai occasionally returns 5xx (cluster transient) or 429 (rate limit). The script auto-retries those up to 3 times with exponential backoff, scoped per call (storage upload AND model subscribe each get their own retry loop). Per-variant isolation means a fully-failed upload or model call only kills that one variant — the others in the batch still render and get saved. **Don't surface fal.ai 5xx to the user as a hard failure** — if you see one in `state/activity.jsonl`, that's a logged retry, not an error the user needs to handle. Only report failures the user actually needs to act on (e.g. invalid FAL_KEY, brief not found, prompts file malformed).

## Parallel execution

The script generates all N variants in parallel (`Promise.all` over the prompts array). On nano-banana-2 (~10s/image) the speedup is mild — sequential vs parallel both finish in well under a minute. On gpt-image-2 (~60s/image at high quality) the speedup is dramatic — 4 minutes sequential becomes ~60s parallel. Output ordering is preserved: `outputs[i]` always corresponds to `prompts[i]`.

Reference image uploads to fal.storage are deduped — if multiple prompts in a batch reference the same local file, only one upload happens and the others await the same Promise. So passing the same pattern image across all 4 prompts only triggers 1 upload.

**Don't tell the user FORGE is "running sequentially" or "rendering one at a time"** — that's outdated. It runs concurrently.

## Handoff

Creatives land in `ads/pending/`. The dashboard's Creatives tab reads them via `/api/creatives` and displays thumbnails with the hook, model, and prompt used. The user reviews, downloads the ones they like, and uploads to Meta Ads Manager themselves (V1 policy: manual upload — no Meta API writes means no ban-wave risk).

## Self-invocation & pipeline chaining

This skill is callable two ways:
- **User-invoked:** `/forge` typed in chat, or invoked via the dashboard's amplify/rewrite buttons (which call LOOPER which calls this).
- **Self-invoked:** Claude invokes via the Skill tool, OR (more commonly) writes prompts via the Write tool and runs `node scripts/forge.js generate <brief_id> --prompts-file <path>` directly. LOOPER's amplify and rewrite commands self-invoke this skill internally — that's already wired.

**Natural next step:** manual upload to Meta Ads Manager. (No further skill chains automatically — V1 requires the user to be in the loop before money goes to Meta.)

**Auto-chain rules:**
- Always confirm cost before running. Default 4 variants × $0.08 = ~$0.32. Even in pipeline mode, never spend without an explicit "go" from the user.
- After completing, surface the output in the dashboard's Creatives tab and tell the user where to find it. Don't auto-anything — uploading to Meta is a deliberate, conscious step.
- LOOPER's `amplify` and `rewrite` already self-invoke this skill internally with the right flags; that's the only fully-automated FORGE path in V1.
