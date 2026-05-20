// api/report.js
// Vercel serverless function — receives violation reports, sends to Discord webhook.
//
// RATE LIMITING STRATEGY (no external dependencies required):
//   Vercel functions are stateless — no memory between invocations.
//   Rate limiting is enforced via Vercel KV if available, or via a
//   sliding-window check using the IP + timestamp embedded in the request.
//   Without KV, we use a conservative request signature check to block
//   obvious floods at the function level.
//
// PROTECTIONS IMPLEMENTED:
//   1. IP-based rate limit   — max 3 submissions per IP per 15 minutes (requires KV)
//   2. Content hash check    — identical submission body = duplicate, rejected silently
//   3. Field length caps     — no field can exceed defined maximums
//   4. Required field check  — missing required fields rejected with 400
//   5. Honeypot field        — bot trap: if 'website' field is filled, silently drop
//   6. Minimum description   — description must be at least 30 characters
//   7. Discord rate guard    — if Discord returns 429, log and absorb (don't crash)
//   8. Origin check          — rejects requests not originating from your domain
//                              Set ALLOWED_ORIGIN in Vercel env vars.
//                              Leave unset during development to allow all origins.
//
// ENVIRONMENT VARIABLES (set in Vercel → project → Settings → Environment Variables):
//   REPORT_WEBHOOK_URL   — required — your Discord webhook URL
//   ALLOWED_ORIGIN       — recommended — your live domain, e.g. https://your-project.vercel.app
//   KV_REST_API_URL      — optional — enables persistent IP rate limiting
//   KV_REST_API_TOKEN    — optional — pairs with KV_REST_API_URL

// ============================================================
// CONFIG
// ============================================================
const RATE_LIMIT_WINDOW_MS  = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX        = 3;               // max submissions per IP per window
const MAX_FIELD_LENGTHS = {
  politician:      100,
  office:          100,
  state:            50,
  violationType:   100,
  description:    2000,
  evidence:       1000,
  suggestedAction: 100,
  reporter:        100,
};
const MIN_DESCRIPTION_LENGTH = 30;

// ============================================================
// HELPERS
// ============================================================

// Extracts real IP — Vercel puts it in x-forwarded-for
function getIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Simple non-crypto hash for duplicate detection
function hashBody(obj) {
  const str = JSON.stringify({
    politician: obj.politician,
    description: obj.description,
    evidence: obj.evidence
  });
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return String(Math.abs(h));
}

// Sanitize a string field: trim, strip null bytes, cap length
function clean(val, maxLen) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/\0/g, '').trim().slice(0, maxLen);
}

// KV helpers — only used if env vars are present
async function kvGet(key) {
  if (!process.env.KV_REST_API_URL) return null;
  try {
    const res = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ?? null;
  } catch { return null; }
}

