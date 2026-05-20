// api/govtrack.js
// Fetches legislative data from Congress.gov API.
// Renamed govtrack.js to avoid frontend changes — same endpoint, different source.
//
// GET /api/govtrack?bioguide_id=B001306
//
// Returns:
//   billsSponsored      — recent bills sponsored [{id, title, status, url}]
//   billsCosponsored    — recent bills cosponsored [{id, title, status, url}]
//   missedVotesPct      — null (not available from Congress.gov — field reserved)
//   votesWithPartyPct   — null (not available from Congress.gov — field reserved)
//   votesAgainstPartyPct — null (not available from Congress.gov — field reserved)
//
// Environment variables required:
//   CONGRESS_API_KEY — from api.congress.gov/sign-up/

const CONGRESS_BASE = 'https://api.congress.gov/v3';
const CURRENT_CONGRESS = '119';

function billTypeLabel(typeCode) {
  const map = {
    hr: 'H.R.', s: 'S.', hjres: 'H.J.Res.', sjres: 'S.J.Res.',
    hconres: 'H.Con.Res.', sconres: 'S.Con.Res.', hres: 'H.Res.', sres: 'S.Res.'
  };
  return map[(typeCode || '').toLowerCase()] || (typeCode || '').toUpperCase();
}

function statusLabel(bill) {
  const actions = bill.latestAction;
  if (!actions) return '—';
  return actions.text ? actions.text.slice(0, 80) : '—';
}

function shapeBill(bill) {
  const type   = bill.type || '';
  const number = bill.number || '';
  const congress = bill.congress || CURRENT_CONGRESS;
  return {
    id:         `${billTypeLabel(type)} ${number}`,
    title:      bill.title || 'Untitled',
    status:     statusLabel(bill),
    introduced: bill.introducedDate || '—',
    url:        `https://www.congress.gov/bill/${congress}th-congress/${(type || '').toLowerCase().replace('res', '-resolution').replace('conres', 'concurrent-resolution').replace('jres', 'joint-resolution')}/${number}`
  };
}

async function fetchLegislation(bioguideId, type, apiKey) {
  // type: 'sponsored-legislation' or 'cosponsored-legislation'
  try {
    const params = new URLSearchParams({
      api_key: apiKey,
      format:  'json',
      limit:   '10',
      sort:    'updateDate+desc'
    });

    const url = `${CONGRESS_BASE}/member/${bioguideId}/${type}?${params.toString()}`;
    const res = await fetch(url);

    if (!res.ok) {
      console.error(`Congress.gov ${type} error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    // Response key is either 'sponsoredLegislation' or 'cosponsoredLegislation'
    const key  = type === 'sponsored-legislation' ? 'sponsoredLegislation' : 'cosponsoredLegislation';
    const bills = data[key] || [];

    return bills.map(shapeBill);
  } catch (err) {
    console.error(`fetchLegislation(${type}) failed:`, err.message);
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=7200');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.CONGRESS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'CONGRESS_API_KEY not configured.' });
  }

  const { bioguide_id, name, state } = req.query;

  if (!bioguide_id) {
    // No bioguide_id means this person wasn't matched to Congress.gov
    // Return empty but valid response so frontend doesn't error
    return res.status(200).json({
      bioguide_id:          null,
      name:                 name || '—',
      missedVotesPct:       null,
      votesWithPartyPct:    null,
      votesAgainstPartyPct: null,
      billsSponsored:       [],
      billsCosponsored:     []
    });
  }

  // Fetch sponsored and cosponsored in parallel
  const [billsSponsored, billsCosponsored] = await Promise.all([
    fetchLegislation(bioguide_id, 'sponsored-legislation',   apiKey),
    fetchLegislation(bioguide_id, 'cosponsored-legislation', apiKey)
  ]);

  return res.status(200).json({
    bioguide_id,
    name:                 name || '—',
    missedVotesPct:       null,
    votesWithPartyPct:    null,
    votesAgainstPartyPct: null,
    billsSponsored,
    billsCosponsored
  });
}
