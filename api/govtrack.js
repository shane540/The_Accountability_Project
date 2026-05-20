// api/govtrack.js
// Fetches legislative stats for a member from GovTrack.us
// No API key required.
//
// GET /api/govtrack?name=Jordan&state=OH
// GET /api/govtrack?bioguide_id=J000289
//
// Returns:
//   missedVotesPct      — % of votes missed
//   votesWithPartyPct   — % voted with own party
//   votesAgainstPartyPct — % voted against own party
//   billsSponsored      — list of bills sponsored [{id, title, status, url}]
//   billsCosponsored    — list of bills cosponsored [{id, title, status, url}]

const GOVTRACK_BASE = 'https://www.govtrack.us/api/v2';

// Maps Congress.gov bioguide ID to GovTrack person ID
// GovTrack uses their own numeric ID — we find it by searching name
async function findGovTrackPerson(bioguide_id, name, state) {
  try {
    // Prefer bioguide_id lookup — most reliable cross-reference
    if (bioguide_id) {
      const res = await fetch(
        `${GOVTRACK_BASE}/person?bioguideid=${bioguide_id}&format=json`
      );
      if (res.ok) {
        const data = await res.json();
        const people = data.objects || [];
        if (people.length) return people[0];
      }
    }

    // Fallback: name-based search using q= parameter (GovTrack full-text search)
    const parts     = (name || '').split(',');
    const lastName  = (parts[0] || '').trim();
    const firstName = ((parts[1] || '').trim().split(' ').filter(Boolean)[0] || '');
    const q         = (firstName + ' ' + lastName).trim();

    const res2 = await fetch(
      `${GOVTRACK_BASE}/person?q=${encodeURIComponent(q)}&current_role=true&format=json&limit=5`
    );
    if (!res2.ok) return null;
    const data2 = await res2.json();
    let people = data2.objects || [];

    // Filter by state
    if (state && people.length > 1) {
      const stateFiltered = people.filter(p =>
        p.current_role && p.current_role.state === state.toUpperCase()
      );
      if (stateFiltered.length) return stateFiltered[0];
    }

    return people[0] || null;
  } catch (err) {
    console.error('GovTrack person lookup failed:', err.message);
    return null;
  }
}

// Fetches voting stats for a GovTrack person ID
async function fetchVotingStats(personId) {
  try {
    const res = await fetch(
      `${GOVTRACK_BASE}/person/${personId}?format=json`
    );
    if (!res.ok) return null;
    const data = await res.json();

    // GovTrack stores stats in current_role
    const role = data.current_role || {};
    return {
      missedVotesPct:       role.missed_votes_pct       ?? null,
      votesWithPartyPct:    role.votes_with_party_pct   ?? null,
      votesAgainstPartyPct: role.votes_against_party_pct ?? null
    };
  } catch (err) {
    console.error('GovTrack voting stats failed:', err.message);
    return null;
  }
}

// Fetches sponsored bills for a GovTrack person ID
async function fetchSponsoredBills(personId, role = 'sponsor') {
  try {
    const params = new URLSearchParams({
      sponsor: personId,
      congress: '119',   // current 119th Congress
      format: 'json',
      limit: '10',
      order_by: '-introduced_date'
    });

    const res = await fetch(`${GOVTRACK_BASE}/bill?${params.toString()}`);
    if (!res.ok) return [];
    const data = await res.json();

    return (data.objects || []).map(b => ({
      id:     b.bill_type_label + ' ' + b.number,
      title:  b.title_without_number || b.title || 'Untitled',
      status: b.current_status_description || b.current_status || '—',
      introduced: b.introduced_date || '—',
      url:    `https://www.govtrack.us/congress/bills/${b.congress}/${b.bill_type}${b.number}`
    }));
  } catch (err) {
    console.error('GovTrack bills fetch failed:', err.message);
    return [];
  }
}

// Fetches cosponsored bills for a GovTrack person ID
async function fetchCosponsoredBills(personId) {
  try {
    const params = new URLSearchParams({
      cosponsor: personId,
      congress: '119',
      format: 'json',
      limit: '10',
      order_by: '-introduced_date'
    });

    const res = await fetch(`${GOVTRACK_BASE}/bill?${params.toString()}`);
    if (!res.ok) return [];
    const data = await res.json();

    return (data.objects || []).map(b => ({
      id:     b.bill_type_label + ' ' + b.number,
      title:  b.title_without_number || b.title || 'Untitled',
      status: b.current_status_description || b.current_status || '—',
      introduced: b.introduced_date || '—',
      url:    `https://www.govtrack.us/congress/bills/${b.congress}/${b.bill_type}${b.number}`
    }));
  } catch (err) {
    console.error('GovTrack cosponsored bills fetch failed:', err.message);
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=7200'); // cache 2 hours

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { name, state, bioguide_id } = req.query;

  if (!name && !bioguide_id) {
    return res.status(400).json({ error: 'name or bioguide_id parameter required.' });
  }

  // Step 1 — find the person
  const person = await findGovTrackPerson(bioguide_id, name, state);
  if (!person) {
    return res.status(404).json({ error: 'Member not found on GovTrack.', name, state });
  }

  const personId = person.id;

  // Step 2 — fetch all data in parallel
  const [votingStats, billsSponsored, billsCosponsored] = await Promise.all([
    fetchVotingStats(personId),
    fetchSponsoredBills(personId),
    fetchCosponsoredBills(personId)
  ]);

  return res.status(200).json({
    govtrack_id:          personId,
    name:                 person.name || name,
    missedVotesPct:       votingStats?.missedVotesPct       ?? null,
    votesWithPartyPct:    votingStats?.votesWithPartyPct    ?? null,
    votesAgainstPartyPct: votingStats?.votesAgainstPartyPct ?? null,
    billsSponsored,
    billsCosponsored
  });
}
