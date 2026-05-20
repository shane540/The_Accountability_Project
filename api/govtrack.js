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
async function findGovTrackPerson(name, state) {
  try {
    // FEC format is "LAST, FIRST MIDDLE" in all caps
    // GovTrack expects lowercase, first name only (no middle)
    const parts     = name.split(',');
    const lastName  = (parts[0] || '').trim().toLowerCase();
    const firstPart = (parts[1] || '').trim().toLowerCase();
    const firstName = firstPart.split(' ').filter(Boolean)[0] || '';

    // Try full name first
    const tryFetch = async (params) => {
      const res = await fetch(`${GOVTRACK_BASE}/person?${params.toString()}`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.objects || [];
    };

    // Attempt 1: lastname + firstname
    let people = await tryFetch(new URLSearchParams({
      lastname: lastName, firstname: firstName,
      current_role: 'true', format: 'json'
    }));

    // Attempt 2: lastname only if no results
    if (!people.length) {
      people = await tryFetch(new URLSearchParams({
        lastname: lastName,
        current_role: 'true', format: 'json', limit: '5'
      }));
    }

    if (!people.length) return null;

    // Filter by state if provided
    if (state && people.length > 1) {
      const stateUp = state.toUpperCase();
      const stateFiltered = people.filter(p =>
        p.current_role && p.current_role.state === stateUp
      );
      if (stateFiltered.length > 0) return stateFiltered[0];
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

  const { name, state } = req.query;

  if (!name) {
    return res.status(400).json({ error: 'name parameter required.' });
  }

  // Step 1 — find the person
  const person = await findGovTrackPerson(name, state);
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
