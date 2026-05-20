// api/donors.js
// Vercel serverless function — fetches top donors for a specific candidate from FEC.
//
// What this does:
//   GET /api/donors?candidate_id=H8OH16110    → top donors for that FEC candidate ID
//
// Where the data comes from:
//   FEC API — /schedules/schedule_a/ endpoint (itemized receipts)
//   This is the actual donor schedule — every contribution over $200 is itemized.
//   Documentation: https://api.open.fec.gov/developers/#/receipts/get_schedules_schedule_a_
//
// What you get:
//   - Contributor name (individual or committee/PAC)
//   - Contribution amount
//   - Contributor employer and occupation (individuals)
//   - Contributor city/state
//   - Date of contribution
//   - Committee ID that received it
//
// The FEC candidate_id comes from the /api/politicians response.
// You need to pass it to this endpoint to get that person's donors.
//
// Environment variable required:
//   FEC_API_KEY = same key used in politicians.js

const FEC_BASE = 'https://api.open.fec.gov/v1';

function formatAmount(cents) {
  if (!cents && cents !== 0) return '—';
  const dollars = Math.abs(cents);
  if (dollars >= 1000000) return '$' + (dollars / 1000000).toFixed(1) + 'M';
  if (dollars >= 1000) return '$' + (dollars / 1000).toFixed(0) + 'K';
  return '$' + dollars.toLocaleString();
}

// Groups raw FEC receipts into summarized donor records
function groupDonors(receipts) {
  const map = {};
  for (const r of receipts) {
    const key = r.contributor_name || 'Unknown';
    if (!map[key]) {
      map[key] = {
        name: key,
        rawTotal: 0,
        industry: r.contributor_employer || r.contributor_occupation || 'Unknown',
        city: r.contributor_city || '',
        state: r.contributor_state || ''
      };
    }
    map[key].rawTotal += r.contribution_receipt_amount || 0;
  }

  return Object.values(map)
    .sort((a, b) => b.rawTotal - a.rawTotal)
    .slice(0, 10)
    .map(d => ({
      name: d.name,
      amount: formatAmount(d.rawTotal),
      industry: d.industry,
      location: [d.city, d.state].filter(Boolean).join(', ') || '—'
    }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.FEC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FEC_API_KEY not configured.' });
  }

  const { candidate_id, cycle } = req.query;
  if (!candidate_id) {
    return res.status(400).json({ error: 'candidate_id is required.' });
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    candidate_id: candidate_id,
    two_year_transaction_period: cycle || new Date().getFullYear(),
    per_page: '100',
    sort: '-contribution_receipt_amount',
    is_individual: 'false'         // Include both PAC and individual donors
  });

  const fecUrl = `${FEC_BASE}/schedules/schedule_a/?${params.toString()}`;

  try {
    const fecRes = await fetch(fecUrl);

    if (!fecRes.ok) {
      const errText = await fecRes.text();
      return res.status(502).json({
        error: `FEC API returned ${fecRes.status}`,
        detail: errText.slice(0, 200)
      });
    }

    const fecData = await fecRes.json();
    const donors = groupDonors(fecData.results || []);

    // Also compute a total
    const total = (fecData.results || []).reduce((sum, r) => sum + (r.contribution_receipt_amount || 0), 0);

    return res.status(200).json({
      candidate_id,
      total_formatted: formatAmount(total),
      donors
    });

  } catch (err) {
    console.error('Donors fetch failed:', err);
    return res.status(500).json({ error: 'Failed to reach FEC API.', detail: err.message });
  }
}
