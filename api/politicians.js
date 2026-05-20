// api/politicians.js
// Pulls federal candidates from FEC, then enriches with Congress.gov member data
// (bioguideId, voting record, missed votes) for each result.
//
// FEC API:       api.open.fec.gov/v1/candidates/search/
// Congress API:  api.congress.gov/v3/member/{stateCode}
//
// Environment variables required in Vercel:
//   FEC_API_KEY        — from api.data.gov (FEC signup)
//   CONGRESS_API_KEY   — from api.congress.gov/sign-up/

const FEC_BASE      = 'https://api.open.fec.gov/v1';
const CONGRESS_BASE = 'https://api.congress.gov/v3';

const OFFICE_MAP = { H: 'U.S. Representative', S: 'U.S. Senator', P: 'President' };

function normalizeParty(p) {
  if (!p) return 'I';
  const u = p.toUpperCase();
  if (u === 'DEM' || u === 'D') return 'D';
  if (u === 'REP' || u === 'R') return 'R';
  return 'I';
}

// Calculates threat score from available data
// Scale 0-100. Weighted:
//   Missed vote rate  40pts — higher missed = higher threat
//   Donor total       40pts — more money = higher threat
//   Violations        20pts — manual entry via report form
function calcThreatScore(missedVotePct, donorTotalRaw, violations) {
  const missedScore  = Math.min((missedVotePct / 100) * 40, 40);
  const donorScore   = Math.min((donorTotalRaw / 5000000) * 40, 40);
  const violScore    = Math.min(violations * 5, 20);
  return Math.round(missedScore + donorScore + violScore);
}

// Fetches current members for a state from Congress.gov
// Returns a map of { normalizedName -> { bioguideId, missedVotesPct, partyName } }
async function fetchCongressMembers(stateCode, congressApiKey) {
  try {
    const url = `${CONGRESS_BASE}/member/${stateCode.toUpperCase()}?format=json&limit=50&api_key=${congressApiKey}&currentMember=true`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    const members = data.members || [];

    const map = {};
    for (const m of members) {
      // Normalize name for matching — Congress uses "Last, First" format
      const normalized = (m.name || '').toUpperCase().replace(/[^A-Z\s]/g, '').trim();
      map[normalized] = {
        bioguideId:     m.bioguideId || null,
        missedVotesPct: m.missedVotesPct || 0,
        partyName:      m.partyName || ''
      };
    }
    return map;
  } catch (err) {
    console.error('Congress member fetch failed:', err.message);
    return {};
  }
}

// Tries to match an FEC candidate name to a Congress.gov member
// FEC uses "LAST, FIRST MIDDLE" — try progressively looser matches
function matchCongressMember(fecName, congressMap) {
  const normalized = (fecName || '').toUpperCase().replace(/[^A-Z\s,]/g, '').trim();

  // Exact match first
  if (congressMap[normalized]) return congressMap[normalized];

  // Last name only match
  const lastName = normalized.split(',')[0].trim();
  for (const [key, val] of Object.entries(congressMap)) {
    if (key.startsWith(lastName + ',') || key.startsWith(lastName + ' ')) {
      return val;
    }
  }
  return null;
}

function shapePolitician(candidate, congressMember, idx) {
  const office   = OFFICE_MAP[candidate.office] || candidate.office || 'Unknown Office';
  const district = candidate.district ? ` District ${candidate.district}` : '';
  const missed   = congressMember?.missedVotesPct || 0;
  const threat   = calcThreatScore(missed, 0, 0); // donors loaded separately

  return {
    id:               idx + 1,
    name:             candidate.name || 'Unknown',
    party:            normalizeParty(candidate.party),
    state:            candidate.state || '??',
    office:           office + (candidate.office === 'H' ? district : ''),
    level:            'federal',
    since:            candidate.first_file_date
                        ? new Date(candidate.first_file_date).getFullYear()
                        : '—',
    violations:       0,
    totalDonors:      '—',
    recallActive:     false,
    threatScore:      threat,
    missedVotesPct:   missed,
    fec_candidate_id: candidate.candidate_id || null,
    bioguide_id:      congressMember?.bioguideId || null,
    donors:           [],
    violations_list:  []
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const fecKey      = process.env.FEC_API_KEY;
  const congressKey = process.env.CONGRESS_API_KEY;

  if (!fecKey) {
    return res.status(500).json({ error: 'FEC_API_KEY not configured.' });
  }

  const { state, name, office, cycle } = req.query;

  const params = new URLSearchParams({
    api_key:          fecKey,
    is_active_candidate: 'true',
    candidate_status: 'C',
    election_year:    cycle || new Date().getFullYear(),
    per_page:         '100',
    sort:             'name'
  });

  if (state)  params.set('state', state.toUpperCase());
  if (name)   params.set('q', name);
  if (office) params.set('office', office.toUpperCase());

  try {
    const fecRes = await fetch(`${FEC_BASE}/candidates/search/?${params.toString()}`);
    if (!fecRes.ok) {
      const err = await fecRes.text();
      return res.status(502).json({ error: `FEC API error ${fecRes.status}`, detail: err.slice(0, 200) });
    }

    const fecData = await fecRes.json();
    const candidates = fecData.results || [];

    // Fetch Congress.gov members for this state if we have the key and a state filter
    let congressMap = {};
    if (congressKey && state) {
      congressMap = await fetchCongressMembers(state, congressKey);
    }

    const results = candidates.map((c, i) => {
      const match = matchCongressMember(c.name, congressMap);
      return shapePolitician(c, match, i);
    });

    return res.status(200).json(results);

  } catch (err) {
    console.error('politicians handler error:', err);
    return res.status(500).json({ error: 'Server error.', detail: err.message });
  }
}
