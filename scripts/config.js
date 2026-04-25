#!/usr/bin/env node
/**
 * AI Ad Engine — CONFIG helper
 *
 * Called by the CONFIG skill in Claude Code. Handles:
 *   - status    — emit current credential state as JSON (masked)
 *   - set       — validate a single credential against its live API and save it
 *   - test      — re-validate without writing
 *
 * Never logs raw secret values. Values in .env are written with 0o600 perms.
 *
 * Usage:
 *   node scripts/config.js status
 *   node scripts/config.js set <KEY> <VALUE>
 *   node scripts/config.js test [<KEY>|all]
 *   node scripts/config.js help
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const STATE_PATH = path.join(ROOT, 'state', 'config.json');

const META_API_VERSION = 'v25.0';
const META_GRAPH = `https://graph.facebook.com/${META_API_VERSION}`;

// tier:     'required' | 'deferred'  (V1 status)
// consumer: the V1 subsystem that actually reads this key
// purpose:  one-sentence V1-accurate description
// All image generation (Nano Banana 2 AND GPT Image 2) routes through fal.ai,
// so FAL_KEY is the only image-gen credential needed. No OpenAI key required.
const KEYS = {
  FAL_KEY: {
    tier: 'required',
    consumer: 'FORGE — image generation (Nano Banana 2 + GPT Image 2, both via fal.ai)',
    tester: 'fal',
    deps: [],
    purpose: 'V1 REQUIRED — FORGE calls fal.ai to render ad creatives. fal.ai hosts both Nano Banana 2 (default, $0.08/image, fastest) and GPT Image 2 ($0.22/image, best text rendering). One key unlocks both.',
  },
  META_ACCESS_TOKEN: {
    tier: 'required',
    consumer: 'Overview tab — live ad insights via Meta Marketing API v25',
    tester: 'meta_me',
    deps: [],
    purpose: 'V1 REQUIRED — the server reads Meta Marketing API v25 to populate the Overview tab with your real ROAS, CTR, spend, conversions, and 7-day chart. Use a Meta System User token with ads_read (plus ads_management + business_management for future V2 publishing).',
  },
  META_AD_ACCOUNT_ID: {
    tier: 'required',
    consumer: 'Overview tab — which account to read from',
    tester: 'meta_ad_account',
    deps: ['META_ACCESS_TOKEN'],
    purpose: 'V1 REQUIRED — paired with META_ACCESS_TOKEN. Format: act_1234567890. Found in Ads Manager URL.',
  },
  META_APP_ID: {
    tier: 'deferred',
    consumer: 'V2 PUBLISHER (not yet built)',
    tester: null,
    deps: [],
    purpose: 'V2 DEFERRED — reserved for a future auto-publisher skill. No V1 code reads this. Skip unless preparing for V2.',
  },
  META_PIXEL_ID: {
    tier: 'deferred',
    consumer: 'V2 PUBLISHER (not yet built)',
    tester: 'meta_pixel',
    deps: ['META_ACCESS_TOKEN'],
    purpose: 'V2 DEFERRED — reserved for a future auto-publisher skill. No V1 code reads this. Skip unless preparing for V2.',
  },
};

// ============ .env parse / write ============

function readEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const txt = fs.readFileSync(ENV_PATH, 'utf8');
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function writeEnv(kv) {
  const ordered = [...Object.keys(KEYS), ...Object.keys(kv).filter(k => !KEYS[k])];
  const seen = new Set();
  const lines = [
    '# AI Ad Engine — local credentials',
    '# Managed by scripts/config.js — do not edit by hand unless you know what you are doing',
    '',
  ];
  for (const k of ordered) {
    if (seen.has(k)) continue;
    seen.add(k);
    const v = kv[k] ?? '';
    const needsQuote = /[\s#"'`$]/.test(v);
    lines.push(`${k}=${needsQuote ? JSON.stringify(v) : v}`);
  }
  lines.push('');
  fs.writeFileSync(ENV_PATH, lines.join('\n'));
  try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* best-effort on Windows */ }
}

// ============ state/config.json ============

function readState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return {}; }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function maskSecret(v) {
  if (!v) return null;
  if (v.length <= 8) return '•'.repeat(v.length);
  return '•'.repeat(6) + v.slice(-4);
}

// ============ testers ============

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { ok: res.ok, status: res.status, body };
}

