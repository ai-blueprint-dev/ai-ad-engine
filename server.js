/**
 * AI Ad Engine — local server
 * Powered by AI Blueprint
 *
 * Serves dashboard.html + exposes a small local API that the dashboard
 * reads to show credential status. All writes go through the CONFIG
 * skill in Claude Code, not through this server.
 *
 * Everything is localhost-only. No external traffic.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const meta = require('./lib/meta');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const SCRIPT_CONFIG     = path.join(ROOT, 'scripts', 'config.js');
const SCRIPT_SCRAPER    = path.join(ROOT, 'scripts', 'scraper.js');
const SCRIPT_RESEARCHER = path.join(ROOT, 'scripts', 'researcher.js');
const SCRIPT_FORGE      = path.join(ROOT, 'scripts', 'forge.js');
const SCRIPT_LOOPER     = path.join(ROOT, 'scripts', 'looper.js');

const STATE_DIR    = path.join(ROOT, 'state');
const BRIEFS_DIR   = path.join(STATE_DIR, 'briefs');
const RESEARCH_FILE = path.join(STATE_DIR, 'research.json');
const RESEARCH_IMAGES_DIR = path.join(STATE_DIR, 'research', 'images');
const PATTERNS_FILE = path.join(STATE_DIR, 'winning_patterns.json');
const LOSERS_FILE = path.join(STATE_DIR, 'losing_patterns.json');
const ACTIVITY_LOG = path.join(STATE_DIR, 'activity.jsonl');
const PENDING_DIR  = path.join(ROOT, 'ads', 'pending');

const CACHE_TTL_MS = 5 * 60 * 1000;

function runScript(scriptPath, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile('node', [scriptPath, ...args], { cwd: ROOT, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: stderr?.trim() || err.message, stdout, stderr });
        return;
      }
      resolve({ ok: true, stdout, stderr });
    });
  });
}

function safeParseJson(s, fallback = null) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ============ in-memory cache ============
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) { cache.delete(key); return null; }
  return hit;
}
function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  cache.set(key, { value, expires: Date.now() + ttl, stored: Date.now() });
}

const app = express();

// ============ SAFETY: localhost only ============
app.use((req, res, next) => {
  const ip = (req.ip || req.socket.remoteAddress || '').replace('::ffff:', '');
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== 'localhost') {
    return res.status(403).json({ error: 'Forbidden: localhost only' });
  }
  next();
});

// ============ SAFETY: block sensitive paths ============
const BLOCKED = [/^\/\.env/i, /^\/node_modules(\/|$)/i, /^\/\.claude(\/|$)/i, /^\/state(\/|$)/i, /^\/ads(\/|$)/i, /^\/scripts(\/|$)/i, /^\/\.git(\/|$)/i];
app.use((req, res, next) => {
  if (BLOCKED.some(re => re.test(req.path))) {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(express.json({ limit: '512kb' }));

// ============ API ============

app.get('/api/health', (req, res) => {
  res.json({
    service: 'ai-ad-engine',
    version: '1.0.0',
    ok: true,
    ts: new Date().toISOString(),
  });
});

app.get('/api/config', (req, res) => {
  execFile('node', [SCRIPT_CONFIG, 'status'], { cwd: ROOT, timeout: 5000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: err.message, stderr: stderr?.slice(0, 400) });
    }
    try {
      res.json(JSON.parse(stdout));
    } catch (e) {
      res.status(500).json({ error: 'config.js returned non-JSON', raw: stdout.slice(0, 400) });
    }
  });
});

// ============ META ============

app.get('/api/meta/status', (req, res) => {
  const configured = meta.isConfigured();
  res.json({ configured, version: meta.META_API_VERSION });
});

app.get('/api/meta/account', async (req, res) => {
  if (!meta.isConfigured()) {
    return res.status(412).json({ mode: 'demo', reason: 'credentials missing' });
  }
  const key = 'account';
  const hit = cacheGet(key);
  if (hit) return res.json({ mode: 'live', account: hit.value, cached: true, stored_at: new Date(hit.stored).toISOString() });
  try {
    const account = await meta.getAccount();
    cacheSet(key, account);
    res.json({ mode: 'live', account, cached: false });
  } catch (e) {
    res.status(502).json({ mode: 'error', error: e.message, code: e.code, subcode: e.subcode, http: e.http });
  }
});

app.get('/api/meta/ads', async (req, res) => {
  if (!meta.isConfigured()) {
    return res.json({ mode: 'demo', ads: [], reason: 'credentials missing' });
  }
  const range = meta.RANGE_KEYS.includes(req.query.range) ? req.query.range : '7d';
  const { acct } = meta.credentials();
  const key = `ads:${acct}:${range}`;
  const hit = cacheGet(key);
  if (hit) return res.json({ mode: 'live', ads: hit.value, range, cached: true, stored_at: new Date(hit.stored).toISOString(), count: hit.value.length });
  try {
    const [ads, insights] = await Promise.all([meta.listAds(50), meta.getInsights(range)]);
    // Collect all unique image hashes used by these ads' asset_feed creatives, then batch-resolve
    // them to their high-res CDN URLs. One extra API call per ads-fetch keeps card thumbnails sharp.
    const hashes = [];
    for (const ad of ads.data || []) {
      const imgs = ad.creative?.asset_feed_spec?.images || [];
      for (const img of imgs) if (img.hash) hashes.push(img.hash);
    }
    const imageHashMap = await meta.resolveImageHashes(Array.from(new Set(hashes)));
    const merged = meta.mergeAdsData(ads, insights, imageHashMap);
    cacheSet(key, merged);
    res.json({ mode: 'live', ads: merged, range, cached: false, count: merged.length });
  } catch (e) {
    res.status(502).json({ mode: 'error', error: e.message, code: e.code, subcode: e.subcode, http: e.http });
  }
});

app.get('/api/meta/timeseries', async (req, res) => {
  if (!meta.isConfigured()) {
    return res.json({ mode: 'demo', days: [], reason: 'credentials missing' });
  }
  const range = meta.RANGE_KEYS.includes(req.query.range) ? req.query.range : '7d';
  const key = `timeseries:${range}`;
  const hit = cacheGet(key);
  if (hit) return res.json({ mode: 'live', days: hit.value, range, cached: true });
  try {
    const raw = await meta.getAccountInsightsTimeSeries(range);
    const days = (raw?.data || []).map(row => ({
      date: row.date_start,
      spend: parseFloat(row.spend || 0),
      revenue: (Array.isArray(row.purchase_roas) ? parseFloat(row.purchase_roas[0]?.value || 0) : 0) * parseFloat(row.spend || 0),
      impressions: parseInt(row.impressions || 0, 10),
      leads: meta.parseLeads(row.actions),
    }));
    cacheSet(key, days);
    res.json({ mode: 'live', days, range, cached: false });
  } catch (e) {
    res.status(502).json({ mode: 'error', error: e.message, code: e.code });
  }
});

app.get('/api/meta/creative/:ad_id', async (req, res) => {
  if (!meta.isConfigured()) return res.status(400).json({ error: 'credentials missing' });
  const adId = String(req.params.ad_id || '').replace(/[^0-9]/g, '');
  if (!adId) return res.status(400).json({ error: 'invalid ad_id' });
  // Short cache — Meta's `source` URL is signed and ephemeral, so we re-fetch frequently.
  const key = `creative:${adId}`;
  const hit = cacheGet(key);
  if (hit) return res.json({ ...hit.value, cached: true });
  try {
    const data = await meta.getPlayableCreative(adId);
    cacheSet(key, data, 60 * 1000);
    res.json({ ...data, cached: false });
  } catch (e) {
    res.status(502).json({ error: e.message, code: e.code });
  }
});

app.post('/api/cache/clear', (req, res) => {
  const count = cache.size;
  cache.clear();
  res.json({ ok: true, cleared: count });
});

// ============ ACTIVITY + PIPELINE ============

app.get('/api/activity', (req, res) => {
  try {
    if (!fs.existsSync(ACTIVITY_LOG)) {
      return res.json({ entries: [], cursor: 0 });
    }
    const cursor = Math.max(0, parseInt(req.query.cursor || '0', 10));
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const newLines = lines.slice(cursor);
    const entries = newLines.map(l => safeParseJson(l)).filter(Boolean);
    res.json({ entries, cursor: lines.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pipeline/stats', (req, res) => {
  try {
    const researchCount = fs.existsSync(RESEARCH_FILE)
      ? (safeParseJson(fs.readFileSync(RESEARCH_FILE, 'utf8'), []) || []).length
      : 0;
    const briefsCount = fs.existsSync(BRIEFS_DIR)
      ? fs.readdirSync(BRIEFS_DIR).filter(f => f.endsWith('.json')).length
      : 0;
    const pendingCount = fs.existsSync(PENDING_DIR)
      ? fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.png')).length
      : 0;
    res.json({
      research_count: researchCount,
      briefs_count: briefsCount,
      pending_count: pendingCount,
      published_count: 0, // reserved for future
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ RESEARCH ============

app.get('/api/research', (req, res) => {
  try {
    if (!fs.existsSync(RESEARCH_FILE)) return res.json({ items: [] });
    const items = safeParseJson(fs.readFileSync(RESEARCH_FILE, 'utf8'), []);
    res.json({ items: Array.isArray(items) ? items : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Note: there is no POST /api/research. Research items are added via Claude Code
// running the RESEARCHER skill, which calls `scripts/researcher.js save` directly.

app.delete('/api/research/:id', async (req, res) => {
  const r = await runScript(SCRIPT_RESEARCHER, ['delete', req.params.id]);
  if (!r.ok) return res.status(r.error?.includes('Not found') ? 404 : 502).json({ error: r.error });
  res.json(safeParseJson(r.stdout) || { ok: true });
});

// Serve a research item's screenshot. Looks up the item, finds its image_path, streams the file.
// Path is resolved relative to ROOT and constrained to RESEARCH_IMAGES_DIR to prevent traversal.
app.get('/api/research/image/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!id) return res.status(400).send('bad id');
  if (!fs.existsSync(RESEARCH_FILE)) return res.status(404).send('no library');
  const items = safeParseJson(fs.readFileSync(RESEARCH_FILE, 'utf8'), []);
  const item = (Array.isArray(items) ? items : []).find(x => x.id === id);
  if (!item || !item.image_path) return res.status(404).send('no image');
  const abs = path.resolve(ROOT, item.image_path);
  if (!abs.startsWith(RESEARCH_IMAGES_DIR)) return res.status(400).send('bad path');
  if (!fs.existsSync(abs)) return res.status(404).send('image missing on disk');
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
             : ext === '.webp' ? 'image/webp'
             : ext === '.gif'  ? 'image/gif'
             : 'image/png';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(abs).pipe(res);
});

// ============ SCRAPER ============

app.post('/api/scraper', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Need a valid http(s) URL' });
  const r = await runScript(SCRIPT_SCRAPER, ['scrape', url], { timeout: 30000 });
  if (!r.ok) return res.status(502).json({ error: r.error });
  const brief = safeParseJson(r.stdout);
  if (!brief) return res.status(502).json({ error: 'scraper returned unparseable output' });
  res.json(brief);
});

app.get('/api/scraper/list', async (req, res) => {
  const r = await runScript(SCRIPT_SCRAPER, ['list']);
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json(safeParseJson(r.stdout) || []);
});

app.get('/api/scraper/:id', async (req, res) => {
  const r = await runScript(SCRIPT_SCRAPER, ['show', req.params.id]);
  if (!r.ok) return res.status(404).json({ error: r.error });
  res.json(safeParseJson(r.stdout) || {});
});

// ============ FORGE ============

app.post('/api/forge', async (req, res) => {
  const briefId = String(req.body?.brief_id || '').trim();
  const provider = req.body?.provider === 'openai' ? 'openai' : 'fal';
  const variants = Math.max(1, Math.min(8, parseInt(req.body?.variants || 4, 10)));
  if (!briefId) return res.status(400).json({ error: 'Need brief_id' });
  const args = ['generate', briefId, '--provider', provider, '--variants', String(variants)];
  const r = await runScript(SCRIPT_FORGE, args, { timeout: 180000 });
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json(safeParseJson(r.stdout) || {});
});

// ============ LOOPER ============

app.get('/api/looper/winners', (req, res) => {
  try {
    if (!fs.existsSync(PATTERNS_FILE)) return res.json({ patterns: [] });
    const patterns = safeParseJson(fs.readFileSync(PATTERNS_FILE, 'utf8'), []);
    res.json({ patterns: Array.isArray(patterns) ? patterns : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/looper/losers', (req, res) => {
  try {
    if (!fs.existsSync(LOSERS_FILE)) return res.json({ patterns: [] });
    const patterns = safeParseJson(fs.readFileSync(LOSERS_FILE, 'utf8'), []);
    res.json({ patterns: Array.isArray(patterns) ? patterns : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/looper/analyze', async (req, res) => {
  // Trigger looper analyze. Defaults match the CLI defaults; override via query string.
  const args = ['analyze'];
  if (req.query.mode) args.push('--mode', String(req.query.mode));
  if (req.query.top) args.push('--top', String(req.query.top));
  if (req.query.range) args.push('--range', String(req.query.range));
  if (req.query['min-impressions']) args.push('--min-impressions', String(req.query['min-impressions']));
  const r = await runScript(SCRIPT_LOOPER, args, { timeout: 60000 });
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json(safeParseJson(r.stdout) || {});
});

app.get('/api/looper/playbook/:filename', (req, res) => {
  const fname = String(req.params.filename || '');
  // Lock the filename pattern: digits + underscore + base36 ts + .md. No path traversal.
  if (!/^[0-9]+_[a-z0-9]+\.md$/.test(fname)) return res.status(400).json({ error: 'invalid filename' });
  const p = path.join(STATE_DIR, 'playbooks', fname);
  if (!p.startsWith(path.join(STATE_DIR, 'playbooks'))) return res.status(400).json({ error: 'bad path' });
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(fs.readFileSync(p, 'utf8'));
});

app.post('/api/looper/amplify/:ad_id', async (req, res) => {
  const adId = String(req.params.ad_id || '').replace(/[^0-9]/g, '');
  if (!adId) return res.status(400).json({ error: 'invalid ad_id' });
  const args = ['amplify', adId];
  if (req.query.n) args.push('--n', String(req.query.n));
  if (req.query.model) args.push('--model', String(req.query.model));
  if (req.query['brief-id']) args.push('--brief-id', String(req.query['brief-id']));
  // fal.ai rendering can take a while — bump timeout to 5 min for amplify specifically.
  const r = await runScript(SCRIPT_LOOPER, args, { timeout: 5 * 60 * 1000 });
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json(safeParseJson(r.stdout) || { ok: true });
});

app.post('/api/looper/rewrite/:ad_id', async (req, res) => {
  const adId = String(req.params.ad_id || '').replace(/[^0-9]/g, '');
  if (!adId) return res.status(400).json({ error: 'invalid ad_id' });
  const args = ['rewrite', adId];
  if (req.query.n) args.push('--n', String(req.query.n));
  if (req.query.model) args.push('--model', String(req.query.model));
  if (req.query['brief-id']) args.push('--brief-id', String(req.query['brief-id']));
  const r = await runScript(SCRIPT_LOOPER, args, { timeout: 5 * 60 * 1000 });
  if (!r.ok) return res.status(502).json({ error: r.error });
  res.json(safeParseJson(r.stdout) || { ok: true });
});

// ============ CREATIVES ============

app.get('/api/creatives', (req, res) => {
  try {
    if (!fs.existsSync(PENDING_DIR)) return res.json({ items: [] });
    const metaFiles = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.meta.json'));
    const items = metaFiles.map(f => {
      const m = safeParseJson(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8'));
      if (!m) return null;
      const pngPath = path.join(PENDING_DIR, `${m.id}.png`);
      if (!fs.existsSync(pngPath)) return null;
      const stats = fs.statSync(pngPath);
      return {
        id: m.id,
        name: m.product_name || m.brief_id,
        filename: `${m.id}.png`,
        url: `/api/creatives/image/${encodeURIComponent(m.id)}.png`,
        mtime: stats.mtimeMs,
        size: stats.size,
        meta: m,
      };
    }).filter(Boolean);
    items.sort((a, b) => b.mtime - a.mtime);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/creatives/image/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[A-Za-z0-9_.-]+\.png$/.test(name)) return res.status(400).send('Bad name');
  const p = path.join(PENDING_DIR, name);
  if (!p.startsWith(PENDING_DIR)) return res.status(400).send('Bad path');
  if (!fs.existsSync(p)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=60');
  fs.createReadStream(p).pipe(res);
});

app.delete('/api/creatives/:id', (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'Bad id' });
  const png = path.join(PENDING_DIR, `${id}.png`);
  const metaF = path.join(PENDING_DIR, `${id}.meta.json`);
  let removed = 0;
  try {
    if (fs.existsSync(png))   { fs.unlinkSync(png); removed++; }
    if (fs.existsSync(metaF)) { fs.unlinkSync(metaF); removed++; }
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ STATIC ============

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(ROOT, 'dashboard.html'));
});

app.use(express.static(ROOT, { index: false, dotfiles: 'deny' }));

app.use((req, res) => res.status(404).send('Not found'));

// ============ START ============

app.listen(PORT, '127.0.0.1', () => {
  const line = '─'.repeat(44);
  process.stdout.write(`\n  ${line}\n`);
  process.stdout.write(`  AI AD ENGINE  ·  Powered by AI Blueprint\n`);
  process.stdout.write(`  ${line}\n`);
  process.stdout.write(`  Dashboard   http://localhost:${PORT}\n`);
  process.stdout.write(`  API health  http://localhost:${PORT}/api/health\n`);
  process.stdout.write(`  Config      run \`/config\` in Claude Code\n`);
  process.stdout.write(`  Stop        Ctrl+C\n`);
  process.stdout.write(`  ${line}\n\n`);
});
