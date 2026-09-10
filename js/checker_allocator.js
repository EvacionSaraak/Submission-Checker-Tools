(() => {
  const root = typeof window !== 'undefined' ? window : globalThis;
  const doc = typeof document !== 'undefined' ? document : null;

  const CLAIM_ID_CANDIDATES = ['Pri. Claim ID', 'Pri. Claim No', 'ClaimID', 'Claim ID'];
  const VISIT_ID_CANDIDATES = ['Visit Id', 'Visit ID', 'VisitID'];
  const CLAIM_DATE_CANDIDATES = ['Encounter Date', 'Claim Date', 'Report Date', 'Adm/Reg. Date', 'Date'];
  const DEPT_CANDIDATES = ['Admitting Department', 'Department', 'Clinic'];
  const FACILITY_CANDIDATES = ['Center Name', 'Centre Name', 'Facility ID', 'Facility Name', 'Facility', 'Center', 'Centre', 'Institution'];
  const CODIFICATION_STATUS_CANDIDATES = ['Codification Status', 'Codification_Status', 'CodificationStatus'];
  const PAYMENT_MODE_CANDIDATES = ['Pri. Payment Mode', 'Payment Mode', 'PaymentMode', 'Pri Payment Mode'];
  const CODIFIED_BY_CANDIDATES = ['Codified By', 'CodifiedBy', 'Codified_By', 'Coded By', 'CodedBy', 'Opened by', 'Opened By', 'Username'];
  const CODIF_REMARKS_CANDIDATES = ['Codification Remarks', 'CodificationRemarks', 'Codification_Remarks', 'Codif Remarks'];
  const HEADER_DETECTION_CANDIDATES = [
    ...CLAIM_ID_CANDIDATES,
    ...VISIT_ID_CANDIDATES,
    ...CLAIM_DATE_CANDIDATES,
    ...DEPT_CANDIDATES,
    ...FACILITY_CANDIDATES,
    ...CODIFICATION_STATUS_CANDIDATES,
    ...PAYMENT_MODE_CANDIDATES,
    ...CODIFIED_BY_CANDIDATES,
    ...CODIF_REMARKS_CANDIDATES
  ];
  const NO_BILLING_PATTERN = /no\s*bil|not\s+for\s+(billing|submission)|no\s+submission/i;
  const AUTO_EXCLUDED_STATUS_PATTERNS = [/^closed$/i, /^submitted$/i];
  const DEFAULT_DEPARTMENT_EXCLUSIONS = new Set(['Dental', 'Orthodontic']);
  const UNASSIGNED_CODER = '(Unassigned)';
  const UNKNOWN_FACILITY = 'Unknown Facility';
  const FACILITY_ALIASES = Object.freeze({
    IVORY: 'MF4456',
    KOREAN: 'MF5708',
    LAURETTA: 'MF4706',
    LAURETTE: 'MF4184',
    MAJESTIC: 'MF1901',
    NAZEK: 'MF5009',
    EXTRAMALL: 'MF5090',
    KHABISI: 'MF5020',
    ALYAHAR: 'MF5357',
    ALYAHER: 'MF5357',
    SCANDCARE: 'MF456',
    TALAT: 'MF494',
    TRUELIFE: 'MF7003',
    'TRUE LIFE': 'MF7003',
    ALWAGAN: 'MF7231',
    WLDY: 'MF5339'
  });

  const state = {
    presetsData: {},
    presetOptions: [],
    importedReports: [],
    rawClaims: [],
    dedupedClaims: [],
    duplicateGroups: [],
    importSummary: null,
    facilityConfigs: {},
    filterState: {
      paymentModes: new Set(),
      departments: new Set(),
      codifStatuses: new Set(),
      codifiedBy: new Set(),
      includeNoBills: false
    },
    lastAllocationResult: null
  };
  let presetsReady = Promise.resolve();

  function normalizeKey(value) {
    return String(value || '').toLowerCase().replace(/[\s.\-_]/g, '');
  }

  function normalizeLoose(value) {
    return String(value || '').toLowerCase().replace(/[\s.\-_,()]/g, '');
  }

  function normalizeStatus(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function normalizeClaimKey(value) {
    return String(value || '').trim().toUpperCase();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isNoBillingRemark(value) {
    return NO_BILLING_PATTERN.test(String(value || '').trim());
  }

  function isAutoExcludedStatus(value) {
    const normalized = normalizeStatus(value);
    return AUTO_EXCLUDED_STATUS_PATTERNS.some(pattern => pattern.test(normalized));
  }

  function getPaymentModeCategory(mode) {
    return /insur/i.test(String(mode || '')) ? 'insurance' : 'self_pay';
  }

  function toUtcDate(year, monthIndex, day) {
    const date = new Date(Date.UTC(year, monthIndex, day));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function parseDateValue(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return toUtcDate(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const epoch = Date.UTC(1899, 11, 30);
      const millis = epoch + Math.round(value * 86400000);
      const date = new Date(millis);
      return toUtcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    }

    const text = String(value).trim();
    if (!text) return null;

    let match = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (match) {
      return toUtcDate(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    }

    match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (match) {
      return toUtcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }

    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return toUtcDate(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
    }

    return null;
  }

  function formatDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
  }

  function formatToday() {
    return formatDate(parseDateValue(new Date()));
  }

  function findColumnKey(rows, candidates) {
    if (!rows.length) return null;
    const keys = Object.keys(rows[0]);

    for (const candidate of candidates) {
      const targetNorm = normalizeKey(candidate);
      for (const key of keys) {
        if (normalizeKey(key) === targetNorm) return key;
      }
    }

    for (const candidate of candidates) {
      const targetNorm = normalizeKey(candidate);
      for (const key of keys) {
        const keyNorm = normalizeKey(key);
        if (keyNorm.includes(targetNorm) || targetNorm.includes(keyNorm)) return key;
      }
    }

    return null;
  }

  function buildPresetIndex(presetsData) {
    const facilities = [];
    const licenseToPreset = new Map();
    const aliasToPreset = new Map();

    for (const [name, preset] of Object.entries(presetsData || {})) {
      if (name.startsWith('_')) continue;
      const entry = {
        name,
        normalizedName: normalizeLoose(name),
        license: String(preset.license || '').trim().toUpperCase(),
        coders: Array.isArray(preset.coders) ? preset.coders : []
      };
      facilities.push(entry);
      if (entry.license) {
        licenseToPreset.set(entry.license, entry.name);
      }
    }

    for (const [alias, license] of Object.entries(FACILITY_ALIASES)) {
      const presetName = licenseToPreset.get(String(license).toUpperCase());
      if (presetName) {
        aliasToPreset.set(normalizeLoose(alias), presetName);
      }
    }

    return { facilities, licenseToPreset, aliasToPreset };
  }

  function matchFacilityValue(value, presetIndex) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const upper = raw.toUpperCase();
    if (presetIndex.licenseToPreset.has(upper)) {
      const presetName = presetIndex.licenseToPreset.get(upper);
      return { presetName, displayName: presetName, matched: true, matchType: 'license', rawValue: raw };
    }

    const normalized = normalizeLoose(raw);
    if (!normalized) return null;

    if (presetIndex.aliasToPreset.has(normalized)) {
      const presetName = presetIndex.aliasToPreset.get(normalized);
      return { presetName, displayName: presetName, matched: true, matchType: 'alias', rawValue: raw };
    }

    for (const facility of presetIndex.facilities) {
      if (
        facility.normalizedName === normalized ||
        facility.normalizedName.includes(normalized) ||
        normalized.includes(facility.normalizedName)
      ) {
        return { presetName: facility.name, displayName: facility.name, matched: true, matchType: 'name', rawValue: raw };
      }
    }

    for (const [alias, presetName] of presetIndex.aliasToPreset.entries()) {
      if (normalized.includes(alias) || alias.includes(normalized)) {
        return { presetName, displayName: presetName, matched: true, matchType: 'alias', rawValue: raw };
      }
    }

    return null;
  }

  function getFacilityOutputName(claim, facilityConfigs = state.facilityConfigs) {
    const config = facilityConfigs[claim.facilityKey];
    return (config && config.presetName) || claim.facilityDisplay || claim.facilityKey || UNKNOWN_FACILITY;
  }

  function findHeaderRow(sheetRows, maxScan = 10) {
    let bestIndex = -1;
    let bestScore = -1;

    for (let i = 0; i < Math.min(sheetRows.length, maxScan); i++) {
      const row = Array.isArray(sheetRows[i]) ? sheetRows[i] : [];
      const normalizedRow = row.map(cell => normalizeKey(cell));
      let score = 0;
      for (const candidate of HEADER_DETECTION_CANDIDATES) {
        const candidateNorm = normalizeKey(candidate);
        if (normalizedRow.some(cell => cell && (cell === candidateNorm || cell.includes(candidateNorm)))) {
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    return bestScore > 0 ? bestIndex : (sheetRows.length > 1 ? 1 : 0);
  }

  function sheetToObjects(sheetRows) {
    if (!Array.isArray(sheetRows) || !sheetRows.length) return [];
    const headerRowIndex = findHeaderRow(sheetRows);
    const headerRow = (sheetRows[headerRowIndex] || []).map(cell => String(cell == null ? '' : cell).trim());
    const dataRows = sheetRows.slice(headerRowIndex + 1);

    return dataRows
      .map(row => {
        const obj = {};
        headerRow.forEach((header, index) => {
          if (!header) return;
          obj[header] = row && row[index] != null ? row[index] : '';
        });
        return obj;
      })
      .filter(obj => Object.values(obj).some(value => String(value || '').trim() !== ''));
  }

  function getCoderEntriesForPreset(name) {
    const preset = state.presetsData[name];
    return preset && Array.isArray(preset.coders) ? preset.coders : [];
  }

  function buildRestrictionsMap(coderEntries) {
    const restrictions = {};
    for (const coder of coderEntries) {
      if (coder && typeof coder === 'object' && coder.name && Array.isArray(coder.departments) && coder.departments.length) {
        restrictions[coder.name] = new Set(coder.departments.map(item => String(item || '').trim()).filter(Boolean));
      }
    }
    return restrictions;
  }

  function createFacilityConfig(facilityName, presetName) {
    const coderEntries = getCoderEntriesForPreset(presetName);
    return {
      presetName: presetName || '',
      codersText: coderEntries.map(coder => (typeof coder === 'string' ? coder : coder.name)).filter(Boolean).join('\n'),
      restrictions: buildRestrictionsMap(coderEntries)
    };
  }

  function collectColumnKeys(rows) {
    return {
      claimId: findColumnKey(rows, CLAIM_ID_CANDIDATES),
      visitId: findColumnKey(rows, VISIT_ID_CANDIDATES),
      claimDate: findColumnKey(rows, CLAIM_DATE_CANDIDATES),
      department: findColumnKey(rows, DEPT_CANDIDATES),
      facilityKeys: FACILITY_CANDIDATES.map(candidate => findColumnKey(rows, [candidate])).filter(Boolean),
      codificationStatus: findColumnKey(rows, CODIFICATION_STATUS_CANDIDATES),
      paymentMode: findColumnKey(rows, PAYMENT_MODE_CANDIDATES),
      codifiedBy: findColumnKey(rows, CODIFIED_BY_CANDIDATES),
      codifRemarks: findColumnKey(rows, CODIF_REMARKS_CANDIDATES)
    };
  }

  function normalizeRawClaims(reports, presetsData) {
    const presetIndex = buildPresetIndex(presetsData);
    const claims = [];

    for (const report of reports) {
      const keys = collectColumnKeys(report.rows);
      for (let rowIndex = 0; rowIndex < report.rows.length; rowIndex++) {
        const row = report.rows[rowIndex];
        const claimIdRaw = keys.claimId ? row[keys.claimId] : '';
        const visitIdRaw = keys.visitId ? row[keys.visitId] : '';
        const claimId = String(claimIdRaw || '').trim();
        const visitId = String(visitIdRaw || '').trim();
        if (!claimId && !visitId) continue;

        const facilityMatches = [];
        for (const key of keys.facilityKeys) {
          const value = String(row[key] || '').trim();
          if (!value) continue;
          const match = matchFacilityValue(value, presetIndex);
          if (match) facilityMatches.push(match);
          else facilityMatches.push({ presetName: '', displayName: value, matched: false, matchType: 'raw', rawValue: value });
        }

        let facilityMatch = facilityMatches.find(item => item.matched) || null;
        if (!facilityMatch) {
          facilityMatch = matchFacilityValue(report.fileName, presetIndex);
        }
        if (!facilityMatch) {
          const rawFacility = facilityMatches.find(Boolean);
          facilityMatch = rawFacility || { presetName: '', displayName: UNKNOWN_FACILITY, matched: false, matchType: 'unknown', rawValue: '' };
        }

        const claimDateValue = keys.claimDate ? parseDateValue(row[keys.claimDate]) : null;
        const department = keys.department ? String(row[keys.department] || '').trim() : '';
        const statusRaw = keys.codificationStatus ? String(row[keys.codificationStatus] || '').trim() : '';
        const paymentMode = keys.paymentMode ? String(row[keys.paymentMode] || '').trim() : '';
        const codifiedBy = keys.codifiedBy ? String(row[keys.codifiedBy] || '').trim() : '';
        const codifRemarks = keys.codifRemarks ? String(row[keys.codifRemarks] || '').trim() : '';
        const outputClaimId = claimId || visitId;
        const dedupeKeyId = normalizeClaimKey(claimId || visitId);
        const facilityKey = facilityMatch.presetName || facilityMatch.displayName || UNKNOWN_FACILITY;

        claims.push({
          sourceFile: report.fileName,
          sourceRowNumber: rowIndex + 1,
          claimId,
          visitId,
          outputClaimId,
          dedupeKey: `${normalizeLoose(facilityKey)}::${dedupeKeyId}`,
          facilityKey,
          facilityDisplay: facilityMatch.displayName || UNKNOWN_FACILITY,
          detectedPresetName: facilityMatch.presetName || '',
          facilityMatched: Boolean(facilityMatch.matched),
          facilityMatchType: facilityMatch.matchType,
          claimDate: claimDateValue,
          claimDateText: claimDateValue ? formatDate(claimDateValue) : String(keys.claimDate ? row[keys.claimDate] || '' : '').trim(),
          department,
          codificationStatus: statusRaw,
          codificationStatusNormalized: normalizeStatus(statusRaw),
          paymentMode,
          paymentModeCategory: getPaymentModeCategory(paymentMode),
          codifiedBy,
          codifRemarks,
          noBill: isNoBillingRemark(codifRemarks),
          autoExcludedStatus: isAutoExcludedStatus(statusRaw),
          rawFieldCount: Object.values(row).filter(value => String(value || '').trim() !== '').length
        });
      }
    }

    return claims;
  }

  function chooseRepresentativeClaim(claims) {
    return claims
      .slice()
      .sort((a, b) => {
        const scoreA = (a.facilityMatched ? 10 : 0) + (a.claimDate ? 5 : 0) + (a.department ? 2 : 0) + a.rawFieldCount;
        const scoreB = (b.facilityMatched ? 10 : 0) + (b.claimDate ? 5 : 0) + (b.department ? 2 : 0) + b.rawFieldCount;
        if (scoreB !== scoreA) return scoreB - scoreA;
        if (a.claimDate && b.claimDate) return a.claimDate - b.claimDate;
        if (a.claimDate) return -1;
        if (b.claimDate) return 1;
        return a.sourceRowNumber - b.sourceRowNumber;
      })[0];
  }

  function deduplicateClaims(rawClaims) {
    const grouped = new Map();
    for (const claim of rawClaims) {
      if (!grouped.has(claim.dedupeKey)) grouped.set(claim.dedupeKey, []);
      grouped.get(claim.dedupeKey).push(claim);
    }

    const dedupedClaims = [];
    const duplicateGroups = [];
    let duplicateClaimsResolved = 0;
    let closedSubmittedExcluded = 0;

    for (const claims of grouped.values()) {
      const representative = chooseRepresentativeClaim(claims);
      const duplicateCount = Math.max(0, claims.length - 1);
      duplicateClaimsResolved += duplicateCount;
      const terminal = claims.some(claim => claim.autoExcludedStatus);
      const aggregatedClaim = {
        ...representative,
        claimDate: claims.map(claim => claim.claimDate).filter(Boolean).sort((a, b) => a - b)[0] || representative.claimDate || null,
        claimDateText: '',
        codificationStatus: representative.codificationStatus,
        paymentMode: representative.paymentMode,
        codifiedByValues: Array.from(new Set(claims.map(claim => claim.codifiedBy).filter(Boolean))),
        noBill: claims.some(claim => claim.noBill),
        duplicateCount,
        versions: claims.length,
        autoExcludedStatus: terminal,
        duplicateReasons: claims.map(claim => claim.codificationStatus).filter(Boolean)
      };
      aggregatedClaim.claimDateText = aggregatedClaim.claimDate ? formatDate(aggregatedClaim.claimDate) : representative.claimDateText;
      duplicateGroups.push(aggregatedClaim);
      if (terminal) {
        closedSubmittedExcluded++;
        continue;
      }
      dedupedClaims.push(aggregatedClaim);
    }

    dedupedClaims.sort((a, b) => {
      if (a.claimDate && b.claimDate) return a.claimDate - b.claimDate;
      if (a.claimDate) return -1;
      if (b.claimDate) return 1;
      return a.outputClaimId.localeCompare(b.outputClaimId);
    });

    return {
      dedupedClaims,
      duplicateGroups,
      stats: {
        totalClaimsRead: rawClaims.length,
        duplicateClaimsResolved,
        closedSubmittedExcluded
      }
    };
  }

  function countBy(items, selector) {
    const counts = new Map();
    for (const item of items) {
      const key = selector(item);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  function collectFilterOptions(claims) {
    return {
      paymentModes: Array.from(countBy(claims, claim => claim.paymentMode).entries()).sort((a, b) => a[0].localeCompare(b[0])),
      departments: Array.from(countBy(claims, claim => claim.department).entries()).sort((a, b) => a[0].localeCompare(b[0])),
      codifStatuses: Array.from(countBy(claims, claim => claim.codificationStatus).entries()).sort((a, b) => a[0].localeCompare(b[0])),
      codifiedBy: Array.from(countBy(claims.flatMap(claim => claim.codifiedByValues || []), value => value).entries()).sort((a, b) => a[0].localeCompare(b[0]))
    };
  }

  function initializeFilterState(claims) {
    const options = collectFilterOptions(claims);
    state.filterState.paymentModes = new Set(options.paymentModes.map(([value]) => value));
    state.filterState.departments = new Set(options.departments.map(([value]) => value).filter(value => !DEFAULT_DEPARTMENT_EXCLUSIONS.has(value)));
    state.filterState.codifStatuses = new Set(options.codifStatuses.map(([value]) => value));
    state.filterState.codifiedBy = new Set(options.codifiedBy.map(([value]) => value));
    state.filterState.includeNoBills = false;
  }

  function applyClaimFilters(claims, filterState) {
    const paymentFiltered = claims.filter(claim => !claim.paymentMode || filterState.paymentModes.has(claim.paymentMode));
    const departmentFiltered = paymentFiltered.filter(claim => !claim.department || filterState.departments.has(claim.department));
    const statusFiltered = departmentFiltered.filter(claim => !claim.codificationStatus || filterState.codifStatuses.has(claim.codificationStatus));
    const codifiedFiltered = statusFiltered.filter(claim => !claim.codifiedByValues.some(value => filterState.codifiedBy.has(value)));
    const noBillExcluded = codifiedFiltered.filter(claim => claim.noBill).length;
    const eligibleClaims = filterState.includeNoBills ? codifiedFiltered : codifiedFiltered.filter(claim => !claim.noBill);

    return {
      paymentFiltered,
      departmentFiltered,
      statusFiltered,
      codifiedFiltered,
      eligibleClaims,
      noBillExcluded
    };
  }

  function getFacilityClaimStats(claims) {
    const map = new Map();
    for (const claim of claims) {
      const key = claim.facilityKey;
      if (!map.has(key)) {
        map.set(key, { facilityKey: key, displayName: claim.facilityDisplay || key, count: 0, presetName: claim.detectedPresetName || '' });
      }
      const entry = map.get(key);
      entry.count++;
      if (!entry.presetName && claim.detectedPresetName) entry.presetName = claim.detectedPresetName;
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName));
  }

  function buildImportSummary() {
    const filtered = applyClaimFilters(state.dedupedClaims, state.filterState);
    const facilitiesFound = new Set(state.duplicateGroups.map(claim => claim.facilityKey)).size;
    return {
      reportsLoaded: state.importedReports.length,
      rowsDetected: state.importedReports.reduce((sum, report) => sum + report.rows.length, 0),
      totalClaimsRead: state.importSummary ? state.importSummary.totalClaimsRead : 0,
      facilitiesFound,
      duplicateClaimsResolved: state.importSummary ? state.importSummary.duplicateClaimsResolved : 0,
      closedSubmittedExcluded: state.importSummary ? state.importSummary.closedSubmittedExcluded : 0,
      noBillExcluded: filtered.noBillExcluded,
      eligibleClaims: filtered.eligibleClaims.length,
      automaticallyExcluded: (state.importSummary ? state.importSummary.closedSubmittedExcluded : 0) + filtered.noBillExcluded
    };
  }

  function parseCodersText(codersText) {
    return Array.from(new Set(
      String(codersText || '')
        .split(/\r?\n/)
        .map(value => value.trim())
        .filter(Boolean)
    ));
  }

  function getEligibleCoders(claim, facilityConfigs) {
    const config = facilityConfigs[claim.facilityKey] || createFacilityConfig(claim.facilityKey, claim.detectedPresetName);
    const coders = parseCodersText(config.codersText);
    return coders.filter(coder => {
      const restrictions = config.restrictions[coder];
      return !restrictions || restrictions.has(claim.department);
    });
  }

  function allocateClaims(claims, facilityConfigs, allocationDateText) {
    const workload = {};
    const tieBreakers = {};
    const allocationRows = [];

    for (const claim of claims) {
      const facilityName = getFacilityOutputName(claim, facilityConfigs);
      const eligibleCoders = getEligibleCoders(claim, facilityConfigs);
      let coder = UNASSIGNED_CODER;

      if (eligibleCoders.length) {
        const minLoad = Math.min(...eligibleCoders.map(name => workload[name] || 0));
        const tied = eligibleCoders.filter(name => (workload[name] || 0) === minLoad);
        const tieKey = tied.join('|');
        const tieIndex = tieBreakers[tieKey] || 0;
        coder = tied[tieIndex % tied.length];
        tieBreakers[tieKey] = tieIndex + 1;
        workload[coder] = (workload[coder] || 0) + 1;
      }

      allocationRows.push({
        Facility: facilityName,
        'Claim ID': claim.outputClaimId,
        'Claim Date': claim.claimDate,
        ClaimDateText: claim.claimDateText,
        Department: claim.department,
        Coder: coder,
        'Date Assigned': allocationDateText,
        Query: '',
        Status: ''
      });
    }

    return { allocationRows, workload };
  }

  function buildAllocationSummary(allocationRows) {
    const coderSummary = new Map();
    const facilitySummary = new Map();
    const departmentSummary = new Map();

    for (const row of allocationRows) {
      const isAssigned = row.Coder !== UNASSIGNED_CODER;
      if (!coderSummary.has(row.Coder)) {
        coderSummary.set(row.Coder, { Coder: row.Coder, 'Total Assigned': 0, 'Oldest Claim Date': '', 'Newest Claim Date': '' });
      }
      if (isAssigned) {
        const coder = coderSummary.get(row.Coder);
        coder['Total Assigned']++;
        if (row['Claim Date']) {
          const formatted = formatDate(row['Claim Date']);
          if (!coder._oldest || row['Claim Date'] < coder._oldest) coder._oldest = row['Claim Date'];
          if (!coder._newest || row['Claim Date'] > coder._newest) coder._newest = row['Claim Date'];
          coder['Oldest Claim Date'] = formatDate(coder._oldest || row['Claim Date']) || formatted;
          coder['Newest Claim Date'] = formatDate(coder._newest || row['Claim Date']) || formatted;
        }
      }

      if (!facilitySummary.has(row.Facility)) {
        facilitySummary.set(row.Facility, { Facility: row.Facility, Allocated: 0, Unassigned: 0 });
      }
      facilitySummary.get(row.Facility)[isAssigned ? 'Allocated' : 'Unassigned']++;

      const deptKey = row.Department || '(Blank)';
      if (!departmentSummary.has(deptKey)) {
        departmentSummary.set(deptKey, { Department: deptKey, Allocated: 0, Unassigned: 0 });
      }
      departmentSummary.get(deptKey)[isAssigned ? 'Allocated' : 'Unassigned']++;
    }

    const coderRows = Array.from(coderSummary.values())
      .map(row => ({
        Coder: row.Coder,
        'Total Assigned': row['Total Assigned'],
        'Oldest Claim Date': row['Oldest Claim Date'],
        'Newest Claim Date': row['Newest Claim Date']
      }))
      .sort((a, b) => {
        if (a.Coder === UNASSIGNED_CODER) return 1;
        if (b.Coder === UNASSIGNED_CODER) return -1;
        return a.Coder.localeCompare(b.Coder);
      });

    return {
      coderRows,
      facilityAssignedRows: Array.from(facilitySummary.values()).sort((a, b) => a.Facility.localeCompare(b.Facility)),
      departmentAssignedRows: Array.from(departmentSummary.values()).sort((a, b) => a.Department.localeCompare(b.Department))
    };
  }

  function buildFacilityMatrix(allocationRows, coderRows) {
    const facilities = Array.from(new Set(allocationRows.map(row => row.Facility))).sort((a, b) => a.localeCompare(b));
    const matrixRows = coderRows
      .filter(row => row.Coder !== UNASSIGNED_CODER)
      .map(coderRow => {
        const row = { Coder: coderRow.Coder };
        let total = 0;
        for (const facility of facilities) {
          const count = allocationRows.filter(item => item.Coder === coderRow.Coder && item.Facility === facility).length;
          row[facility] = count;
          total += count;
        }
        row.Total = total;
        return row;
      });
    return { facilities, matrixRows };
  }

  function buildSummarySheetData(importStats, filteredClaims, allocationRows) {
    const allocationSummary = buildAllocationSummary(allocationRows);
    const matrix = buildFacilityMatrix(allocationRows, allocationSummary.coderRows);
    const facilityFiltered = new Map();
    const departmentFiltered = new Map();

    for (const claim of state.duplicateGroups) {
      if (!facilityFiltered.has(claim.facilityKey)) {
        facilityFiltered.set(claim.facilityKey, { Facility: getFacilityOutputName(claim, state.facilityConfigs), 'Claims Loaded': 0, 'Closed/Submitted Excluded': 0, Eligible: 0, Allocated: 0, Unassigned: 0 });
      }
      facilityFiltered.get(claim.facilityKey)['Claims Loaded']++;
      if (claim.autoExcludedStatus) {
        facilityFiltered.get(claim.facilityKey)['Closed/Submitted Excluded']++;
      }
    }
    for (const claim of filteredClaims) {
      if (!facilityFiltered.has(claim.facilityKey)) {
        facilityFiltered.set(claim.facilityKey, { Facility: getFacilityOutputName(claim, state.facilityConfigs), 'Claims Loaded': 0, 'Closed/Submitted Excluded': 0, Eligible: 0, Allocated: 0, Unassigned: 0 });
      }
      facilityFiltered.get(claim.facilityKey).Eligible++;
      const deptKey = claim.department || '(Blank)';
      if (!departmentFiltered.has(deptKey)) {
        departmentFiltered.set(deptKey, { Department: deptKey, Eligible: 0, Allocated: 0, Unassigned: 0 });
      }
      departmentFiltered.get(deptKey).Eligible++;
    }
    for (const row of allocationRows) {
      const facilityRow = Array.from(facilityFiltered.values()).find(item => item.Facility === row.Facility);
      if (facilityRow) facilityRow[row.Coder === UNASSIGNED_CODER ? 'Unassigned' : 'Allocated']++;
      const deptKey = row.Department || '(Blank)';
      if (!departmentFiltered.has(deptKey)) {
        departmentFiltered.set(deptKey, { Department: deptKey, Eligible: 0, Allocated: 0, Unassigned: 0 });
      }
      departmentFiltered.get(deptKey)[row.Coder === UNASSIGNED_CODER ? 'Unassigned' : 'Allocated']++;
    }

    return {
      overviewRows: [
        ['Reports Loaded', importStats.reportsLoaded],
        ['Facilities Found', importStats.facilitiesFound],
        ['Total Claims Read', state.importSummary.totalClaimsRead],
        ['Duplicate Claims Resolved', state.importSummary.duplicateClaimsResolved],
        ['Closed/Submitted Excluded', state.importSummary.closedSubmittedExcluded],
        ['No-Bill Excluded', importStats.noBillExcluded],
        ['Eligible Claims', filteredClaims.length],
        ['Allocated Claims', allocationRows.filter(row => row.Coder !== UNASSIGNED_CODER).length],
        ['Unassigned Claims', allocationRows.filter(row => row.Coder === UNASSIGNED_CODER).length]
      ],
      coderRows: allocationSummary.coderRows,
      matrixHeaders: ['Coder', ...matrix.facilities, 'Total'],
      matrixRows: matrix.matrixRows,
      facilityRows: Array.from(facilityFiltered.values()).sort((a, b) => a.Facility.localeCompare(b.Facility)),
      departmentRows: Array.from(departmentFiltered.values()).sort((a, b) => a.Department.localeCompare(b.Department))
    };
  }

  function autoSizeColumns(headers, rows) {
    return headers.map(header => {
      const width = Math.max(
        String(header).length,
        ...rows.map(row => String(row[header] == null ? '' : row[header]).length)
      );
      return { wch: Math.min(Math.max(width + 2, 12), 30) };
    });
  }

  function applyWorksheetChrome(ws, rangeRef) {
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    ws['!panes'] = [{ ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' }];
    ws['!autofilter'] = { ref: rangeRef };
  }

  function jsonRowsToWorksheet(headers, rows, dateHeaders = new Set()) {
    const aoa = [headers, ...rows.map(row => headers.map(header => {
      if (dateHeaders.has(header) && row[header] instanceof Date) return row[header];
      return row[header] == null ? '' : row[header];
    }))];
    const ws = root.XLSX.utils.aoa_to_sheet(aoa);
    const rangeRef = root.XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: headers.length - 1, r: Math.max(rows.length, 1) } });
    applyWorksheetChrome(ws, rangeRef);
    ws['!cols'] = autoSizeColumns(headers, rows.map(row => {
      const printable = {};
      headers.forEach(header => {
        printable[header] = dateHeaders.has(header) && row[header] instanceof Date ? formatDate(row[header]) : row[header];
      });
      return printable;
    }));

    rows.forEach((row, rowIndex) => {
      headers.forEach((header, colIndex) => {
        if (!dateHeaders.has(header)) return;
        const cellRef = root.XLSX.utils.encode_cell({ r: rowIndex + 1, c: colIndex });
        if (ws[cellRef]) ws[cellRef].z = 'dd/mm/yyyy';
      });
    });

    return ws;
  }

  function buildWorkbook(lastAllocationResult) {
    const wb = root.XLSX.utils.book_new();
    const summaryData = buildSummarySheetData(lastAllocationResult.importStats, lastAllocationResult.filteredClaims, lastAllocationResult.allocationRows);

    const summaryAoA = [];
    summaryAoA.push(['Allocation Run Summary']);
    summaryAoA.push([]);
    summaryAoA.push(['Metric', 'Value']);
    summaryAoA.push(...summaryData.overviewRows);
    summaryAoA.push([]);
    summaryAoA.push(['Coder', 'Total Assigned', 'Oldest Claim Date', 'Newest Claim Date']);
    summaryAoA.push(...summaryData.coderRows.map(row => [row.Coder, row['Total Assigned'], row['Oldest Claim Date'], row['Newest Claim Date']]));
    summaryAoA.push([]);
    summaryAoA.push(summaryData.matrixHeaders);
    summaryAoA.push(...summaryData.matrixRows.map(row => summaryData.matrixHeaders.map(header => row[header] ?? '')));
    summaryAoA.push([]);
    summaryAoA.push(['Facility', 'Claims Loaded', 'Closed/Submitted Excluded', 'Eligible', 'Allocated', 'Unassigned']);
    summaryAoA.push(...summaryData.facilityRows.map(row => [row.Facility, row['Claims Loaded'], row['Closed/Submitted Excluded'], row.Eligible, row.Allocated, row.Unassigned]));
    summaryAoA.push([]);
    summaryAoA.push(['Department', 'Eligible', 'Allocated', 'Unassigned']);
    summaryAoA.push(...summaryData.departmentRows.map(row => [row.Department, row.Eligible, row.Allocated, row.Unassigned]));

    const wsSummary = root.XLSX.utils.aoa_to_sheet(summaryAoA);
    wsSummary['!cols'] = [
      { wch: 28 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }
    ];
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    const allocationHeaders = ['Facility', 'Claim ID', 'Claim Date', 'Department', 'Coder', 'Date Assigned', 'Query', 'Status'];
    const wsAllocation = jsonRowsToWorksheet(
      allocationHeaders,
      lastAllocationResult.allocationRows.map(row => ({
        Facility: row.Facility,
        'Claim ID': row['Claim ID'],
        'Claim Date': row['Claim Date'],
        Department: row.Department,
        Coder: row.Coder,
        'Date Assigned': lastAllocationResult.allocationDate,
        Query: row.Query,
        Status: row.Status
      })),
      new Set(['Claim Date'])
    );
    XLSX.utils.book_append_sheet(wb, wsAllocation, 'Allocation');

    return wb;
  }

  function renderSummaryCards(importStats) {
    const importSummary = getEl('import-summary');
    if (!importSummary) return;
    const cards = [
      ['Reports Loaded', importStats.reportsLoaded],
      ['Rows Detected', importStats.rowsDetected],
      ['Facilities Found', importStats.facilitiesFound],
      ['Eligible Claims', importStats.eligibleClaims],
      ['Duplicate Claims Resolved', importStats.duplicateClaimsResolved],
      ['Automatically Excluded', importStats.automaticallyExcluded]
    ];
    importSummary.innerHTML = cards.map(([label, value]) => `
      <div class="summary-card">
        <span class="label">${escapeHtml(label)}</span>
        <span class="value">${escapeHtml(value)}</span>
      </div>
    `).join('');
  }

  function renderFacilitySummary() {
    const container = getEl('facility-summary-list');
    const configsContainer = getEl('facility-configs');
    if (!container || !configsContainer) return;

    const facilityStats = getFacilityClaimStats(state.dedupedClaims);
    container.innerHTML = facilityStats.map(item => {
      const config = state.facilityConfigs[item.facilityKey] || createFacilityConfig(item.facilityKey, item.presetName);
      const presetName = config.presetName || item.presetName;
      const statusClass = presetName ? 'status-ok' : 'status-bad';
      const statusText = presetName ? 'preset found' : 'needs attention';
      const displayName = presetName || item.displayName;
      return `
        <div class="facility-summary-item">
          <div class="fw-semibold">${escapeHtml(displayName)} — ${item.count} claims — <span class="${statusClass}">${statusText}</span></div>
          <div class="meta">Detected from ${escapeHtml(item.displayName)}</div>
        </div>
      `;
    }).join('');

    configsContainer.innerHTML = facilityStats.map(item => {
      const config = state.facilityConfigs[item.facilityKey] || createFacilityConfig(item.facilityKey, item.presetName);
      const presetName = config.presetName || '';
      const displayName = presetName || item.displayName;
      const restrictedCount = Object.keys(config.restrictions || {}).length;
      return `
        <details class="facility-config-card" data-facility-key="${escapeHtml(item.facilityKey)}">
          <summary>${escapeHtml(displayName)} — ${item.count} claims</summary>
          <div class="facility-config-body">
            <div class="facility-config-meta mb-2">Review only if this facility needs different coders or a different preset.</div>
            <div class="mb-3">
              <label class="form-label fw-bold small mb-1">Preset</label>
              <select class="form-select form-select-sm facility-preset-select" data-facility-key="${escapeHtml(item.facilityKey)}">
                <option value="">-- None --</option>
                ${state.presetOptions.map(name => `<option value="${escapeHtml(name)}" ${name === presetName ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
              </select>
            </div>
            <div class="mb-2">
              <label class="form-label fw-bold small mb-1">Coders <span class="fw-normal text-muted">(one per line)</span></label>
              <textarea class="form-control form-control-sm facility-coders-textarea" rows="5" data-facility-key="${escapeHtml(item.facilityKey)}" placeholder="Enter coder names, one per line">${escapeHtml(config.codersText || '')}</textarea>
            </div>
            <div class="facility-config-meta">${restrictedCount ? `${restrictedCount} coder restriction set(s) active from preset.` : 'No preset department restrictions active.'}</div>
          </div>
        </details>
      `;
    }).join('');
  }

  function countEntries(entries) {
    const counts = {};
    for (const entry of entries) {
      counts[entry] = (counts[entry] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  }

  function createCheckItems(container, items, selectedValues, defaultChecked = true) {
    if (!container) return;
    if (!items.length) {
      container.textContent = 'No values found.';
      return;
    }
    container.innerHTML = items.map(([value, count]) => {
      const checked = selectedValues.size ? selectedValues.has(value) : defaultChecked;
      return `
        <div class="form-check">
          <input class="form-check-input" type="checkbox" value="${escapeHtml(value)}" ${checked ? 'checked' : ''}>
          <label class="form-check-label">(${count}) ${escapeHtml(value)}</label>
        </div>
      `;
    }).join('');
  }

  function refreshFilterOptions() {
    const paymentContainer = getEl('payment-mode-section');
    const deptContainer = getEl('dept-section');
    const statusContainer = getEl('codif-status-section');
    const codifiedByContainer = getEl('codified-by-section');
    const noBillLabel = getEl('no-bill-count-label');

    const paymentCounts = countEntries(state.dedupedClaims.map(claim => claim.paymentMode).filter(Boolean));
    const paymentFiltered = state.dedupedClaims.filter(claim => !claim.paymentMode || state.filterState.paymentModes.has(claim.paymentMode));
    const departmentCounts = countEntries(paymentFiltered.map(claim => claim.department).filter(Boolean));
    const departmentFiltered = paymentFiltered.filter(claim => !claim.department || state.filterState.departments.has(claim.department));
    const statusCounts = countEntries(departmentFiltered.map(claim => claim.codificationStatus).filter(Boolean));
    const statusFiltered = departmentFiltered.filter(claim => !claim.codificationStatus || state.filterState.codifStatuses.has(claim.codificationStatus));
    const codifiedByCounts = countEntries(statusFiltered.flatMap(claim => claim.codifiedByValues || []).filter(Boolean));

    createCheckItems(paymentContainer, paymentCounts, state.filterState.paymentModes, true);
    createCheckItems(deptContainer, departmentCounts, state.filterState.departments, false);
    createCheckItems(statusContainer, statusCounts, state.filterState.codifStatuses, true);
    createCheckItems(codifiedByContainer, codifiedByCounts, state.filterState.codifiedBy, true);

    if (noBillLabel) {
      noBillLabel.textContent = `No Bills: ${statusFiltered.filter(claim => claim.noBill).length}`;
    }
    const includeNoBill = getEl('include-no-bill-cb');
    if (includeNoBill) includeNoBill.checked = state.filterState.includeNoBills;
  }

  function syncFilterStateFromDom() {
    state.filterState.paymentModes = new Set(Array.from(getEl('payment-mode-section')?.querySelectorAll('input:checked') || []).map(input => input.value));
    state.filterState.departments = new Set(Array.from(getEl('dept-section')?.querySelectorAll('input:checked') || []).map(input => input.value));
    state.filterState.codifStatuses = new Set(Array.from(getEl('codif-status-section')?.querySelectorAll('input:checked') || []).map(input => input.value));
    state.filterState.codifiedBy = new Set(Array.from(getEl('codified-by-section')?.querySelectorAll('input:checked') || []).map(input => input.value));
    state.filterState.includeNoBills = Boolean(getEl('include-no-bill-cb')?.checked);
  }

  function renderPreAllocationState() {
    if (!state.importedReports.length) return;
    const importStats = buildImportSummary();
    renderSummaryCards(importStats);
    renderFacilitySummary();
    refreshFilterOptions();
    renderSummaryPanel(importStats);
    state.lastAllocationResult = null;
    if (getEl('download-btn')) getEl('download-btn').disabled = true;
  }

  function renderSummaryPanel(importStats, allocationSummary) {
    const container = getEl('coder-summary');
    if (!container) return;

    if (!allocationSummary) {
      container.innerHTML = `
        <div class="summary-block p-3">
          <div class="fw-semibold mb-1">Ready to allocate</div>
          <div class="summary-muted">${importStats.reportsLoaded} reports loaded · ${importStats.eligibleClaims} eligible claims · ${importStats.automaticallyExcluded} automatically excluded.</div>
        </div>
      `;
      return;
    }

    const rows = allocationSummary.coderRows.map(row => `
      <tr>
        <td>${escapeHtml(row.Coder)}</td>
        <td>${escapeHtml(row['Total Assigned'])}</td>
        <td>${escapeHtml(row['Oldest Claim Date'])}</td>
        <td>${escapeHtml(row['Newest Claim Date'])}</td>
      </tr>
    `).join('');

    container.innerHTML = `
      <div class="summary-block p-3">
        <div class="fw-semibold mb-1">Allocation complete</div>
        <div class="summary-muted mb-3">Allocated: ${allocationSummary.allocatedCount} · Unassigned: ${allocationSummary.unassignedCount}</div>
        <div class="preview-table-wrap" style="max-height:260px;">
          <table class="preview-table">
            <thead>
              <tr><th>Coder</th><th>Total Assigned</th><th>Oldest Claim Date</th><th>Newest Claim Date</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderPreviewTable(allocationRows, importStats) {
    const container = getEl('allocation-preview');
    if (!container) return;
    if (!allocationRows.length) {
      container.classList.add('preview-empty');
      container.textContent = 'No claims matched the current filters.';
      return;
    }

    container.classList.remove('preview-empty');
    const summary = buildAllocationSummary(allocationRows);
    const rows = allocationRows.map(row => `
      <tr>
        <td>${escapeHtml(row.Facility)}</td>
        <td>${escapeHtml(row['Claim ID'])}</td>
        <td>${escapeHtml(row.ClaimDateText)}</td>
        <td>${escapeHtml(row.Department)}</td>
        <td>${escapeHtml(row.Coder)}</td>
        <td>${escapeHtml(row['Date Assigned'])}</td>
        <td>${escapeHtml(row.Query)}</td>
        <td>${escapeHtml(row.Status)}</td>
      </tr>
    `).join('');

    container.innerHTML = `
      <section class="preview-section">
        <h2 class="section-title">Allocation Preview</h2>
        <div class="summary-grid mb-3">
          <div class="summary-card"><span class="label">Eligible Claims</span><span class="value">${importStats.eligibleClaims}</span></div>
          <div class="summary-card"><span class="label">Allocated Claims</span><span class="value">${allocationRows.filter(row => row.Coder !== UNASSIGNED_CODER).length}</span></div>
          <div class="summary-card"><span class="label">Unassigned Claims</span><span class="value">${allocationRows.filter(row => row.Coder === UNASSIGNED_CODER).length}</span></div>
          <div class="summary-card"><span class="label">Facilities</span><span class="value">${new Set(allocationRows.map(row => row.Facility)).size}</span></div>
        </div>
      </section>
      <section class="preview-section">
        <div class="preview-table-wrap">
          <table class="preview-table">
            <thead>
              <tr>
                <th>Facility</th>
                <th>Claim ID</th>
                <th>Claim Date</th>
                <th>Department</th>
                <th>Coder</th>
                <th>Date Assigned</th>
                <th>Query</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>
    `;

    renderSummaryPanel(importStats, {
      coderRows: summary.coderRows,
      allocatedCount: allocationRows.filter(row => row.Coder !== UNASSIGNED_CODER).length,
      unassignedCount: allocationRows.filter(row => row.Coder === UNASSIGNED_CODER).length
    });
  }

  function getEl(id) {
    return doc ? doc.getElementById(id) : null;
  }

  async function readWorkbookFile(file) {
    const buffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = event => resolve(event.target.result);
      reader.onerror = () => reject(new Error(`Failed to read ${file.name}.`));
      reader.readAsArrayBuffer(file);
    });

    const workbook = root.XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const sheetRows = root.XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true });
    return {
      fileName: file.name,
      rows: sheetToObjects(sheetRows)
    };
  }

  function buildFacilityConfigsFromClaims(claims) {
    const configs = {};
    for (const item of getFacilityClaimStats(claims)) {
      configs[item.facilityKey] = createFacilityConfig(item.facilityKey, item.presetName);
    }
    return configs;
  }

  async function handleFiles(files) {
    const messageBox = getEl('messageBox');
    if (messageBox) messageBox.textContent = '';
    if (!files.length) return;

    try {
      await presetsReady;
      const reports = await Promise.all(Array.from(files).map(readWorkbookFile));
      const totalRows = reports.reduce((sum, report) => sum + report.rows.length, 0);
      if (!totalRows) {
        if (messageBox) messageBox.textContent = 'No data found in the uploaded files.';
        return;
      }

      state.importedReports = reports;
      state.rawClaims = normalizeRawClaims(reports, state.presetsData);
      const deduped = deduplicateClaims(state.rawClaims);
      state.dedupedClaims = deduped.dedupedClaims;
      state.duplicateGroups = deduped.duplicateGroups;
      state.importSummary = deduped.stats;
      state.facilityConfigs = buildFacilityConfigsFromClaims(state.duplicateGroups);
      initializeFilterState(state.dedupedClaims);

      getEl('allocator-workflow')?.classList.remove('hidden');
      renderPreAllocationState();
    } catch (error) {
      if (messageBox) messageBox.textContent = error.message || 'Failed to read uploaded files.';
    }
  }

  function updateFacilityPreset(facilityKey, presetName) {
    const nextConfig = createFacilityConfig(facilityKey, presetName);
    state.facilityConfigs[facilityKey] = {
      presetName: nextConfig.presetName,
      codersText: nextConfig.codersText,
      restrictions: nextConfig.restrictions
    };
    renderPreAllocationState();
  }

  function updateFacilityCoders(facilityKey, codersText) {
    const existing = state.facilityConfigs[facilityKey] || createFacilityConfig(facilityKey, '');
    state.facilityConfigs[facilityKey] = {
      presetName: existing.presetName,
      codersText,
      restrictions: existing.restrictions
    };
    state.lastAllocationResult = null;
    if (getEl('download-btn')) getEl('download-btn').disabled = true;
  }

  function attachUiHandlers() {
    const fileInput = getEl('allocator-file');
    const dropzone = getEl('allocator-dropzone');
    const downloadBtn = getEl('download-btn');
    const allocateBtn = getEl('allocate-btn');

    fileInput?.addEventListener('change', event => handleFiles(event.target.files || []));

    ['dragenter', 'dragover'].forEach(eventName => {
      dropzone?.addEventListener(eventName, event => {
        event.preventDefault();
        dropzone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(eventName => {
      dropzone?.addEventListener(eventName, event => {
        event.preventDefault();
        if (eventName === 'drop') {
          const files = event.dataTransfer?.files || [];
          handleFiles(files);
        }
        dropzone.classList.remove('dragover');
      });
    });

    getEl('facility-configs')?.addEventListener('change', event => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
      const facilityKey = target.dataset.facilityKey;
      if (!facilityKey) return;
      if (target.classList.contains('facility-preset-select')) {
        updateFacilityPreset(facilityKey, target.value);
      } else if (target.classList.contains('facility-coders-textarea')) {
        updateFacilityCoders(facilityKey, target.value);
      }
    });

    getEl('facility-configs')?.addEventListener('input', event => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains('facility-coders-textarea')) return;
      const facilityKey = target.dataset.facilityKey;
      if (!facilityKey) return;
      updateFacilityCoders(facilityKey, target.value);
    });

    const setAllChecked = (sectionId, checked) => {
      const section = getEl(sectionId);
      section?.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = checked; });
      syncFilterStateFromDom();
      renderPreAllocationState();
    };

    getEl('select-all-payment-btn')?.addEventListener('click', () => setAllChecked('payment-mode-section', true));
    getEl('deselect-all-payment-btn')?.addEventListener('click', () => setAllChecked('payment-mode-section', false));
    getEl('select-all-btn')?.addEventListener('click', () => setAllChecked('dept-section', true));
    getEl('deselect-all-btn')?.addEventListener('click', () => setAllChecked('dept-section', false));
    getEl('select-all-codif-btn')?.addEventListener('click', () => setAllChecked('codif-status-section', true));
    getEl('deselect-all-codif-btn')?.addEventListener('click', () => setAllChecked('codif-status-section', false));
    getEl('select-all-codified-by-btn')?.addEventListener('click', () => setAllChecked('codified-by-section', true));
    getEl('deselect-all-codified-by-btn')?.addEventListener('click', () => setAllChecked('codified-by-section', false));

    ['payment-mode-section', 'dept-section', 'codif-status-section', 'codified-by-section'].forEach(sectionId => {
      getEl(sectionId)?.addEventListener('change', () => {
        syncFilterStateFromDom();
        renderPreAllocationState();
      });
    });

    getEl('include-no-bill-cb')?.addEventListener('change', () => {
      syncFilterStateFromDom();
      renderPreAllocationState();
    });

    allocateBtn?.addEventListener('click', () => {
      const messageBox = getEl('messageBox');
      if (messageBox) messageBox.textContent = '';
      syncFilterStateFromDom();
      const filtered = applyClaimFilters(state.dedupedClaims, state.filterState);
      if (!filtered.eligibleClaims.length) {
        renderPreviewTable([], buildImportSummary());
        return;
      }

      const missingCoders = Object.entries(state.facilityConfigs)
        .filter(([, config]) => !parseCodersText(config.codersText).length)
        .map(([facilityKey]) => facilityKey);
      if (missingCoders.length && !filtered.eligibleClaims.every(claim => missingCoders.includes(claim.facilityKey))) {
        // continue: some facilities may remain unassigned intentionally
      }

      const allocationDate = formatToday();
      const allocation = allocateClaims(filtered.eligibleClaims, state.facilityConfigs, allocationDate);
      const importStats = buildImportSummary();
      state.lastAllocationResult = {
        allocationRows: allocation.allocationRows,
        filteredClaims: filtered.eligibleClaims,
        importStats,
        allocationDate
      };
      renderPreviewTable(allocation.allocationRows, importStats);
      if (downloadBtn) downloadBtn.disabled = !allocation.allocationRows.length;
    });

    downloadBtn?.addEventListener('click', () => {
      if (!state.lastAllocationResult) return;
      const workbook = buildWorkbook(state.lastAllocationResult);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      root.XLSX.writeFile(workbook, `allocation_${timestamp}.xlsx`);
    });
  }

  function loadPresets() {
    if (typeof fetch !== 'function') return;
    presetsReady = fetch('../json/allocator_presets.json')
      .then(response => response.json())
      .then(data => {
        state.presetsData = data || {};
        state.presetOptions = Object.keys(state.presetsData).filter(name => !name.startsWith('_')).sort((a, b) => a.localeCompare(b));
      })
      .catch(() => {
        state.presetsData = {};
        state.presetOptions = [];
      });
  }

  root._allocatorTestApi = {
    findColumnKey,
    isNoBillingRemark,
    isAutoExcludedStatus,
    matchFacilityValue: (value, presetsData) => matchFacilityValue(value, buildPresetIndex(presetsData)),
    normalizeRawClaims,
    deduplicateClaims,
    applyClaimFilters,
    allocateClaims,
    parseDateValue,
    formatDate,
    sheetToObjects,
    collectColumnKeys,
    createFacilityConfig,
    getEligibleCoders,
    buildPresetIndex
  };

  if (!doc || !getEl('allocator-file')) return;
  loadPresets();
  attachUiHandlers();
})();