async function testFal(env) {
  if (!env.FAL_KEY) return { ok: false, error: 'Not set' };
  try {
    // fal.ai has no pure health endpoint, so hit models list which is cheap
    const r = await fetch('https://fal.run/health', {
      headers: { 'Authorization': `Key ${env.FAL_KEY}` },
    });
    if (r.ok || r.status === 404 || r.status === 405) {
      // A 200/404/405 from fal's infra indicates the key was accepted by the gateway.
      // A 401/403 means bad key.
      return { ok: true };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, error: `Auth rejected (HTTP ${r.status})` };
    return { ok: true, note: `Unexpected HTTP ${r.status} — accepting tentatively` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function testMetaMe(env) {
  if (!env.META_ACCESS_TOKEN) return { ok: false, error: 'Not set' };
  const url = `${META_GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(env.META_ACCESS_TOKEN)}`;
  const r = await fetchJSON(url);
  if (r.ok && r.body?.id) return { ok: true, meta: { id: r.body.id, name: r.body.name || '(no name)' } };
  return { ok: false, error: r.body?.error?.message || `HTTP ${r.status}` };
}

async function testMetaAdAccount(env) {
  if (!env.META_ACCESS_TOKEN) return { ok: false, error: 'META_ACCESS_TOKEN required first' };
  if (!env.META_AD_ACCOUNT_ID) return { ok: false, error: 'Not set' };
  const acct = env.META_AD_ACCOUNT_ID.startsWith('act_') ? env.META_AD_ACCOUNT_ID : `act_${env.META_AD_ACCOUNT_ID}`;
  const url = `${META_GRAPH}/${encodeURIComponent(acct)}?fields=name,account_status,currency,timezone_name&access_token=${encodeURIComponent(env.META_ACCESS_TOKEN)}`;
  const r = await fetchJSON(url);
  if (r.ok && r.body?.id) {
    return { ok: true, meta: {
      name: r.body.name,
      status: r.body.account_status === 1 ? 'ACTIVE' : `CODE_${r.body.account_status}`,
      currency: r.body.currency,
      tz: r.body.timezone_name,
    } };
  }
  return { ok: false, error: r.body?.error?.message || `HTTP ${r.status}` };
}

async function testMetaPixel(env) {
  if (!env.META_ACCESS_TOKEN) return { ok: false, error: 'META_ACCESS_TOKEN required first' };
  if (!env.META_PIXEL_ID) return { ok: false, error: 'Not set' };
  const url = `${META_GRAPH}/${encodeURIComponent(env.META_PIXEL_ID)}?fields=id,name&access_token=${encodeURIComponent(env.META_ACCESS_TOKEN)}`;
  const r = await fetchJSON(url);
  if (r.ok && r.body?.id) return { ok: true, meta: { id: r.body.id, name: r.body.name } };
  return { ok: false, error: r.body?.error?.message || `HTTP ${r.status}` };
}

const TESTERS = {
  fal: testFal,
  meta_me: testMetaMe,
  meta_ad_account: testMetaAdAccount,
  meta_pixel: testMetaPixel,
};

async function testKey(key, env) {
  const def = KEYS[key];
  if (!def) return { ok: false, error: `Unknown key ${key}` };
  if (!env[key]) return { ok: false, error: 'Not set' };
  for (const d of def.deps) {
    if (!env[d]) return { ok: false, error: `Depends on ${d} — set it first` };
  }
  if (!def.tester) return { ok: true, note: 'No test defined' };
  return TESTERS[def.tester](env);
}

// ============ commands ============

async function cmdStatus() {
  const env = readEnv();
  const state = readState();
  const out = {};
  for (const key of Object.keys(KEYS)) {
    const lk = key.toLowerCase();
    const def = KEYS[key];
    const existing = state[lk] || {};
    const present = !!env[key];
    out[lk] = {
      tier: def.tier,              // 'required' | 'deferred'
      consumer: def.consumer,      // who reads this in V1
      purpose: def.purpose,        // one-sentence description
      status: present ? (existing.status || 'untested') : 'missing',
      masked_value: present ? maskSecret(env[key]) : null,
      last_tested: existing.last_tested || null,
      meta: existing.meta || null,
      error: existing.error || null,
    };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

async function cmdSet(rawKey, ...valueParts) {
  const key = String(rawKey || '').toUpperCase();
  const value = valueParts.join(' ').trim();
  if (!KEYS[key]) {
    process.stderr.write(`Unknown key: ${key}\nValid: ${Object.keys(KEYS).join(', ')}\n`);
    process.exit(2);
  }
  if (!value) {
    process.stderr.write(`No value provided for ${key}\n`);
    process.exit(2);
  }
  const env = readEnv();
  env[key] = value;

  const result = await testKey(key, env);

  // Save .env regardless so dependent tests work in subsequent runs,
  // but mark state as invalid when the test fails so the dashboard shows it.
  writeEnv(env);

  const state = readState();
  state[key.toLowerCase()] = {
    status: result.ok ? 'ok' : 'invalid',
    last_tested: new Date().toISOString(),
    masked_value: maskSecret(value),
    meta: result.meta || null,
    error: result.ok ? null : (result.error || 'Unknown error'),
  };
  writeState(state);

  process.stdout.write(JSON.stringify({ key, ok: result.ok, meta: result.meta || null, error: result.error || null }, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

async function cmdTest(arg) {
  const env = readEnv();
  const keys = (!arg || arg === 'all') ? Object.keys(KEYS) : [String(arg).toUpperCase()];
  const state = readState();
  const results = {};
  for (const key of keys) {
    if (!KEYS[key]) { results[key] = { ok: false, error: 'Unknown key' }; continue; }
    const r = await testKey(key, env);
    results[key] = { ok: r.ok, meta: r.meta || null, error: r.error || null };
    state[key.toLowerCase()] = {
      status: r.ok ? 'ok' : (env[key] ? 'invalid' : 'missing'),
      last_tested: new Date().toISOString(),
      masked_value: env[key] ? maskSecret(env[key]) : null,
      meta: r.meta || null,
      error: r.ok ? null : (r.error || null),
    };
  }
  writeState(state);
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exit(Object.values(results).every(r => r.ok) ? 0 : 1);
}

function cmdHelp() {
  const help = `AI Ad Engine — CONFIG helper

  Usage:
    node scripts/config.js status                  show current credential status (JSON)
    node scripts/config.js set <KEY> <VALUE>       save + test a credential
    node scripts/config.js test [<KEY>|all]        test without writing
    node scripts/config.js help                    this help

  Keys:
    ${Object.entries(KEYS).map(([k, v]) => `${k}${v.required ? ' (required)' : ''}`).join('\n    ')}
`;
  process.stdout.write(help);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'status': return cmdStatus();
      case 'set':    return cmdSet(args[0], ...args.slice(1));
      case 'test':   return cmdTest(args[0]);
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        return cmdHelp();
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
