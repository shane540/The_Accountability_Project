/**
 * THE ACCOUNTABILITY PROJECT — API INTEGRATION LAYER
 * 
 * APIs Used:
 * 1. OpenFEC API (free, requires API key from api.data.gov)
 *    - Get key: https://api.data.gov/signup/
 *    - Docs: https://api.open.fec.gov/developers/
 * 
 * 2. ProPublica Congress API (free, requires API key)
 *    - Get key: https://www.propublica.org/datastore/api/propublica-congress-api
 *    - Docs: https://projects.propublica.org/api-docs/congress-api/
 * 
 * 3. ProPublica Campaign Finance API (free, requires API key)
 *    - Get key: email apihelp@propublica.org
 *    - Docs: https://projects.propublica.org/api-docs/campaign-finance/
 * 
 * HOW TO USE:
 * 1. Get your API keys from the links above
 * 2. Replace the placeholder values below with your real keys
 * 3. Include this file in accountability_project.html before the closing </body>
 *    <script src="api_integration.js"></script>
 * 4. Call AccountabilityAPI.loadPolitician(name, state) to pull live data
 */

const AccountabilityAPI = {

  // ============================================================
  // CONFIGURATION — REPLACE THESE WITH YOUR REAL API KEYS
  // ============================================================
  config: {
    FEC_API_KEY: 'YOUR_FEC_API_KEY_HERE',           // Get free key at: https://api.data.gov/signup/
    PROPUBLICA_API_KEY: 'YOUR_PROPUBLICA_KEY_HERE', // Email: apihelp@propublica.org
    FEC_BASE: 'https://api.open.fec.gov/v1',
    PROPUBLICA_BASE: 'https://api.propublica.org',
    CYCLE: '2026', // Current election cycle — update every 2 years
  },

  // ============================================================
  // FEC API — CANDIDATE SEARCH
  // Find a politician by name and get their FEC candidate ID
  // ============================================================
  async searchCandidate(name, state = null, office = null) {
    try {
      let url = `${this.config.FEC_BASE}/candidates/?api_key=${this.config.FEC_API_KEY}&q=${encodeURIComponent(name)}&sort=-receipts&per_page=5`;
      if (state) url += `&state=${state}`;
      if (office) url += `&office=${office}`; // H=House, S=Senate, P=President

      const response = await fetch(url);
      if (!response.ok) throw new Error(`FEC API error: ${response.status}`);
      const data = await response.json();

      if (!data.results || data.results.length === 0) {
        return { error: 'No candidates found', name, state };
      }

      // Return top match with key fields
      return data.results.map(c => ({
        fec_id: c.candidate_id,
        name: c.name,
        party: c.party,
        state: c.state,
        office: c.office,
        office_full: c.office_full,
        district: c.district,
        incumbent_challenge: c.incumbent_challenge_full,
        cycles: c.election_years,
        committees: c.principal_committees,
      }));

    } catch (err) {
      console.error('FEC candidate search error:', err);
      return { error: err.message };
    }
  },

  // ============================================================
  // FEC API — CANDIDATE FINANCIAL TOTALS
  // Get total raised, spent, cash on hand for a candidate
  // ============================================================
  async getCandidateTotals(candidateId, cycle = null) {
    try {
      const electionCycle = cycle || this.config.CYCLE;
      const url = `${this.config.FEC_BASE}/candidates/${candidateId}/totals/?api_key=${this.config.FEC_API_KEY}&cycle=${electionCycle}`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`FEC totals error: ${response.status}`);
      const data = await response.json();

      if (!data.results || data.results.length === 0) {
        return { error: 'No financial data found', candidateId };
      }

      const t = data.results[0];
      return {
        cycle: t.cycle,
        total_receipts: this.formatMoney(t.receipts),
        total_disbursements: this.formatMoney(t.disbursements),
        cash_on_hand: this.formatMoney(t.last_cash_on_hand_end_period),
        individual_contributions: this.formatMoney(t.individual_contributions),
        pac_contributions: this.formatMoney(t.other_political_committee_contributions),
        party_contributions: this.formatMoney(t.political_party_committee_contributions),
        candidate_contributions: this.formatMoney(t.candidate_contribution),
        raw: t,
      };

    } catch (err) {
      console.error('FEC totals error:', err);
      return { error: err.message };
    }
  },

  // ============================================================
  // FEC API — TOP DONORS (Schedule A — itemized receipts)
  // Get the biggest individual donors to a candidate's committee
  // ============================================================
  async getTopDonors(committeeId, cycle = null) {
    try {
      const electionCycle = cycle || this.config.CYCLE;
      const url = `${this.config.FEC_BASE}/schedules/schedule_a/by_contributor/?api_key=${this.config.FEC_API_KEY}&committee_id=${committeeId}&cycle=${electionCycle}&sort=-total&per_page=10`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`FEC donors error: ${response.status}`);
      const data = await response.json();

      if (!data.results) return { error: 'No donor data', committeeId };

      return data.results.map(d => ({
        name: d.contributor_name,
        total: this.formatMoney(d.total),
        count: d.count,
        state: d.contributor_state,
        employer: d.contributor_employer,
        occupation: d.contributor_occupation,
      }));

    } catch (err) {
      console.error('FEC donors error:', err);
      return { error: err.message };
    }
  },

  // ============================================================
  // FEC API — TOP PAC DONORS
  // Get the PACs that donated the most to a candidate's committee
  // ============================================================
  async getTopPACs(committeeId, cycle = null) {
    try {
      const electionCycle = cycle || this.config.CYCLE;
      const url = `${this.config.FEC_BASE}/schedules/schedule_a/by_contributor/?api_key=${this.config.FEC_API_KEY}&committee_id=${committeeId}&cycle=${electionCycle}&contributor_type=committee&sort=-total&per_page=10`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`FEC PAC error: ${response.status}`);
      const data = await response.json();

      if (!data.results) return { error: 'No PAC data', committeeId };

      return data.results.map(d => ({
        name: d.contributor_name,
        committee_id: d.contributor_id,
        total: this.formatMoney(d.total),
        count: d.count,
      }));

    } catch (err) {
      console.error('FEC PAC error:', err);
      return { error: err.message };
    }
  },

  // ============================================================
  // FEC API — INDUSTRY BREAKDOWN (via committee receipts by type)
  // Get breakdown of donations by industry/sector
  // ============================================================
  async getIndustryBreakdown(committeeId, cycle = null) {
    try {
      const electionCycle = cycle || this.config.CYCLE;
      const url = `${this.config.FEC_BASE}/schedules/schedule_a/by_industry/?api_key=${this.config.FEC_API_KEY}&committee_id=${committeeId}&cycle=${electionCycle}&sort=-total&per_page=10`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`FEC industry error: ${response.status}`);
      const data = await response.json();

      if (!data.results) return { error: 'No industry data', committeeId };

      return data.results.map(d => ({
        industry: d.industry,
        total: this.formatMoney(d.total),
        count: d.count,
      }));

    } catch (err) {
      console.error('FEC industry error:', err);
      return { error: err.message };
    }
  },

  // ============================================================
  // PROPUBLICA CONGRESS API — MEMBER PROFILE
  // Get voting record, bio, committee assignments for a Congress member
  // ============================================================
  async getCongressMember(memberId) {
    try {
      const url = `${this.config.PROPUBLICA_BASE}/congress/v1/members/${memberId}.json`;
      const response = await fetch(url, {
        headers: { 'X-API-Key': this.config.PROPUBLICA_API_KEY }
      });
      if (!response.ok) throw new Error(`ProPublica member error: ${response.status}`);
      const data = await response.json();

      if (!data.results || data.results.length === 0) {
        return { error: 'Member not found', memberId };
      }

      const m = data.results[0];
      const role = m.roles[0] || {};
      return {
        id: m.member_id,
        name: `${m.first_name} ${m.last_name}`,
        party: m.current_party,
        state: role.state,
        district: role.district,
        chamber: role.chamber,
        title: role.title,
        start_date: role.start_date,
        end_date: role.end_date,
        office: role.office,
        phone: role.phone,
        website: m.url,
        twitter: m.twitter_account,
        votes_with_party_pct: role.votes_with_party_pct,
        votes_against_party_pct: role.votes_against_party_pct,
        missed_votes_pct: role.missed_votes_pct,
        total_votes: role.total_votes,
        missed_votes: role.missed_votes,
        committees: (role.committees || []).map(c => c.name),
        subcommittees: (role.subcommittees || []).map(s => s.name),
      };

    } catch (err) {
      console.error('ProPublica member error:', err);
      return { error: err.message };
    }
  },

  // ============================================================
  // PROPUBLICA CONGRESS API — MEMBER VOTE POSITIONS
  // Get how a member voted on recent bills
  // ============================================================
  async getMemberVotes(memberId, chamber = 'house', offset = 0) {
    try {
      const url = `${this.config.PROPUBLICA_BASE}/congress/v1/members/${memberId}/votes.json?offset=${offset}`;
      const response = await fetch(url, {
        headers: { 'X-API-Key': this.config.PROPUBLICA_API_KEY }
      });
      if (!response.ok) throw new Error(`ProPublica votes error: ${response.status}`);
      const data = await response.json();

      if (!data.results) return { error: 'No vote data', memberId };

      return data.results[0].votes.map(v => ({
        date: v.date,
        bill_id: v.bill ? v.bill.bill_id : null,
        bill_title: v.bill ? v.bill.title : v.description,
        position: v.position,
        result: v.result,
        question: v.question,
      }));

    } catch (err) {
      console.error('ProPublica votes error:', err);
      return { error: err.message };
    }
  },

  // ============================================================
  // PROPUBLICA CONGRESS API — SEARCH MEMBERS BY STATE
  // Get all current Congress members from a specific state
  // ============================================================
  async getMembersByState(state, chamber = 'house') {
    try {
      const congress = '119'; // 119th Congress = 2025-2026
      const url = `${this.config.PROPUBLICA_BASE}/congress/v1/${congress}/${chamber}/members.json`;
      const response = await fetch(url, {
        headers: { 'X-API-Key': this.config.PROPUBLICA_API_KEY }
      });
      if (!response.ok) throw new Error(`ProPublica state members error: ${response.status}`);
      const data = await response.json();

      if (!data.results) return { error: 'No data', state };

      return data.results[0].members
        .filter(m => m.state === state.toUpperCase())
        .map(m => ({
          id: m.id,
          name: `${m.first_name} ${m.last_name}`,
          party: m.party,
          state: m.state,
          district: m.district,
          votes_with_party_pct: m.votes_with_party_pct,
          missed_votes_pct: m.missed_votes_pct,
          in_office: m.in_office,
        }));

    } catch (err) {
      console.error('ProPublica state members error:', err);
      return { error: err.message };
    }
  },

  // ============================================================
  // FULL POLITICIAN LOAD — COMBINES FEC + PROPUBLICA
  // Call this to build a complete politician profile from scratch
  // Usage: await AccountabilityAPI.loadPolitician('Nancy Pelosi', 'CA', 'H')
  // ============================================================
  async loadPolitician(name, state, officeCode = 'H') {
    console.log(`Loading data for: ${name} (${state})`);

    // Step 1: Search FEC for candidate
    const candidates = await this.searchCandidate(name, state, officeCode);
    if (candidates.error || candidates.length === 0) {
      return { error: `Could not find ${name} in FEC database`, name };
    }

    const candidate = candidates[0];
    console.log(`Found FEC candidate: ${candidate.name} (${candidate.fec_id})`);

    // Step 2: Get financial totals
    const totals = await this.getCandidateTotals(candidate.fec_id);

    // Step 3: Get top PAC donors (using principal committee)
    let topPACs = [];
    let topDonors = [];
    let industry = [];
    if (candidate.committees && candidate.committees.length > 0) {
      const committeeId = candidate.committees[0].id;
      [topPACs, topDonors, industry] = await Promise.all([
        this.getTopPACs(committeeId),
        this.getTopDonors(committeeId),
        this.getIndustryBreakdown(committeeId),
      ]);
    }

    // Step 4: Get ProPublica member data (for Congress members)
    // Note: ProPublica uses different IDs — match by name/state
    let memberProfile = null;
    if (officeCode === 'H' || officeCode === 'S') {
      const chamber = officeCode === 'H' ? 'house' : 'senate';
      const stateMembers = await this.getMembersByState(state, chamber);
      if (!stateMembers.error) {
        // Fuzzy match by last name
        const lastName = name.split(' ').pop().toUpperCase();
        const match = stateMembers.find(m => 
          m.name.toUpperCase().includes(lastName)
        );
        if (match) {
          memberProfile = await this.getCongressMember(match.id);
          console.log(`Found ProPublica profile: ${memberProfile.name}`);
        }
      }
    }

    // Build complete profile
    const profile = {
      // Identity
      name: candidate.name,
      party: candidate.party,
      state: candidate.state,
      office: candidate.office_full,
      district: candidate.district,
      fec_id: candidate.fec_id,

      // Financial summary
      total_raised: totals.total_receipts || 'N/A',
      total_spent: totals.total_disbursements || 'N/A',
      cash_on_hand: totals.cash_on_hand || 'N/A',
      individual_contributions: totals.individual_contributions || 'N/A',
      pac_contributions: totals.pac_contributions || 'N/A',

      // Donors
      top_pacs: Array.isArray(topPACs) ? topPACs.slice(0, 5) : [],
      top_individual_donors: Array.isArray(topDonors) ? topDonors.slice(0, 5) : [],
      industry_breakdown: Array.isArray(industry) ? industry.slice(0, 5) : [],

      // Congressional profile (if available)
      votes_with_party: memberProfile?.votes_with_party_pct || null,
      missed_votes_pct: memberProfile?.missed_votes_pct || null,
      committees: memberProfile?.committees || [],
      phone: memberProfile?.phone || null,
      website: memberProfile?.website || null,
      twitter: memberProfile?.twitter || null,
      propublica_id: memberProfile?.id || null,

      // Metadata
      data_cycle: this.config.CYCLE,
      loaded_at: new Date().toISOString(),
      data_sources: ['OpenFEC API', memberProfile ? 'ProPublica Congress API' : null].filter(Boolean),
    };

    console.log('Profile loaded:', profile);
    return profile;
  },

  // ============================================================
  // LOAD AND RENDER INTO APP — UPDATES THE EXISTING CARD UI
  // Call this to replace sample data with live data in the app
  // Usage: await AccountabilityAPI.renderLiveCard('Nancy Pelosi', 'CA', 'H')
  // ============================================================
  async renderLiveCard(name, state, officeCode = 'H') {
    const profile = await this.loadPolitician(name, state, officeCode);
    if (profile.error) {
      console.error('Could not load politician:', profile.error);
      return null;
    }

    // Build card data in the format the app expects
    const cardData = {
      id: Date.now(), // temp ID
      name: this.titleCase(profile.name),
      party: profile.party === 'DEM' ? 'D' : profile.party === 'REP' ? 'R' : 'I',
      state: this.stateFullName(profile.state),
      office: profile.office,
      level: (officeCode === 'H' || officeCode === 'S' || officeCode === 'P') ? 'federal' : 'state',
      since: null, // FEC doesn't return this directly — would need ProPublica
      violations: 0, // Violations must be manually entered or from another source
      totalDonors: profile.total_raised,
      recallActive: false,
      threatScore: this.calculateThreatScore(profile),
      donors: [
        ...profile.top_pacs.slice(0, 2).map(p => ({
          name: p.name,
          amount: p.total,
          industry: 'PAC'
        })),
        ...profile.top_individual_donors.slice(0, 2).map(d => ({
          name: d.name,
          amount: d.total,
          industry: d.occupation || d.employer || 'Individual'
        })),
      ],
      violations_list: [],
      _live_data: profile, // Store full profile for access
    };

    return cardData;
  },

  // ============================================================
  // BATCH LOAD — Load all Congress members from a state
  // Usage: await AccountabilityAPI.loadStateMembers('OH')
  // ============================================================
  async loadStateMembers(state) {
    console.log(`Loading all Congress members for state: ${state}`);
    const [houseMembers, senateMembers] = await Promise.all([
      this.getMembersByState(state, 'house'),
      this.getMembersByState(state, 'senate'),
    ]);

    const allMembers = [
      ...(Array.isArray(houseMembers) ? houseMembers : []),
      ...(Array.isArray(senateMembers) ? senateMembers : []),
    ];

    console.log(`Found ${allMembers.length} Congress members for ${state}`);
    return allMembers;
  },

  // ============================================================
  // FEC ENFORCEMENT — Check for active complaints/matters
  // Get open enforcement matters from FEC
  // ============================================================
  async getFECEnforcement(committeeOrCandidateName) {
    try {
      const url = `${this.config.FEC_BASE}/legal/enforcement/matters/?api_key=${this.config.FEC_API_KEY}&q=${encodeURIComponent(committeeOrCandidateName)}&per_page=10`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`FEC enforcement error: ${response.status}`);
      const data = await response.json();

      if (!data.results) return [];

      return data.results.map(m => ({
        case_id: m.case_id,
        name: m.name,
        type: m.election_cycle,
        respondents: m.respondents,
        commission_votes: m.commission_votes,
        dispositions: m.dispositions,
        url: `https://www.fec.gov/legal/enforcement/enforcement-query-system/?candidate_id=${m.case_id}`,
      }));

    } catch (err) {
      console.error('FEC enforcement error:', err);
      return [];
    }
  },

  // ============================================================
  // UTILITY FUNCTIONS
  // ============================================================
  formatMoney(amount) {
    if (amount == null || isNaN(amount)) return 'N/A';
    if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
    if (amount >= 1000) return `$${(amount / 1000).toFixed(0)}K`;
    return `$${amount.toFixed(0)}`;
  },

  titleCase(str) {
    if (!str) return '';
    return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  },

  calculateThreatScore(profile) {
    let score = 20; // base
    // More PAC money = higher threat
    const pacAmount = parseFloat((profile.pac_contributions || '0').replace(/[$MK,]/g, '')) || 0;
    if (pacAmount > 1) score += 30;
    else if (pacAmount > 0.5) score += 20;
    else if (pacAmount > 0.1) score += 10;
    // Missed votes
    if (profile.missed_votes_pct > 20) score += 15;
    else if (profile.missed_votes_pct > 10) score += 8;
    // Votes with party (low = potential defector or rubber stamp)
    if (profile.votes_with_party < 50) score += 15;
    return Math.min(score, 99);
  },

  stateFullName(code) {
    const states = {AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'};
    return states[code] || code;
  },
};

