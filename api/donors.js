// api/donors.js
// Fetches top donors for a specific candidate from FEC itemized receipts.
//
// GET /api/donors?candidate_id=H8OH16110
//
// Environment variables required:
//   FEC_API_KEY — from api.data.gov

const FEC_BASE = 'https://api.open.fec.gov/v1';

function formatAmount(dollars) {
  if (!dollars && dollars !== 0) return '—';
  const abs = Math.abs(dollars);
  if (abs >= 1000000) return '$' + (abs / 1000000).toFixed(1) + 'M';
  if (abs >= 1000)    return '$' + (abs / 1000).toFixed(0) + 'K';
  return '$' + abs.toLocaleString();
}

// Normalize name for deduplication — strips punctuation, extra spaces, inc/llc suffixes
function normalizeName(name) {
  return (name || '')
    .toUpperCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
    .replace(/(INC|LLC|LTD|CORP|CO|PAC|JFC)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Filter out inter-committee transfers and obviously non-individual entries
function isRealDonor(r) {
  const name = (r.contributor_name || '').toUpperCase();
  const type = (r.entity_type || '').toUpperCase();
  // Exclude other candidate committees, party committees, known aggregators
  const exclude = ['ACTBLUE', 'WINRED', 'UNITED STATES OF AMERICA', 'FRIENDS OF', 'COMMITTEE FOR', 'COMMITTEE TO'];
  if (exclude.some(e => name.includes(e))) return false;
  // Exclude if entity type is committee
  if (type === 'COM' || type === 'CCM' || type === 'PTY') return false;
  return true;
}

function groupDonors(receipts) {
  const map = {};
  for (const r of receipts) {
    if (!isRealDonor(r)) continue;
    const key = normalizeName(r.contributor_name || 'Unknown');
    if (!map[key]) {
      map[key] = {
        name:     r.contributor_name || 'Unknown',
        rawTotal: 0,
        industry: r.contributor_employer || r.contributor_occupation || 'Unknown',
        city:     r.contributor_city  || '',
        state:    r.contributor_state || ''
      };
    }
    map[key].rawTotal += r.contribution_receipt_amount || 0;
  }

  return Object.values(map)
    .filter(d => d.rawTotal > 0)
    .sort((a, b) => b.rawTotal - a.rawTotal)
    .slice(0, 10)
    .map(d => ({
      name:     d.name,
      amount:   formatAmount(d.rawTotal),
      rawTotal: d.rawTotal,
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
  if (!apiKey) return res.status(500).json({ error: 'FEC_API_KEY not configured.' });

  const { candidate_id, cycle } = req.query;
  if (!candidate_id) return res.status(400).json({ error: 'candidate_id is required.' });

  const params = new URLSearchParams({
    api_key:                     apiKey,
    candidate_id:                candidate_id,
    two_year_transaction_period: cycle || new Date().getFullYear(),
    per_page:                    '100',
    sort:                        '-contribution_receipt_amount',
    is_individual:               'false',
    line_number:                 'F3X-11AI'  // itemized individual contributions only
  });

  try {
    const fecRes = await fetch(`${FEC_BASE}/schedules/schedule_a/?${params.toString()}`);
    if (!fecRes.ok) {
      const err = await fecRes.text();
      return res.status(502).json({ error: `FEC API error ${fecRes.status}`, detail: err.slice(0, 200) });
    }

    const fecData = await fecRes.json();
    const receipts = fecData.results || [];
    const donors   = groupDonors(receipts);
    const total    = receipts.reduce((sum, r) => sum + (r.contribution_receipt_amount || 0), 0);

    return res.status(200).json({
      candidate_id,
      total_raw:       total,
      total_formatted: formatAmount(total),
      donors
    });

  } catch (err) {
    console.error('donors handler error:', err);
    return res.status(500).json({ error: 'Server error.', detail: err.message });
  }
}
