// api/donors.js
// Fetches top donors for a specific candidate from FEC.
//
// Two-step process:
//   1. Look up the candidate's principal campaign committee ID
//   2. Pull itemized receipts for that committee
//
// GET /api/donors?candidate_id=H8OH12180
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

// Normalize name for deduplication
function normalizeName(name) {
  return (name || '')
    .toUpperCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
    .replace(/\b(INC|LLC|LTD|CORP|CO|PAC|JFC)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Filter out inter-committee transfers and aggregators
function isRealDonor(r) {
  const name = (r.contributor_name || '').toUpperCase();
  const type = (r.entity_type_desc || '').toUpperCase();
  const exclude = [
    'ACTBLUE', 'WINRED', 'FRIENDS OF', 'COMMITTEE FOR',
    'COMMITTEE TO', 'CAMPAIGN FOR', 'CITIZENS FOR',
    'NATIONAL COMMITTEE', 'PARTY COMMITTEE'
  ];
  if (exclude.some(e => name.includes(e))) return false;
  if (['COMMITTEE', 'PARTY', 'CANDIDATE'].some(t => type.includes(t))) return false;
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

// Step 1 — get the candidate's principal campaign committee ID
async function getCommitteeId(candidateId, apiKey) {
  try {
    const res = await fetch(
      `${FEC_BASE}/candidate/${candidateId}/committees/?api_key=${apiKey}&designation=P&format=json`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const committees = data.results || [];
    // designation P = principal campaign committee
    const principal = committees.find(c => c.designation === 'P') || committees[0];
    return principal ? principal.committee_id : null;
  } catch (err) {
    console.error('Committee lookup failed:', err.message);
    return null;
  }
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

  // Step 1 — get committee ID
  const committeeId = await getCommitteeId(candidate_id, apiKey);
  if (!committeeId) {
    return res.status(200).json({
      candidate_id,
      total_raw: 0,
      total_formatted: '—',
      donors: [],
      note: 'No principal campaign committee found.'
    });
  }

  // Step 2 — pull receipts for that specific committee
  const params = new URLSearchParams({
    api_key:                     apiKey,
    committee_id:                committeeId,
    two_year_transaction_period: cycle || new Date().getFullYear(),
    per_page:                    '100',
    sort:                        '-contribution_receipt_amount'
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
    const total    = receipts
      .filter(r => isRealDonor(r))
      .reduce((sum, r) => sum + (r.contribution_receipt_amount || 0), 0);

    return res.status(200).json({
      candidate_id,
      committee_id:    committeeId,
      total_raw:       total,
      total_formatted: formatAmount(total),
      donors
    });

  } catch (err) {
    console.error('donors handler error:', err);
    return res.status(500).json({ error: 'Server error.', detail: err.message });
  }
}