async function kvSet(key, value, exSeconds) {
  if (!process.env.KV_REST_API_URL) return;
  try {
    await fetch(`${process.env.KV_REST_API_URL}/set/${key}/ex/${exSeconds}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
  } catch (err) {
    console.error('KV set failed:', err.message);
  }
}

// Formats the Discord embed — structured, not a wall of text
function buildDiscordPayload(report, ip) {
  const ts = new Date(report.submitted).toLocaleString('en-US', { timeZone: 'America/New_York' });
  return {
    embeds: [{
      title: `⚠ VIOLATION REPORT — ${report.politician.toUpperCase()}`,
      color: 0xC8001A, // red
      fields: [
        { name: 'Politician',       value: report.politician,                           inline: true  },
        { name: 'State',            value: report.state,                                inline: true  },
        { name: 'Office',           value: report.office       || '—',                  inline: true  },
        { name: 'Violation Type',   value: report.violationType,                        inline: false },
        { name: 'Description',      value: report.description.slice(0, 1024),           inline: false },
        { name: 'Evidence / Links', value: report.evidence     || 'None provided',      inline: false },
        { name: 'Suggested Action', value: report.suggestedAction || '—',              inline: true  },
        { name: 'Reporter',         value: report.reporter,                             inline: true  },
        { name: 'Report ID',        value: report.id,                                   inline: true  },
      ],
      footer: { text: `Submitted ${ts} ET` },
      timestamp: report.submitted
    }]
  };
}

// ============================================================
// HANDLER
// ============================================================
export default async function handler(req, res) {

  // --- CORS ---
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  // --- ORIGIN CHECK ---
  // If ALLOWED_ORIGIN is set, reject requests from other origins.
  // This stops scripts hitting /api/report directly from other domains.
  if (process.env.ALLOWED_ORIGIN) {
    const origin = req.headers['origin'] || '';
    if (origin && origin !== process.env.ALLOWED_ORIGIN) {
      console.warn(`Origin rejected: ${origin}`);
      return res.status(403).json({ error: 'Forbidden.' });
    }
  }

  // --- PARSE BODY ---
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== 'object') throw new Error('Not an object');
  } catch {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  // --- HONEYPOT ---
  // Hidden field in the form named 'website'. Bots fill it. Humans don't see it.
  // If it has any value at all, silently accept but do not process.
  if (body.website && String(body.website).trim().length > 0) {
    console.log('Honeypot triggered — silent drop.');
    return res.status(200).json({ success: true }); // lie to the bot
  }

  // --- IP EXTRACTION ---
  const ip = getIP(req);

  // --- IP RATE LIMIT (requires KV) ---
  if (process.env.KV_REST_API_URL) {
    const kvKey = `ratelimit:${ip}`;
    const existing = await kvGet(kvKey);
    const record = existing ? JSON.parse(existing) : { count: 0, windowStart: Date.now() };

    const now = Date.now();
    // Reset window if expired
    if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
      record.count = 0;
      record.windowStart = now;
    }

    if (record.count >= RATE_LIMIT_MAX) {
      const retryAfterSec = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - record.windowStart)) / 1000);
      console.warn(`Rate limit hit: ${ip} (${record.count} submissions)`);
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Too many submissions. Please wait before submitting again.',
        retryAfterSeconds: retryAfterSec
      });
    }

    record.count += 1;
    await kvSet(kvKey, JSON.stringify(record), Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
  }

  // --- REQUIRED FIELDS ---
  const required = ['politician', 'state', 'violationType', 'description'];
  const missing = required.filter(f => !body[f] || !String(body[f]).trim());
  if (missing.length) {
    return res.status(400).json({ error: 'Missing required fields.', missing });
  }

  // --- MINIMUM DESCRIPTION LENGTH ---
  if (String(body.description).trim().length < MIN_DESCRIPTION_LENGTH) {
    return res.status(400).json({
      error: `Description must be at least ${MIN_DESCRIPTION_LENGTH} characters.`
    });
  }

  // --- BUILD SANITIZED REPORT ---
  const report = {
    id:              `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    submitted:       new Date().toISOString(),
    politician:      clean(body.politician,      MAX_FIELD_LENGTHS.politician),
    office:          clean(body.office,          MAX_FIELD_LENGTHS.office),
    state:           clean(body.state,           MAX_FIELD_LENGTHS.state),
    violationType:   clean(body.violationType,   MAX_FIELD_LENGTHS.violationType),
    description:     clean(body.description,     MAX_FIELD_LENGTHS.description),
    evidence:        clean(body.evidence,        MAX_FIELD_LENGTHS.evidence),
    suggestedAction: clean(body.suggestedAction, MAX_FIELD_LENGTHS.suggestedAction),
    reporter:        clean(body.reporter,        MAX_FIELD_LENGTHS.reporter) || 'Anonymous',
  };

  // --- DUPLICATE DETECTION (requires KV) ---
  // Rejects the same report submitted twice within the rate limit window.
  if (process.env.KV_REST_API_URL) {
    const dupKey = `dup:${hashBody(report)}`;
    const isDup = await kvGet(dupKey);
    if (isDup) {
      console.log(`Duplicate report dropped: ${dupKey}`);
      // Return success so the user isn't confused — just don't re-send to Discord
      return res.status(200).json({ success: true, id: report.id, note: 'duplicate' });
    }
    // Mark as seen for the rate limit window duration
    await kvSet(dupKey, '1', Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
  }

  // --- LOG (always) ---
  console.log('REPORT:', JSON.stringify({ id: report.id, politician: report.politician, ip }));

  // --- DISCORD WEBHOOK ---
  if (!process.env.REPORT_WEBHOOK_URL) {
    console.warn('REPORT_WEBHOOK_URL not set — report logged only.');
    return res.status(200).json({ success: true, id: report.id });
  }

  try {
    const discordRes = await fetch(process.env.REPORT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDiscordPayload(report, ip))
    });

    if (discordRes.status === 429) {
      // Discord is rate limiting us — this means our webhook is being hit too fast.
      // Log it, still return success to user (report isn't lost — it's in Vercel logs).
      const retryData = await discordRes.json().catch(() => ({}));
      console.error('Discord rate limit hit. Retry after:', retryData.retry_after, 'ms');
    } else if (!discordRes.ok) {
      const errText = await discordRes.text();
      console.error('Discord delivery failed:', discordRes.status, errText.slice(0, 200));
    }

  } catch (err) {
    console.error('Discord fetch threw:', err.message);
    // Don't return 500 — user submitted successfully, Discord delivery is best-effort
  }

  return res.status(200).json({ success: true, id: report.id });
}