// ============================================================
// HOW TO GET YOUR API KEYS
// ============================================================
// 
// 1. FEC API KEY (free, instant):
//    - Visit: https://api.data.gov/signup/
//    - Enter your email — key arrives instantly
//    - Replace 'YOUR_FEC_API_KEY_HERE' above
//
// 2. PROPUBLICA CONGRESS API KEY (free, 1-2 days):
//    - Visit: https://www.propublica.org/datastore/api/propublica-congress-api
//    - Fill out the form — key arrives by email
//    - Replace 'YOUR_PROPUBLICA_KEY_HERE' above
//
// 3. PROPUBLICA CAMPAIGN FINANCE API KEY (free, email required):
//    - Email: apihelp@propublica.org
//    - Subject: "API Key Request — Campaign Finance"
//    - They'll send a key within a few days
//
// ============================================================
// EXAMPLE USAGE IN YOUR APP
// ============================================================
//
// Load a single politician's live data:
// const data = await AccountabilityAPI.loadPolitician('Sherrod Brown', 'OH', 'S');
//
// Load all Congress members from a state:
// const ohioReps = await AccountabilityAPI.loadStateMembers('OH');
//
// Get top donors for a specific committee:
// const donors = await AccountabilityAPI.getTopDonors('C00035006');
//
// Check FEC enforcement matters:
// const cases = await AccountabilityAPI.getFECEnforcement('Morrison');
//
// Render live card into the app:
// const card = await AccountabilityAPI.renderLiveCard('Jim Jordan', 'OH', 'H');
// if (card) politicians.push(card); renderCards();
//
// ============================================================

console.log('AccountabilityAPI loaded — replace API keys in config to activate live data');
