// api/politicians.js
// Vercel serverless function — proxies FEC API so the key never touches the browser.
//
// What this does:
//   GET /api/politicians?state=OH          → all current Congress members from Ohio
//   GET /api/politicians?state=OH&name=Jordan → search by name within state
//   GET /api/politicians                   → all current Congress members (paginated, first 100)
//
// Where the data comes from:
//   FEC API (api.data.gov) — https://api.open.fec.gov/v1/
//   Endpoint used: /candidates/search/
//   Documentation: https://api.open.fec.gov/developers/
//   Free key: https://api.data.gov/signup/
//
// What the FEC API provides:
//   - Candidate name, party, state, office (H/S/P), district
//   - Election cycles active, incumbent/challenger/open status
//   - Candidate ID (used to fetch their donor data separately)
//   - NOT provided: voting records, ethics violations (those require ProPublica or manual entry)
//
// Environment variable required in Vercel:
//   FEC_API_KEY = your key from api.data.gov

const FEC_BASE = 'https://api.open.fec.gov/v1';

// Maps FEC office codes to readable strings
const OFFICE_MAP = { H: 'U.S. Representative', S: 'U.S. Senator', P: 'President' };

// Maps FEC party codes to the app's D/R/I system
function normalizeParty(fecParty) {
  if (!fecParty) return 'I';
  const p = fecParty.toUpperCase();
  if (p === 'DEM') return 'D';
  if (p === 'REP') return 'R';
  return 'I';
}

// Converts a FEC candidate record into the shape index.html expects
function shapePolitician(candidate, idx) {
  const office = OFFICE_MAP[candidate.office] || candidate.office || 'Unknown Office';
  const state = candidate.state || '??';
  const district = candidate.district ? ` District ${candidate.district}` : '';

  return {
    id: idx + 1,
    name: candidate.name || 'Unknown',
    party: normalizeParty(candidate.party),
    state: state,
    office: office + (candidate.office === 'H' ? district : ''),
    level: 'federal',
    since: candidate.first_file_date
      ? new Date(candidate.first_file_date).getFullYear()
      : '—',
    violations: 0,                // FEC doesn't track violations — add manually or via ethics API
    totalDonors: '—',             // Populated separately via /api/donors?candidate_id=...
    recallActive: false,           // Federal officials cannot be recalled
    threatScore: null,             // Calculated field — requires violation + donor data
    fec_candidate_id: candidate.candidate_id || null,
    donors: [],                    // Fetch via /api/donors endpoint once candidate_id is known
    violations_list: []            // Add via violation report form
  };
}

export default async function handler(req, res) {
  // CORS headers — allows index.html to call this from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600'); // Cache 1 hour at Vercel edge

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = process.env.FEC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FEC_API_KEY not configured in Vercel environment variables.' });
  }

  const { state, name, office, cycle } = req.query;

  // Build FEC API query params
  const params = new URLSearchParams({
    api_key: apiKey,
    is_active_candidate: 'true',
    candidate_status: 'C',         // C = current candidate
    election_year: cycle || new Date().getFullYear(),
    per_page: '100',
    sort: 'name'
  });

  if (state) params.set('state', state.toUpperCase());
  if (name)  params.set('q', name);
  if (office) params.set('office', office.toUpperCase()); // H, S, or P

  const fecUrl = `${FEC_BASE}/candidates/search/?${params.toString()}`;

  try {
    const fecRes = await fetch(fecUrl);

    if (!fecRes.ok) {
      const errText = await fecRes.text();
      console.error('FEC API error:', fecRes.status, errText);
      return res.status(502).json({
        error: `FEC API returned ${fecRes.status}`,
        detail: errText.slice(0, 200)
      });
    }

    const fecData = await fecRes.json();
    const results = (fecData.results || []).map(shapePolitician);

    return res.status(200).json(results);

  } catch (err) {
    console.error('Fetch failed:', err);
    return res.status(500).json({ error: 'Failed to reach FEC API.', detail: err.message });
  }
}
