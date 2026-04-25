#!/usr/bin/env node
/**
 * FORGE — image ad creative renderer (V1: image-only, no video)
 *
 * Routes all image generation through fal.ai. Supports two models:
 *   - nano-banana-2  — default. $0.08 @ 1024². Fast, photorealistic, up to 14 ref images.
 *   - gpt-image-2    — $0.22 @ 1024² high. 99% text rendering accuracy. Switch for text-heavy ads.
 *
 * Claude Code writes the image prompts in its own context (using the FORGE
 * skill) and passes them to this script via --prompts-file. No LLM API key
 * needed by this script — Claude Code is the intelligence layer.
 *
 * Usage:
 *   node scripts/forge.js generate <brief_id> --prompts-file <path> [--model nano-banana-2|gpt-image-2]
 *   node scripts/forge.js list-pending
 *   node scripts/forge.js delete <creative_id>
 *
 * Prompts file format:
 *   [
 *     { "hook": "short label", "prompt": "detailed image prompt, photorealistic, no text" },
 *     { "hook": "...",         "prompt": "..." }
 *   ]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRIEFS_DIR = path.join(ROOT, 'state', 'briefs');
const PENDING_DIR = path.join(ROOT, 'ads', 'pending');
const ENV_PATH = path.join(ROOT, '.env');
const ACTIVITY_LOG = path.join(ROOT, 'state', 'activity.jsonl');

// Both models hosted by fal.ai — one SDK, one API key.
// Each model has TWO endpoints:
//   - text-to-image (no refs): generate from prompt only
//   - /edit (with refs): generate using image_urls as visual style references (up to 14)
// The text-only endpoint silently ignores image_urls — we MUST switch endpoints when refs exist.
//
// Reference images can be:
//   - Public URLs (Meta CDN, etc.) — passed through directly
//   - Local paths (e.g. saved RESEARCHER patterns at state/research/images/) — auto-uploaded to
//     fal.storage by resolveRefs() before the call. Cached within a single run so the same image
//     isn't uploaded multiple times when shared across prompts.
const MODELS = {
  'nano-banana-2': {
    endpoint: 'fal-ai/nano-banana-2',
    edit_endpoint: 'fal-ai/nano-banana-2/edit',
    buildInput: (prompt, refs) => {
      const input = {
        prompt,
        aspect_ratio: '1:1',
        resolution: '1K',
        num_images: 1,
      };
      if (refs && refs.length) {
        input.image_urls = refs.slice(0, 14);
        input.output_format = 'png';
      }
      return input;
    },
    cost_note: '$0.08 per 1024² image',
  },
  'gpt-image-2': {
    endpoint: 'fal-ai/gpt-image-2',
    edit_endpoint: 'openai/gpt-image-2/edit',
    buildInput: (prompt, refs) => {
      if (refs && refs.length) {
        // edit endpoint shape — let fal infer image_size from inputs
        return {
          prompt,
          image_urls: refs.slice(0, 14),
          quality: 'high',
          num_images: 1,
        };
      }
      return {
        prompt,
        image_size: 'square_hd',   // 1024x1024
        quality: 'high',
        num_images: 1,
        output_format: 'png',
      };
    },
    cost_note: '$0.22 per 1024² high-quality image',
  },
};
const DEFAULT_MODEL = 'nano-banana-2';

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function logActivity(msg) {
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_LOG), { recursive: true });
    fs.appendFileSync(ACTIVITY_LOG, JSON.stringify({ ts: new Date().toISOString(), agent: 'FORGE', msg }) + '\n');
  } catch {}
}

function loadBrief(briefId) {
  const p = path.join(BRIEFS_DIR, `${briefId}.json`);
  if (!fs.existsSync(p)) throw new Error(`Brief not found: ${briefId}. Run SCRAPER first.`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadPromptsFromFile(filePath) {
  if (!filePath) throw new Error('Need --prompts-file <path> (Claude Code writes the prompts first)');
  const abs = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  if (!fs.existsSync(abs)) throw new Error(`Prompts file not found: ${filePath}`);
  const raw = fs.readFileSync(abs, 'utf8');
  let arr;
  try { arr = JSON.parse(raw); } catch { throw new Error('Prompts file is not valid JSON'); }
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('Prompts file must contain a non-empty JSON array');
  const clean = arr.map((p, i) => ({
    hook: String(p.hook || `variant_${i + 1}`).slice(0, 80),
    prompt: String(p.prompt || '').trim(),
    // reference_images: optional URLs passed through to fal.ai as visual style references.
    // Set by LOOPER amplify (or any future skill that wants to seed variants from a known good).
    reference_images: Array.isArray(p.reference_images) ? p.reference_images.filter(u => typeof u === 'string') : [],
    // amplifies + amplify_pattern_*: provenance, written into the .meta.json sidecar so the
    // dashboard's Creatives tab can group variants under the source winner.
    amplifies: p.amplifies || null,
    amplify_pattern_hook: p.amplify_pattern_hook || null,
    amplify_pattern_addendum: p.amplify_pattern_addendum || null,
  })).filter(p => p.prompt.length > 0);
  if (clean.length === 0) throw new Error('No valid prompts in file (each needs a non-empty `prompt` string)');
  return clean;
}

// Retry wrapper for fal calls. fal.ai occasionally returns 5xx (transient cluster issues, queue
// failures) or hits rate limits with 429. Exponential backoff with jitter handles these without
// killing the run. Permanent errors (4xx other than 429) bubble up immediately.
async function retryable(fn, opts = {}) {
  const { tries = 3, baseDelayMs = 1500, label = 'call' } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const status = e?.status || (msg.match(/HTTP (\d{3})/) || [])[1];
      const isTransient = !status || status === '429' || (status >= '500' && status <= '599');
      if (!isTransient || attempt === tries) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
      logActivity(`${label} attempt ${attempt}/${tries} failed (${msg.slice(0, 80)}) — retrying in ${Math.round(delay/100)/10}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Resolve a mixed list of refs (URLs + local paths) to all-URLs by uploading local files to
// fal.storage. Cache stores Promise<url> (not url) so concurrent variants requesting the same
// image join the in-flight upload instead of triggering N parallel uploads of the same file.
async function resolveRefs(fal, refs, uploadCache) {
  if (!refs || !refs.length) return [];
  const out = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref) continue;
    if (/^https?:\/\//i.test(ref) || ref.startsWith('data:')) {
      out.push(ref);
      continue;
    }
    if (uploadCache.has(ref)) { out.push(await uploadCache.get(ref)); continue; }
    const absPath = path.isAbsolute(ref) ? ref : path.join(ROOT, ref);
    if (!fs.existsSync(absPath)) {
      logActivity(`warn: reference image not found, skipping: ${ref}`);
      continue;
    }
    const buffer = fs.readFileSync(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                 ext === '.webp' ? 'image/webp' :
                 ext === '.gif'  ? 'image/gif'  : 'image/png';
    // Node 20+ has the global File constructor (web standard). fal.storage.upload accepts it.
    const file = new File([buffer], path.basename(absPath), { type: mime });
    // Store the Promise immediately so other concurrent callers find it and await the same upload.
    const uploadPromise = retryable(() => fal.storage.upload(file), { label: `upload ${path.basename(ref)}` })
      .then(url => { logActivity(`Uploaded reference to fal.storage: ${path.basename(ref)}`); return url; });
    uploadCache.set(ref, uploadPromise);
    out.push(await uploadPromise);
  }
  return out;
}

async function generate(prompts, brief, modelName) {
  const env = readEnv();
  if (!env.FAL_KEY) throw new Error('FAL_KEY not set. Run `/config` in Claude Code to set it.');
  const modelDef = MODELS[modelName];
  if (!modelDef) throw new Error(`Unknown model: ${modelName}. Valid: ${Object.keys(MODELS).join(', ')}`);

  const { fal } = require('@fal-ai/client');
  fal.config({ credentials: env.FAL_KEY });

  const uploadCache = new Map(); // local path → Promise<fal.storage URL>, scoped to this run

  // Parallel execution: each variant runs concurrently. fal.ai's queue handles N simultaneous
  // requests fine. With nano-banana-2 (~10s/image) the speedup is mild; with gpt-image-2
  // (~60s/image) the speedup is dramatic — 4 minutes sequential becomes ~60s. Promise.all
  // preserves order so outputs[i] always corresponds to prompts[i].
  // Use a shared timestamp baseline so concurrent saves don't collide on Date.now() ordering.
  const tsBase = Date.now().toString(36);
  fs.mkdirSync(PENDING_DIR, { recursive: true });

  logActivity(`Rendering ${prompts.length} variants via ${modelName} in parallel`);

  const outputs = await Promise.all(prompts.map(async (p, i) => {
    const { hook, prompt, reference_images, amplifies, amplify_pattern_hook, amplify_pattern_addendum } = p;

    try {
      // Resolve any local paths to fal.storage URLs. URLs pass through unchanged. Inside the
      // try so a failed upload only kills this one variant, not the whole batch.
      const resolvedRefs = await resolveRefs(fal, reference_images, uploadCache);
      const useEdit = resolvedRefs.length > 0;
      const endpoint = useEdit ? modelDef.edit_endpoint : modelDef.endpoint;

      const refNote = resolvedRefs.length ? ` (ref×${resolvedRefs.length}, ${useEdit ? 'edit endpoint' : 'text endpoint'})` : '';
      logActivity(`Variant ${i + 1}/${prompts.length} dispatched${refNote}${amplifies ? ` — amplifying ${amplifies}` : ''}`);

      const result = await retryable(
        () => fal.subscribe(endpoint, { input: modelDef.buildInput(prompt, resolvedRefs) }),
        { label: `variant ${i + 1} (${modelName})` }
      );
      const imgUrl = result?.data?.images?.[0]?.url || result?.images?.[0]?.url;
      if (!imgUrl) throw new Error(`fal.ai response from ${modelName} contained no image URL`);
      const buf = Buffer.from(await (await fetch(imgUrl)).arrayBuffer());
      const id = `${brief.id}_${tsBase}_${i}`;
      fs.writeFileSync(path.join(PENDING_DIR, `${id}.png`), buf);
      fs.writeFileSync(path.join(PENDING_DIR, `${id}.meta.json`), JSON.stringify({
        id,
        brief_id: brief.id,
        product_name: brief.product_name,
        hook_used: hook,
        prompt,
        model: modelName,
        provider: `fal:${modelDef.endpoint}`,
        aspect_ratio: '1:1',
        created_at: new Date().toISOString(),
        source_url: brief.source_url,
        fal_request_id: result?.requestId || null,
        approved: false,
        // LOOPER provenance: when set, this creative was generated as a variant of a winning ad.
        amplifies: amplifies || null,
        amplify_pattern_hook: amplify_pattern_hook || null,
        amplify_pattern_addendum: amplify_pattern_addendum || null,
        reference_images: reference_images || [],
      }, null, 2));
      logActivity(`Variant ${i + 1}/${prompts.length} saved as ${id}.png`);
      return { id, image: `${id}.png`, hook };
    } catch (e) {
      logActivity(`Variant ${i + 1} failed: ${e.message}`);
      return { error: e.message, hook };
    }
  }));
  return outputs;
}

async function cmdGenerate(briefId, flags) {
  if (!briefId) throw new Error('Need <brief_id>. Run SCRAPER first to produce one.');
  const brief = loadBrief(briefId);
  const prompts = loadPromptsFromFile(flags['prompts-file']);
  const modelName = String(flags.model || DEFAULT_MODEL).toLowerCase();

  logActivity(`Rendering ${prompts.length} variants for ${brief.product_name} via ${modelName} (${MODELS[modelName]?.cost_note || '?'})`);

  const outputs = await generate(prompts, brief, modelName);

  const ok = outputs.filter(o => !o.error).length;
  logActivity(`Rendering complete — ${ok}/${outputs.length} saved to ads/pending/`);
  process.stdout.write(JSON.stringify({
    brief_id: brief.id,
    product_name: brief.product_name,
    model: modelName,
    rendered: ok,
    requested: outputs.length,
    outputs,
  }, null, 2) + '\n');
  process.exit(ok === 0 ? 1 : 0);
}

function cmdListPending() {
  if (!fs.existsSync(PENDING_DIR)) { process.stdout.write('[]\n'); return; }
  const files = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.meta.json'));
  const items = files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
  items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  process.stdout.write(JSON.stringify(items, null, 2) + '\n');
}

function cmdDeletePending(id) {
  if (!id) { process.stderr.write('Usage: forge.js delete <creative_id>\n'); process.exit(2); }
  const png = path.join(PENDING_DIR, `${id}.png`);
  const meta = path.join(PENDING_DIR, `${id}.meta.json`);
  let removed = 0;
  try {
    if (fs.existsSync(png))  { fs.unlinkSync(png); removed++; }
    if (fs.existsSync(meta)) { fs.unlinkSync(meta); removed++; }
    if (!removed) { process.stderr.write(`Not found: ${id}\n`); process.exit(1); }
    process.stdout.write(JSON.stringify({ ok: true, deleted: id }) + '\n');
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else { flags[key] = true; }
    }
  }
  return flags;
}

function cmdHelp() {
  process.stdout.write(`FORGE — image ad creative renderer (image-only, single fal.ai backend)

  Usage:
    node scripts/forge.js generate <brief_id> --prompts-file <path> [--model nano-banana-2|gpt-image-2]
    node scripts/forge.js list-pending
    node scripts/forge.js delete <creative_id>

  Models (both served by fal.ai — one FAL_KEY unlocks both):
    nano-banana-2   — default · $0.08/image · fastest · best photorealism
    gpt-image-2     — $0.22/image high · best text rendering · use when creative needs text

  Claude Code writes the image prompts using the FORGE skill, then invokes this
  script with --prompts-file. This script never calls an LLM — it only renders
  images and saves them to ads/pending/ with .meta.json sidecars.

  Prompts file format:
    [{ "hook": "short label", "prompt": "detailed image prompt" }, ...]
`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'generate': {
        const [first, ...rest] = args;
        await cmdGenerate(first, parseFlags(rest));
        break;
      }
      case 'list-pending': cmdListPending(); break;
      case 'delete':       cmdDeletePending(args[0]); break;
      case 'help':
      case '--help':
      case '-h':
      case undefined:      cmdHelp(); break;
      default:
        process.stderr.write(`Unknown command: ${cmd}\n`);
        cmdHelp();
        process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

main();
