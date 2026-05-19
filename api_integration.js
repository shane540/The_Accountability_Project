/**
 * THE ACCOUNTABILITY PROJECT — API Integration (Netlify version)
 * 
 * All requests proxy through /.netlify/functions/api
 * API key lives in Netlify environment variables — never touches the browser.
 * 
 * Setup:
 * 1. Netlify → Site settings → Environment variables
 * 2. Add: FEC_API_KEY = your_api_data_gov_key
 * 3. Deploy — done
 */
 
const AccountabilityAPI = {
 
  config: {
    PROXY: '/.netlify/functions/api',
    CONGRESS_NUM: '119',
    CYCLE: '2026',
  },
 
  // Core fetch — all requests go through the proxy
  async get(source, path, params = {}) {
    const query = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `${this.config.PROXY}?source=${source}&path=${encodeURIComponent(path)}${query ? '&' + query : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Proxy error: ${res.status}`);
    return res.json();
  },
 
  // ============================================================
  // FEC — SEARCH CANDIDATE
  // ============================================================
  async searchCandidate(name, state = null, office = null) {
    try {
      const params = { q: name, sort: '-receipts', per_page: '5', is_active_candidate: 'true' };
      if (state) params.state = state;
      if (office) params.office = office;
      const data = await this.get('fec', '/candidates/', params);
      if (!data.results?.length) return { error: 'Not found', name };
      return data.results.map(c => ({
        fec_id: c.candidate_id,
        name: c.name,
        party: c.party,
        state: c.state,
        office: c.office_full,
        district: c.district,
        committees: c.principal_committees,
      }));
    } catch (e) { return { error: e.message }; }
  },
 
  // ============================================================
  // FEC — FINANCIAL TOTALS
  // ============================================================
  async getCandidateTotals(candidateId) {
    try {
      const data = await this.get('fec', `/candidates/${candidateId}/totals/`, { cycle: this.config.CYCLE });
      if (!data.results?.length) return { error: 'No data' };
      const t = data.results[0];
      return {
        total_receipts: this.fmt(t.receipts),
        total_disbursements: this.fmt(t.disbursements),
        cash_on_hand: this.fmt(t.last_cash_on_hand_end_period),
        individual_contributions: this.fmt(t.individual_contributions),
        pac_contributions: this.fmt(t.other_political_committee_contributions),
      };
    } catch (e) { return { error: e.message }; }
  },
 
  // ============================================================
  // FEC — TOP PAC DONORS
  // ============================================================
  async getTopPACs(committeeId) {
    try {
      const data = await this.get('fec', '/schedules/schedule_a/by_contributor/', {
        committee_id: committeeId, cycle: this.config.CYCLE,
        contributor_type: 'committee', sort: '-total', per_page: '8'
      });
      return (data.results || []).map(d => ({
        name: d.contributor_name, total: this.fmt(d.total), count: d.count,
      }));
    } catch (e) { return []; }
  },
 
  // ============================================================
  // FEC — TOP INDIVIDUAL DONORS
  // ============================================================
  async getTopDonors(committeeId) {
    try {
      const data = await this.get('fec', '/schedules/schedule_a/by_contributor/', {
        committee_id: committeeId, cycle: this.config.CYCLE,
        contributor_type: 'individual', sort: '-total', per_page: '8'
      });
      return (data.results || []).map(d => ({
        name: d.contributor_name, total: this.fmt(d.total),
        employer: d.contributor_employer, occupation: d.contributor_occupation,
      }));
    } catch (e) { return []; }
  },
 
  // ============================================================
  // FEC — ENFORCEMENT MATTERS
  // ============================================================
  async getFECEnforcement(name) {
    try {
      const data = await this.get('fec', '/legal/enforcement/matters/', { q: name, per_page: '10' });
      return (data.results || []).map(m => ({
        case_id: m.case_id, name: m.name, respondents: m.respondents,
      }));
    } catch (e) { return []; }
  },
 
  // ============================================================
  // CONGRESS.GOV v3 — GET MEMBER
  // ============================================================
  async getCongressMember(bioguideId) {
    try {
      const data = await this.get('congress', `/member/${bioguideId}`, { format: 'json' });
      const m = data.member;
      if (!m) return { error: 'Not found' };
      const term = (m.terms?.item || []).find(t => !t.endYear || t.endYear >= 2025) || {};
      return {
        bioguide_id: m.bioguideId,
        name: m.directOrderName || `${m.firstName} ${m.lastName}`,
        party: m.partyHistory?.[0]?.partyAbbreviation || 'N/A',
        state: term.stateCode,
        district: term.district,
        chamber: term.chamber,
        website: m.officialWebsiteUrl,
        sponsored_legislation: m.sponsoredLegislation?.count || 0,
        cosponsored_legislation: m.cosponsoredLegislation?.count || 0,
      };
    } catch (e) { return { error: e.message }; }
  },
 
  // ============================================================
  // CONGRESS.GOV v3 — MEMBERS BY STATE
  // ============================================================
  async getMembersByState(state, chamber = 'House') {
    try {
      const data = await this.get('congress', '/member', {
        format: 'json', limit: '250', currentMember: 'true'
      });
      return (data.members || [])
        .filter(m => {
          const term = (m.terms?.item || []).find(t => !t.endYear || t.endYear >= 2025);
          return term?.stateCode === state.toUpperCase() &&
                 term?.chamber?.toLowerCase().includes(chamber.toLowerCase());
        })
        .map(m => ({
          bioguide_id: m.bioguideId, name: m.name,
          party: m.partyName, state: state.toUpperCase(),
        }));
    } catch (e) { return { error: e.message }; }
  },
 
  // ============================================================
  // FULL POLITICIAN LOAD
  // Usage: await AccountabilityAPI.loadPolitician('Jim Jordan', 'OH', 'H')
  // ============================================================
  async loadPolitician(name, state, officeCode = 'H') {
    const candidates = await this.searchCandidate(name, state, officeCode);
    if (candidates.error || !candidates.length) return { error: `Not found: ${name}` };
    const candidate = candidates[0];
 
    const committeeId = candidate.committees?.[0]?.id;
    const [totals, pacs, donors, enforcement] = await Promise.all([
      this.getCandidateTotals(candidate.fec_id),
      committeeId ? this.getTopPACs(committeeId) : [],
      committeeId ? this.getTopDonors(committeeId) : [],
      this.getFECEnforcement(candidate.name),
    ]);
 
    let memberProfile = null;
    if (officeCode === 'H' || officeCode === 'S') {
      const chamber = officeCode === 'H' ? 'House' : 'Senate';
      const stateMembers = await this.getMembersByState(state, chamber);
      if (!stateMembers.error) {
        const lastName = name.split(' ').pop().toUpperCase();
        const match = stateMembers.find(m => m.name?.toUpperCase().includes(lastName));
        if (match) memberProfile = await this.getCongressMember(match.bioguide_id);
      }
    }
 
    return {
      name: this.titleCase(candidate.name),
      party: candidate.party,
      state: this.stateFullName(candidate.state),
      office: candidate.office,
      fec_id: candidate.fec_id,
      total_raised: totals.total_receipts || 'N/A',
      pac_contributions: totals.pac_contributions || 'N/A',
      top_pacs: Array.isArray(pacs) ? pacs.slice(0, 5) : [],
      top_donors: Array.isArray(donors) ? donors.slice(0, 5) : [],
      fec_enforcement: enforcement,
      congress_profile: memberProfile,
      loaded_at: new Date().toISOString(),
    };
  },
 
  // ============================================================
  // RENDER LIVE CARD into app politicians array
  // ============================================================
  async renderLiveCard(name, state, officeCode = 'H') {
    const p = await this.loadPolitician(name, state, officeCode);
    if (p.error) { console.error(p.error); return null; }
    return {
      id: Date.now(),
      name: p.name,
      party: p.party === 'DEM' ? 'D' : p.party === 'REP' ? 'R' : 'I',
      state: p.state,
      office: p.office,
      level: ['H','S','P'].includes(officeCode) ? 'federal' : 'state',
      since: null,
      violations: p.fec_enforcement?.length || 0,
      totalDonors: p.total_raised,
      recallActive: false,
      threatScore: this.calcThreat(p),
      donors: [
        ...p.top_pacs.slice(0,3).map(d => ({ name:d.name, amount:d.total, industry:'PAC' })),
        ...p.top_donors.slice(0,2).map(d => ({ name:d.name, amount:d.total, industry:d.occupation||'Individual' })),
      ],
      violations_list: (p.fec_enforcement||[]).map(e => ({
        type: 'FEC Enforcement', desc: `Case ${e.case_id}`, date: 'Active',
      })),
      _live: p,
    };
  },
 
  // ============================================================
  // UTILITIES
  // ============================================================
  fmt(n) {
    if (n == null || isNaN(n)) return 'N/A';
    if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  },
  titleCase(s) {
    return (s||'').split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ');
  },
  calcThreat(p) {
    let s = 20;
    const pac = parseFloat((p.pac_contributions||'0').replace(/[$MK,]/g,''))||0;
    if (pac > 1) s += 30; else if (pac > 0.5) s += 20; else if (pac > 0.1) s += 10;
    if ((p.fec_enforcement?.length||0) > 0) s += 25;
    return Math.min(s, 99);
  },
  stateFullName(code) {
    const m={AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'};
    return m[code]||code;
  },
};
 
console.log('AccountabilityAPI loaded — proxying through Netlify Functions');
 
