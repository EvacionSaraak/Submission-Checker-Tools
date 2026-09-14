(() => {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const doc = typeof document !== 'undefined' ? document : null;

  const CLAIM_ID_CANDIDATES = ['Pri. Claim ID', 'Pri. Claim No', 'ClaimID', 'Claim ID'];
  const VISIT_ID_CANDIDATES = ['Visit Id', 'Visit ID', 'VisitID'];
  const CLAIM_DATE_CANDIDATES = ['Encounter Date', 'Claim Date', 'Report Date', 'Adm/Reg. Date', 'Date'];
  const DEPT_CANDIDATES = ['Admitting Department', 'Department', 'Clinic'];
  const FACILITY_CANDIDATES = [
    'Center Name', 'Centre Name', 'Facility ID', 'Facility Name',
    'Facility', 'Center', 'Centre', 'Institution'
  ];
  const CODIFICATION_STATUS_CANDIDATES = ['Codification Status', 'Codification_Status', 'CodificationStatus'];
  const PAYMENT_MODE_CANDIDATES = ['Pri. Payment Mode', 'Payment Mode', 'PaymentMode', 'Pri Payment Mode'];
  const CODIFIED_BY_CANDIDATES = [
    'Codified By', 'CodifiedBy', 'Codified_By',
    'Coded By', 'CodedBy', 'Opened by', 'Opened By', 'Username'
  ];
  const CODIF_REMARKS_CANDIDATES = [
    'Codification Remarks', 'CodificationRemarks', 'Codification_Remarks', 'Codif Remarks'
  ];

  const TERMINAL_STATUS_SET = new Set([
    'closed',
    'submitted',
    'audited',
    'verified and closed',
    'merged'
  ]);

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
  const UNASSIGNED_CODER = '(Unassigned)';
  const UNKNOWN_FACILITY = 'Unknown Facility';
  const STORAGE_KEY = 'checkerAllocatorUserStateV4';
  const DEFAULT_EXCLUDED_DEPARTMENT_PATTERN = /\b(?:dental|orthodontic|orthodontics|slimming|cupping)\b/i;

  /*
   * Claims currently carrying one of these coders in Codified By are allowed
   * back into the allocator for reassignment. They are not sent back to the
   * same source coder on that claim.
   */
  const REASSIGNABLE_CODIFIED_BY_TOKENS = new Set([
    'rednie',
    'farsana',
    'abhilash'
  ]);

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
    activeFacilityTab: '',
    filterState: {
      paymentModes: new Set(),
      departments: new Set(),
      codifStatuses: new Set(),
      codifiedBy: new Set(),
      claimDates: new Set(),
      includeNoBills: false
    },
    lastAllocationResult: null,
    persistedUserState: {}
  };

  let presetsReady = Promise.resolve();

  function getEl(id) {
    return doc ? doc.getElementById(id) : null;
  }

  function normalizeKey(value) {
    return String(value || '').toLowerCase().replace(/[\s.\-_]/g, '');
  }

  function formatDepartmentDisplay(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    const keepUpper = new Set([
      'ENT', 'GP', 'OBGYN', 'ICU', 'NICU', 'ER', 'OPD', 'IPD', 'IVF', 'MRI', 'CT'
    ]);

    return text
      .toLowerCase()
      .replace(/\b[a-z][a-z0-9]*\b/g, word => {
        const upper = word.toUpperCase();
        if (keepUpper.has(upper)) return upper;
        return word.charAt(0).toUpperCase() + word.slice(1);
      });
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
    return TERMINAL_STATUS_SET.has(normalizeStatus(value));
  }

  function isDefaultExcludedDepartment(value) {
    return DEFAULT_EXCLUDED_DEPARTMENT_PATTERN.test(String(value || '').trim());
  }

  function getPaymentModeCategory(mode) {
    return /insur/i.test(String(mode || '')) ? 'insurance' : 'self_pay';
  }

  function getNameTokens(value) {
    return normalizeStatus(value)
      .split(/\s+/)
      .filter(Boolean);
  }

  function isReassignableCodifiedByValue(value) {
    return getNameTokens(value).some(
      token =>
        REASSIGNABLE_CODIFIED_BY_TOKENS.has(token)
    );
  }

  function getReassignmentSourceTokens(claim) {
    return Array.from(
      new Set(
        (claim?.codifiedByValues || [])
          .flatMap(value =>
            getNameTokens(value).filter(
              token =>
                REASSIGNABLE_CODIFIED_BY_TOKENS.has(token)
            )
          )
      )
    );
  }

  function claimRequiresReassignment(claim) {
    const values =
      (claim?.codifiedByValues || [])
        .map(value => String(value || '').trim())
        .filter(Boolean);

    return Boolean(
      values.length &&
      values.every(isReassignableCodifiedByValue)
    );
  }

  function claimHasBlockingCodifiedBy(claim) {
    const values =
      (claim?.codifiedByValues || [])
        .map(value => String(value || '').trim())
        .filter(Boolean);

    if (!values.length) return false;

    return !values.every(
      isReassignableCodifiedByValue
    );
  }

  function getClaimDateFilterValue(claim) {
    if (
      claim?.claimDate instanceof Date &&
      !Number.isNaN(claim.claimDate.getTime())
    ) {
      return formatDate(claim.claimDate);
    }

    return (
      String(claim?.claimDateText || '').trim() ||
      '(Blank)'
    );
  }

  function sortClaimDateEntries(entries) {
    return entries.slice().sort((a, b) => {
      const dateA = parseDateValue(a[0]);
      const dateB = parseDateValue(b[0]);

      if (dateA && dateB) {
        return (
          dateA - dateB ||
          String(a[0]).localeCompare(String(b[0]))
        );
      }

      if (dateA) return -1;
      if (dateB) return 1;

      if (a[0] === '(Blank)') return 1;
      if (b[0] === '(Blank)') return -1;

      return String(a[0]).localeCompare(String(b[0]));
    });
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
      return {
        presetName,
        displayName: presetName,
        matched: true,
        matchType: 'license',
        rawValue: raw
      };
    }

    const normalized = normalizeLoose(raw);
    if (!normalized) return null;

    if (presetIndex.aliasToPreset.has(normalized)) {
      const presetName = presetIndex.aliasToPreset.get(normalized);
      return {
        presetName,
        displayName: presetName,
        matched: true,
        matchType: 'alias',
        rawValue: raw
      };
    }

    for (const facility of presetIndex.facilities) {
      if (
        facility.normalizedName === normalized ||
        facility.normalizedName.includes(normalized) ||
        normalized.includes(facility.normalizedName)
      ) {
        return {
          presetName: facility.name,
          displayName: facility.name,
          matched: true,
          matchType: 'name',
          rawValue: raw
        };
      }
    }

    for (const [alias, presetName] of presetIndex.aliasToPreset.entries()) {
      if (normalized.includes(alias) || alias.includes(normalized)) {
        return {
          presetName,
          displayName: presetName,
          matched: true,
          matchType: 'alias',
          rawValue: raw
        };
      }
    }

    return null;
  }

  function getFacilityOutputName(claim, facilityConfigs = state.facilityConfigs) {
    const config = facilityConfigs[claim.facilityKey];
    return (config && config.presetName) ||
      claim.facilityDisplay ||
      claim.facilityKey ||
      UNKNOWN_FACILITY;
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
    const headerRow = (sheetRows[headerRowIndex] || [])
      .map(cell => String(cell == null ? '' : cell).trim());
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

  function coderEntriesToText(coderEntries) {
    return (coderEntries || [])
      .map(coder => typeof coder === 'string' ? coder : coder && coder.name)
      .map(name => String(name || '').trim())
      .filter(Boolean)
      .join('\n');
  }

  function normalizeDepartmentKey(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  function normalizeDepartmentList(values) {
    const byKey = new Map();

    for (const value of values || []) {
      const display = formatDepartmentDisplay(value);
      const key = normalizeDepartmentKey(display);
      if (key && !byKey.has(key)) {
        byKey.set(key, display);
      }
    }

    return Array.from(byKey.values())
      .sort((a, b) => a.localeCompare(b));
  }

  function buildCoderRowsFromEntries(coderEntries) {
    return (coderEntries || [])
      .map(coder => {
        if (typeof coder === 'string') {
          return {
            name: String(coder || '').trim(),
            preferredDepartments: [],
            assignedDepartments: []
          };
        }

        if (!coder || typeof coder !== 'object') return null;

        return {
          name: String(coder.name || '').trim(),
          preferredDepartments: normalizeDepartmentList(
            Array.isArray(coder.preferredDepartments)
              ? coder.preferredDepartments
              : Array.isArray(coder.departments)
                ? coder.departments
                : []
          ),
          // Assigned departments are intentionally never loaded from JSON.
          // They are manual auditor overrides only.
          assignedDepartments: []
        };
      })
      .filter(row => row && row.name);
  }

  function cloneCoderRows(rows) {
    return (rows || []).map(row => ({
      name: String(row?.name || '').trim(),
      preferredDepartments: normalizeDepartmentList(
        row?.preferredDepartments || []
      ),
      assignedDepartments: normalizeDepartmentList(
        row?.assignedDepartments || []
      )
    }));
  }

  function getConfigCoderRows(config) {
    if (Array.isArray(config?.coderRows)) {
      return config.coderRows;
    }

    return parseCodersText(config?.codersText || '')
      .map(name => ({
        name,
        preferredDepartments: [],
        assignedDepartments: []
      }));
  }

  function getConfigCoderProfiles(config) {
    const profiles = new Map();

    for (const row of getConfigCoderRows(config)) {
      const name = String(row?.name || '').trim();
      if (!name) continue;

      if (!profiles.has(name)) {
        profiles.set(name, {
          name,
          preferredDepartments: new Set(),
          assignedDepartments: new Set()
        });
      }

      const profile = profiles.get(name);

      normalizeDepartmentList(row.preferredDepartments || [])
        .forEach(dept => profile.preferredDepartments.add(
          normalizeDepartmentKey(dept)
        ));

      normalizeDepartmentList(row.assignedDepartments || [])
        .forEach(dept => profile.assignedDepartments.add(
          normalizeDepartmentKey(dept)
        ));
    }

    return profiles;
  }

  function getConfigCoderNames(config) {
    return Array.from(getConfigCoderProfiles(config).keys());
  }

  function syncConfigDerivedFields(config) {
    const next = config || {};
    next.coderRows = cloneCoderRows(next.coderRows || []);
    next.codersText = next.coderRows
      .map(row => String(row.name || '').trim())
      .filter(Boolean)
      .join('\n');

    next.preferences = {};
    for (const [name, profile] of getConfigCoderProfiles(next).entries()) {
      next.preferences[name] = {
        preferredDepartments: new Set(profile.preferredDepartments),
        assignedDepartments: new Set(profile.assignedDepartments)
      };
    }

    return next;
  }

  function buildPreferenceMap(coderEntries) {
    const config = syncConfigDerivedFields({
      coderRows: buildCoderRowsFromEntries(coderEntries)
    });
    return config.preferences;
  }

  /*
   * Preset behavior:
   * - Presets supply coder names and SOFT preferred departments.
   * - Assigned departments always start blank and can only be added manually.
   * - coderRows is the editable source of truth used by allocation.
   */
  function createFacilityConfig(facilityName, presetName) {
    const coderEntries = getCoderEntriesForPreset(presetName);
    const presetCodersText = coderEntriesToText(coderEntries);

    return syncConfigDerivedFields({
      facilityName: facilityName || '',
      presetName: presetName || '',
      presetCodersText,
      coderRows: buildCoderRowsFromEntries(coderEntries),
      coderListEdited: false
    });
  }

  function cloneFacilityConfig(config) {
    return syncConfigDerivedFields({
      facilityName: config?.facilityName || '',
      presetName: config?.presetName || '',
      presetCodersText: config?.presetCodersText || '',
      coderRows: cloneCoderRows(getConfigCoderRows(config)),
      coderListEdited: Boolean(config?.coderListEdited)
    });
  }

  function applyUserCoderRows(config, coderRows) {
    const next = cloneFacilityConfig(config || {});
    next.coderRows = cloneCoderRows(coderRows || []);
    next.coderListEdited = true;
    return syncConfigDerivedFields(next);
  }

  function applyUserCoderText(config, codersText) {
    const next = cloneFacilityConfig(config || {});
    const existingByName = new Map(
      getConfigCoderRows(next).map(row => [String(row.name || '').trim(), row])
    );

    next.coderRows = parseCodersText(codersText).map(name => {
      const existing = existingByName.get(name);
      return existing
        ? cloneCoderRows([existing])[0]
        : {
            name,
            preferredDepartments: [],
            assignedDepartments: []
          };
    });
    next.coderListEdited = true;
    return syncConfigDerivedFields(next);
  }

  function applyPresetSelection(config, facilityKey, presetName) {
    const presetConfig = createFacilityConfig(facilityKey, presetName);
    const existing = config || createFacilityConfig(facilityKey, '');

    if (existing.coderListEdited) {
      const next = cloneFacilityConfig(existing);
      next.facilityName = facilityKey;
      next.presetName = presetConfig.presetName;
      next.presetCodersText = presetConfig.presetCodersText;
      return syncConfigDerivedFields(next);
    }

    return presetConfig;
  }

  function resetConfigToPreset(config, facilityKey) {
    const existing = config || createFacilityConfig(facilityKey, '');
    return createFacilityConfig(facilityKey, existing.presetName);
  }

  function getFacilityDepartmentOptions(facilityKey) {
    const departments = state.dedupedClaims
      .filter(claim => claim.facilityKey === facilityKey)
      .map(claim => claim.department)
      .filter(Boolean);

    return normalizeDepartmentList(departments);
  }

  function getFacilityDepartmentDisplayValue(facilityKey, typedValue) {
    const wanted = normalizeDepartmentKey(typedValue);
    if (!wanted) return '';

    return getFacilityDepartmentOptions(facilityKey)
      .find(value => normalizeDepartmentKey(value) === wanted) || '';
  }

  function loadPersistedUserState() {
    // Local-storage persistence is intentionally disabled.
    return {};
  }

  function serializeFacilityConfig(config) {
    return {
      facilityName: config?.facilityName || '',
      presetName: config?.presetName || '',
      presetCodersText: config?.presetCodersText || '',
      coderListEdited: Boolean(config?.coderListEdited),
      coderRows: cloneCoderRows(getConfigCoderRows(config))
    };
  }

  function persistUserState() {
    // Local-storage persistence is intentionally disabled.
  }

  function restorePersistedFacilityConfigs(defaultConfigs) {
    return defaultConfigs || {};
  }

  function restorePersistedFilterState() {
    // Filters always start from the current upload's defaults.
  }

  function collectColumnKeys(rows) {
    return {
      claimId: findColumnKey(rows, CLAIM_ID_CANDIDATES),
      visitId: findColumnKey(rows, VISIT_ID_CANDIDATES),
      claimDate: findColumnKey(rows, CLAIM_DATE_CANDIDATES),
      department: findColumnKey(rows, DEPT_CANDIDATES),
      facilityKeys: FACILITY_CANDIDATES
        .map(candidate => findColumnKey(rows, [candidate]))
        .filter(Boolean),
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

          if (match) {
            facilityMatches.push(match);
          } else {
            facilityMatches.push({
              presetName: '',
              displayName: value,
              matched: false,
              matchType: 'raw',
              rawValue: value
            });
          }
        }

        let facilityMatch = facilityMatches.find(item => item.matched) || null;

        if (!facilityMatch) {
          facilityMatch = matchFacilityValue(report.fileName, presetIndex);
        }

        if (!facilityMatch) {
          const rawFacility = facilityMatches.find(Boolean);
          facilityMatch = rawFacility || {
            presetName: '',
            displayName: UNKNOWN_FACILITY,
            matched: false,
            matchType: 'unknown',
            rawValue: ''
          };
        }

        const claimDateValue = keys.claimDate
          ? parseDateValue(row[keys.claimDate])
          : null;
        const department = keys.department
          ? String(row[keys.department] || '').trim()
          : '';
        const statusRaw = keys.codificationStatus
          ? String(row[keys.codificationStatus] || '').trim()
          : '';
        const paymentMode = keys.paymentMode
          ? String(row[keys.paymentMode] || '').trim()
          : '';
        const codifiedBy = keys.codifiedBy
          ? String(row[keys.codifiedBy] || '').trim()
          : '';
        const codifRemarks = keys.codifRemarks
          ? String(row[keys.codifRemarks] || '').trim()
          : '';

        const outputClaimId = claimId || visitId;
        const dedupeKeyId = normalizeClaimKey(outputClaimId);
        const facilityKey =
          facilityMatch.presetName ||
          facilityMatch.displayName ||
          UNKNOWN_FACILITY;

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
          claimDateText: claimDateValue
            ? formatDate(claimDateValue)
            : String(keys.claimDate ? row[keys.claimDate] || '' : '').trim(),
          department,
          codificationStatus: statusRaw,
          codificationStatusNormalized: normalizeStatus(statusRaw),
          paymentMode,
          paymentModeCategory: getPaymentModeCategory(paymentMode),
          codifiedBy,
          codifRemarks,
          noBill: isNoBillingRemark(codifRemarks),
          autoExcludedStatus: isAutoExcludedStatus(statusRaw),
          rawFieldCount: Object.values(row)
            .filter(value => String(value || '').trim() !== '').length
        });
      }
    }

    return claims;
  }

  function chooseRepresentativeClaim(claims) {
    return claims
      .slice()
      .sort((a, b) => {
        const scoreA =
          (a.facilityMatched ? 10 : 0) +
          (a.claimDate ? 5 : 0) +
          (a.department ? 2 : 0) +
          a.rawFieldCount;
        const scoreB =
          (b.facilityMatched ? 10 : 0) +
          (b.claimDate ? 5 : 0) +
          (b.department ? 2 : 0) +
          b.rawFieldCount;

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
      if (!grouped.has(claim.dedupeKey)) {
        grouped.set(claim.dedupeKey, []);
      }
      grouped.get(claim.dedupeKey).push(claim);
    }

    const dedupedClaims = [];
    const duplicateGroups = [];
    let duplicateClaimsResolved = 0;
    let terminalStatusExcluded = 0;

    for (const claims of grouped.values()) {
      const representative = chooseRepresentativeClaim(claims);
      const duplicateCount = Math.max(0, claims.length - 1);
      duplicateClaimsResolved += duplicateCount;

      const terminal = claims.some(claim => claim.autoExcludedStatus);

      const aggregatedClaim = {
        ...representative,
        claimDate:
          claims
            .map(claim => claim.claimDate)
            .filter(Boolean)
            .sort((a, b) => a - b)[0] ||
          representative.claimDate ||
          null,
        claimDateText: '',
        codificationStatus: representative.codificationStatus,
        paymentMode: representative.paymentMode,
        codifRemarks: Array.from(
          new Set(
            claims
              .map(claim => String(claim.codifRemarks || '').trim())
              .filter(Boolean)
          )
        ).join(' | '),
        codifiedByValues: Array.from(
          new Set(claims.map(claim => claim.codifiedBy).filter(Boolean))
        ),
        noBill: claims.some(claim => claim.noBill),
        duplicateCount,
        versions: claims.length,
        autoExcludedStatus: terminal,
        duplicateReasons: claims
          .map(claim => claim.codificationStatus)
          .filter(Boolean)
      };

      aggregatedClaim.claimDateText = aggregatedClaim.claimDate
        ? formatDate(aggregatedClaim.claimDate)
        : representative.claimDateText;

      duplicateGroups.push(aggregatedClaim);

      if (terminal) {
        terminalStatusExcluded++;
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
        terminalStatusExcluded
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
      paymentModes: Array.from(
        countBy(claims, claim => claim.paymentMode).entries()
      ).sort((a, b) => a[0].localeCompare(b[0])),

      departments: Array.from(
        countBy(claims, claim => claim.department).entries()
      ).sort((a, b) => a[0].localeCompare(b[0])),

      codifStatuses: Array.from(
        countBy(claims, claim => claim.codificationStatus).entries()
      ).sort((a, b) => a[0].localeCompare(b[0])),

      codifiedBy: Array.from(
        countBy(
          claims.flatMap(claim => claim.codifiedByValues || []),
          value => value
        ).entries()
      ).sort((a, b) => a[0].localeCompare(b[0])),

      claimDates: sortClaimDateEntries(
        Array.from(
          countBy(
            claims,
            claim => getClaimDateFilterValue(claim)
          ).entries()
        )
      )
    };
  }

  function buildInitialFilterState(claims) {
    const options = collectFilterOptions(claims);

    return {
      paymentModes: new Set(options.paymentModes.map(([value]) => value)),
      departments: new Set(
        options.departments
          .map(([value]) => value)
          .filter(value => !isDefaultExcludedDepartment(value))
      ),
      codifStatuses: new Set(options.codifStatuses.map(([value]) => value)),
      codifiedBy: new Set(),
      claimDates: new Set(options.claimDates.map(([value]) => value)),
      includeNoBills: false
    };
  }

  function initializeFilterState(claims) {
    state.filterState = buildInitialFilterState(claims);
  }

  function applyClaimFilters(claims, filterState) {
    const paymentFiltered = claims.filter(
      claim =>
        !claim.paymentMode ||
        filterState.paymentModes.has(
          claim.paymentMode
        )
    );

    const departmentFiltered =
      paymentFiltered.filter(
        claim =>
          !claim.department ||
          filterState.departments.has(
            claim.department
          )
      );

    const statusFiltered =
      departmentFiltered.filter(
        claim =>
          !claim.codificationStatus ||
          filterState.codifStatuses.has(
            claim.codificationStatus
          )
      );

    /*
     * Ordinarily, a populated Codified By excludes a claim from new
     * assignment. Rednie, Farsana and Abhilash are deliberate exceptions:
     * claims carrying only one/more of those names remain eligible so their
     * work can be redistributed.
     */
    const alreadyCodifiedExcluded =
      statusFiltered.filter(
        claim =>
          claimHasBlockingCodifiedBy(claim)
      ).length;

    const codifiedFiltered =
      statusFiltered.filter(
        claim =>
          !claimHasBlockingCodifiedBy(claim)
      );

    const noBillDetected =
      codifiedFiltered.filter(
        claim => claim.noBill
      ).length;

    const noBillExcluded =
      filterState.includeNoBills
        ? 0
        : noBillDetected;

    const noBillFiltered =
      filterState.includeNoBills
        ? codifiedFiltered
        : codifiedFiltered.filter(
            claim => !claim.noBill
          );

    /*
     * Claim Date is intentionally the final user filter in the hierarchy.
     */
    const dateFiltered =
      noBillFiltered.filter(
        claim =>
          filterState.claimDates.has(
            getClaimDateFilterValue(claim)
          )
      );

    const claimDateFilteredOut =
      noBillFiltered.length -
      dateFiltered.length;

    return {
      paymentFiltered,
      departmentFiltered,
      statusFiltered,
      codifiedFiltered,
      noBillFiltered,
      dateFiltered,
      eligibleClaims: dateFiltered,
      alreadyCodifiedExcluded,
      noBillDetected,
      noBillExcluded,
      claimDateFilteredOut,
      paymentModeFilteredOut:
        claims.length - paymentFiltered.length,
      departmentFilteredOut:
        paymentFiltered.length -
        departmentFiltered.length,
      codificationStatusFilteredOut:
        departmentFiltered.length -
        statusFiltered.length
    };
  }

  function getFacilityClaimStats(claims) {
    const map = new Map();

    for (const claim of claims) {
      const key = claim.facilityKey;

      if (!map.has(key)) {
        map.set(key, {
          facilityKey: key,
          displayName: claim.facilityDisplay || key,
          count: 0,
          presetName: claim.detectedPresetName || ''
        });
      }

      const entry = map.get(key);
      entry.count++;

      if (!entry.presetName && claim.detectedPresetName) {
        entry.presetName = claim.detectedPresetName;
      }
    }

    return Array.from(map.values()).sort(
      (a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName)
    );
  }

  function buildImportSummary() {
    const filtered = applyClaimFilters(
      state.dedupedClaims,
      state.filterState
    );

    const facilitiesFound =
      new Set(state.duplicateGroups.map(claim => claim.facilityKey)).size;

    return {
      reportsLoaded: state.importedReports.length,
      rowsDetected: state.importedReports.reduce(
        (sum, report) => sum + report.rows.length,
        0
      ),
      totalClaimsRead: state.importSummary
        ? state.importSummary.totalClaimsRead
        : 0,
      facilitiesFound,
      duplicateClaimsResolved: state.importSummary
        ? state.importSummary.duplicateClaimsResolved
        : 0,
      terminalStatusExcluded: state.importSummary
        ? state.importSummary.terminalStatusExcluded
        : 0,
      noBillExcluded: filtered.noBillExcluded,
      alreadyCodifiedExcluded: filtered.alreadyCodifiedExcluded,
      paymentModeFilteredOut: filtered.paymentModeFilteredOut,
      departmentFilteredOut: filtered.departmentFilteredOut,
      codificationStatusFilteredOut:
        filtered.codificationStatusFilteredOut,
      claimDateFilteredOut:
        filtered.claimDateFilteredOut,
      eligibleClaims: filtered.eligibleClaims.length,
      automaticallyExcluded:
        (state.importSummary ? state.importSummary.terminalStatusExcluded : 0) +
        filtered.paymentModeFilteredOut +
        filtered.departmentFilteredOut +
        filtered.codificationStatusFilteredOut +
        filtered.alreadyCodifiedExcluded +
        filtered.noBillExcluded +
        filtered.claimDateFilteredOut
    };
  }

  function parseCodersText(codersText) {
    return Array.from(
      new Set(
        String(codersText || '')
          .split(/\r?\n/)
          .map(value => value.trim())
          .filter(Boolean)
      )
    );
  }

  function getEligibleCoders(claim, facilityConfigs) {
    const config =
      facilityConfigs[claim.facilityKey] ||
      createFacilityConfig(
        claim.facilityKey,
        claim.detectedPresetName
      );

    const profiles =
      getConfigCoderProfiles(config);

    const reassignmentSourceTokens =
      claimRequiresReassignment(claim)
        ? new Set(
            getReassignmentSourceTokens(claim)
          )
        : new Set();

    /*
     * For reassignment-source claims, remove the source coder(s) from the
     * destination pool so Rednie/Farsana/Abhilash cannot receive their own
     * claim back.
     */
    const allCoders =
      Array.from(profiles.keys())
        .filter(coder => {
          if (!reassignmentSourceTokens.size) {
            return true;
          }

          const coderTokens =
            getNameTokens(coder);

          return !coderTokens.some(
            token =>
              reassignmentSourceTokens.has(token)
          );
        });

    const departmentKey =
      normalizeDepartmentKey(
        claim.department
      );

    if (!departmentKey) {
      return allCoders;
    }

    const explicitlyAssigned =
      allCoders.filter(coder =>
        profiles
          .get(coder)
          ?.assignedDepartments
          .has(departmentKey)
      );

    /*
     * Manual Assigned Departments are hard auditor overrides. If at least one
     * remaining coder is explicitly assigned to this department, only that
     * coder/pool is eligible. Otherwise the normal facility pool is used and
     * preferred departments remain soft tie-breakers.
     */
    return explicitlyAssigned.length
      ? explicitlyAssigned
      : allCoders;
  }

  function getCoderPreferenceCost(claim, coder, facilityConfigs) {
    const config =
      facilityConfigs[claim.facilityKey] ||
      createFacilityConfig(claim.facilityKey, claim.detectedPresetName);

    const departmentKey = normalizeDepartmentKey(claim.department);
    if (!departmentKey) return 0;

    const profile = getConfigCoderProfiles(config).get(coder);
    if (!profile) return 1;

    // Explicit assignments are already enforced through eligibility.
    if (profile.assignedDepartments.has(departmentKey)) return 0;

    const preferred = profile.preferredDepartments.has(departmentKey);

    /*
     * Preferred Departments are SOFT only. The min-cost solver gives workload
     * balance a much larger weight; preference only decides among comparably
     * balanced choices.
     */
    return preferred ? 0 : 1;
  }

  function compareClaimsForAllocation(a, b) {
    if (
      a.claimDate &&
      b.claimDate &&
      a.claimDate.getTime() !== b.claimDate.getTime()
    ) {
      return a.claimDate - b.claimDate;
    }

    if (a.claimDate) return -1;
    if (b.claimDate) return 1;

    return [
      String(a.facilityKey || '').localeCompare(String(b.facilityKey || '')),
      String(a.outputClaimId || '').localeCompare(String(b.outputClaimId || '')),
      String(a.sourceFile || '').localeCompare(String(b.sourceFile || '')),
      (a.sourceRowNumber || 0) - (b.sourceRowNumber || 0)
    ].find(result => result !== 0) || 0;
  }

  function collectConfiguredCoders(facilityConfigs) {
    return Array.from(
      new Set(
        Object.values(facilityConfigs || {}).flatMap(
          config => getConfigCoderNames(config)
        )
      )
    ).sort((a, b) => a.localeCompare(b));
  }

  function buildClaimEligibilityContext(claims, facilityConfigs) {
    const sortedClaims = claims.slice().sort(compareClaimsForAllocation);
    const allConfiguredCoders = collectConfiguredCoders(facilityConfigs);
    const groupsBySignature = new Map();

    for (const claim of sortedClaims) {
      const eligibleCoders = getEligibleCoders(claim, facilityConfigs)
        .slice()
        .sort((a, b) => a.localeCompare(b));

      const preferenceCosts = Object.fromEntries(
        eligibleCoders.map(coder => [
          coder,
          getCoderPreferenceCost(claim, coder, facilityConfigs)
        ])
      );

      claim._eligibleCoders = eligibleCoders;
      claim._coderPreferenceCosts = preferenceCosts;
      claim._eligibilitySignature = [
        eligibleCoders.join('|'),
        eligibleCoders
          .map(coder => `${coder}:${preferenceCosts[coder] || 0}`)
          .join('|')
      ].join('::prefs::');

      if (!eligibleCoders.length) continue;

      if (!groupsBySignature.has(claim._eligibilitySignature)) {
        groupsBySignature.set(claim._eligibilitySignature, {
          signature: claim._eligibilitySignature,
          eligibleCoders,
          preferenceCosts,
          claims: []
        });
      }

      groupsBySignature.get(claim._eligibilitySignature).claims.push(claim);
    }

    return {
      sortedClaims,
      groups: Array.from(groupsBySignature.values()).sort(
        (a, b) =>
          a.eligibleCoders.length - b.eligibleCoders.length ||
          compareClaimsForAllocation(a.claims[0], b.claims[0]) ||
          a.signature.localeCompare(b.signature)
      ),
      allConfiguredCoders
    };
  }

  function createMinHeap() {
    const items = [];

    function compare(a, b) {
      return a.priority - b.priority || a.tieBreaker - b.tieBreaker;
    }

    return {
      push(item) {
        items.push(item);
        let index = items.length - 1;

        while (index > 0) {
          const parent = Math.floor((index - 1) / 2);
          if (compare(items[parent], items[index]) <= 0) break;

          [items[parent], items[index]] =
            [items[index], items[parent]];

          index = parent;
        }
      },

      pop() {
        if (!items.length) return null;

        const first = items[0];
        const last = items.pop();

        if (items.length && last) {
          items[0] = last;
          let index = 0;

          while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let smallest = index;

            if (
              left < items.length &&
              compare(items[left], items[smallest]) < 0
            ) {
              smallest = left;
            }

            if (
              right < items.length &&
              compare(items[right], items[smallest]) < 0
            ) {
              smallest = right;
            }

            if (smallest === index) break;

            [items[index], items[smallest]] =
              [items[smallest], items[index]];

            index = smallest;
          }
        }

        return first;
      },

      get size() {
        return items.length;
      }
    };
  }

  function solveBalancedCoderLoads(groups, coderNames) {
    const totalClaims =
      groups.reduce((sum, group) => sum + group.claims.length, 0);

    if (!totalClaims || !coderNames.length) {
      return {
        assignmentCounts: new Map(),
        coderLoads: {}
      };
    }

    const source = 0;
    const groupOffset = 1;
    const coderOffset = groupOffset + groups.length;
    const sink = coderOffset + coderNames.length;

    const graph =
      Array.from({ length: sink + 1 }, () => []);

    const groupCoderEdges = new Map();

    function addEdge(from, to, capacity, cost) {
      const forward = {
        to,
        rev: graph[to].length,
        capacity,
        cost,
        originalCapacity: capacity,
        flow: 0
      };

      const reverse = {
        to: from,
        rev: graph[from].length,
        capacity: 0,
        cost: -cost,
        originalCapacity: 0,
        flow: 0
      };

      graph[from].push(forward);
      graph[to].push(reverse);

      return forward;
    }

    groups.forEach((group, groupIndex) => {
      addEdge(
        source,
        groupOffset + groupIndex,
        group.claims.length,
        0
      );

      group.eligibleCoders.forEach(coder => {
        const coderIndex = coderNames.indexOf(coder);

        const edge = addEdge(
          groupOffset + groupIndex,
          coderOffset + coderIndex,
          group.claims.length,
          Number((group.preferenceCosts || {})[coder] || 0)
        );

        groupCoderEdges.set(
          `${group.signature}::${coder}`,
          edge
        );
      });
    });

    /*
     * Increasing slot costs minimize the sum of triangular coder loads.
     *
     * IMPORTANT: workload balance is the primary objective.  Department
     * preference is only a tie-breaker.  A large multiplier makes a one-claim
     * worsening of coder balance far more expensive than any preference gain,
     * so the allocator keeps eligible coder workloads as even as practical
     * before considering preferred departments.
     */
    const LOAD_BALANCE_WEIGHT = 1000;

    coderNames.forEach((coder, coderIndex) => {
      for (let slot = 0; slot < totalClaims; slot++) {
        addEdge(
          coderOffset + coderIndex,
          sink,
          1,
          slot * LOAD_BALANCE_WEIGHT
        );
      }
    });

    const potentials = new Array(graph.length).fill(0);
    const distances = new Array(graph.length).fill(Infinity);
    const previousNode = new Array(graph.length).fill(-1);
    const previousEdge = new Array(graph.length).fill(-1);

    let flow = 0;

    while (flow < totalClaims) {
      distances.fill(Infinity);
      previousNode.fill(-1);
      previousEdge.fill(-1);

      distances[source] = 0;

      const heap = createMinHeap();
      heap.push({
        node: source,
        priority: 0,
        tieBreaker: 0
      });

      while (heap.size) {
        const current = heap.pop();

        if (
          !current ||
          current.priority !== distances[current.node]
        ) {
          continue;
        }

        graph[current.node].forEach((edge, edgeIndex) => {
          if (edge.capacity <= 0) return;

          const nextDistance =
            current.priority +
            edge.cost +
            potentials[current.node] -
            potentials[edge.to];

          if (nextDistance < distances[edge.to]) {
            distances[edge.to] = nextDistance;
            previousNode[edge.to] = current.node;
            previousEdge[edge.to] = edgeIndex;

            heap.push({
              node: edge.to,
              priority: nextDistance,
              tieBreaker: edge.to
            });
          }
        });
      }

      if (distances[sink] === Infinity) break;

      for (let node = 0; node < graph.length; node++) {
        if (distances[node] < Infinity) {
          potentials[node] += distances[node];
        }
      }

      let augment = totalClaims - flow;

      for (
        let node = sink;
        node !== source;
        node = previousNode[node]
      ) {
        const edge =
          graph[previousNode[node]][previousEdge[node]];

        augment = Math.min(augment, edge.capacity);
      }

      for (
        let node = sink;
        node !== source;
        node = previousNode[node]
      ) {
        const edge =
          graph[previousNode[node]][previousEdge[node]];

        edge.capacity -= augment;
        edge.flow += augment;

        const reverse = graph[node][edge.rev];
        reverse.capacity += augment;
        reverse.flow -= augment;
      }

      flow += augment;
    }

    const assignmentCounts = new Map();

    const coderLoads = Object.fromEntries(
      coderNames.map(coder => [coder, 0])
    );

    groups.forEach(group => {
      const counts = {};

      group.eligibleCoders.forEach(coder => {
        const edge =
          groupCoderEdges.get(`${group.signature}::${coder}`);

        const assigned = edge ? edge.flow : 0;

        if (assigned > 0) {
          counts[coder] = assigned;
          coderLoads[coder] += assigned;
        }
      });

      assignmentCounts.set(group.signature, counts);
    });

    return {
      assignmentCounts,
      coderLoads
    };
  }

  function verifyAllocationFairness(
    allocationRows,
    sortedClaims,
    allConfiguredCoders
  ) {
    const eligibleByCoder = Object.fromEntries(
      allConfiguredCoders.map(coder => [coder, 0])
    );

    sortedClaims.forEach(claim => {
      (claim._eligibleCoders || []).forEach(coder => {
        eligibleByCoder[coder] =
          (eligibleByCoder[coder] || 0) + 1;
      });
    });

    const counts = Object.fromEntries(
      allConfiguredCoders.map(coder => [coder, 0])
    );

    allocationRows.forEach(row => {
      if (row.Coder !== UNASSIGNED_CODER) {
        counts[row.Coder] =
          (counts[row.Coder] || 0) + 1;
      }
    });

    const comparableCoders =
      allConfiguredCoders.filter(
        coder => eligibleByCoder[coder] > 0
      );

    const comparableLoads =
      comparableCoders.map(
        coder => counts[coder] || 0
      );

    const maxAssigned =
      comparableLoads.length
        ? Math.max(...comparableLoads)
        : 0;

    const minAssigned =
      comparableLoads.length
        ? Math.min(...comparableLoads)
        : 0;

    const eligibleClaims =
      sortedClaims.filter(
        claim => (claim._eligibleCoders || []).length > 0
      );

    const firstSignature =
      eligibleClaims.length
        ? eligibleClaims[0]._eligibilitySignature
        : '';

    const hasSharedPool =
      eligibleClaims.every(
        claim =>
          (claim._eligibilitySignature || '') === firstSignature
      );

    return {
      coderCounts: counts,
      eligibleByCoder,
      comparableCoders,
      maxAssigned,
      minAssigned,
      difference: maxAssigned - minAssigned,
      even:
        comparableLoads.length <= 1 ||
        maxAssigned - minAssigned <= 1,
      sharedPoolVerified:
        !hasSharedPool ||
        maxAssigned - minAssigned <= 1,
      statusText:
        comparableLoads.length <= 1 ||
        maxAssigned - minAssigned <= 1
          ? 'EVEN'
          : 'CONSTRAINED BY ELIGIBILITY'
    };
  }

  function allocateClaims(
    claims,
    facilityConfigs,
    allocationDateText
  ) {
    const {
      sortedClaims,
      groups,
      allConfiguredCoders
    } = buildClaimEligibilityContext(
      claims,
      facilityConfigs
    );

    const solved =
      solveBalancedCoderLoads(
        groups,
        allConfiguredCoders
      );

    const remainingByGroup = new Map();

    groups.forEach(group => {
      remainingByGroup.set(
        group.signature,
        {
          ...(solved.assignmentCounts.get(
            group.signature
          ) || {})
        }
      );
    });

    const realizedLoads = Object.fromEntries(
      allConfiguredCoders.map(coder => [coder, 0])
    );

    const allocationRows =
      sortedClaims.map(claim => {
        const facilityName =
          getFacilityOutputName(
            claim,
            facilityConfigs
          );

        let coder = UNASSIGNED_CODER;

        if ((claim._eligibleCoders || []).length) {
          const remaining =
            remainingByGroup.get(
              claim._eligibilitySignature
            ) || {};

          const availableCoders =
            claim._eligibleCoders.filter(
              name => (remaining[name] || 0) > 0
            );

          if (availableCoders.length) {
            coder = availableCoders
              .sort(
                (a, b) =>
                  (realizedLoads[a] || 0) -
                    (realizedLoads[b] || 0) ||
                  (solved.coderLoads[a] || 0) -
                    (solved.coderLoads[b] || 0) ||
                  a.localeCompare(b)
              )[0];

            remaining[coder]--;

            realizedLoads[coder] =
              (realizedLoads[coder] || 0) + 1;
          }
        }

        return {
          Facility: facilityName,
          'Claim ID': claim.outputClaimId,
          'Claim Date': claim.claimDate,
          ClaimDateText: claim.claimDateText,
          Department: claim.department,
          CodificationStatus: claim.codificationStatus || '',
          PaymentMode: claim.paymentMode || '',
          PaymentModeCategory:
            claim.paymentModeCategory ||
            getPaymentModeCategory(claim.paymentMode),
          Coder: coder,
          'Date Assigned': allocationDateText,
          Query: '',
          Status: '',
          Notes: claim.codifRemarks || ''
        };
      });

    const fairness =
      verifyAllocationFairness(
        allocationRows,
        sortedClaims,
        allConfiguredCoders
      );

    return {
      allocationRows,
      workload: solved.coderLoads,
      fairness,
      sortedClaims,
      allConfiguredCoders
    };
  }

  function getAllocationSheetRow(
    row,
    allocationDateText
  ) {
    return {
      Facility: row.Facility,
      'Claim ID': row['Claim ID'],
      'Claim Date':
        row['Claim Date'] ||
        row.ClaimDateText ||
        '',
      Department: row.Department,
      'Codification Status': row.CodificationStatus || '',
      'Payment Mode': row.PaymentMode || '',
      Coder: row.Coder,
      'Date Assigned': allocationDateText,
      Query: row.Query,
      Status: row.Status,
      Notes: row.Notes || ''
    };
  }

  function formatNaturalList(parts) {
    const values =
      (parts || [])
        .map(value =>
          String(value || '').trim()
        )
        .filter(Boolean);

    if (!values.length) {
      return '';
    }

    if (values.length === 1) {
      return values[0];
    }

    if (values.length === 2) {
      return `${values[0]} and ${values[1]}`;
    }

    return (
      `${values.slice(0, -1).join(', ')}, ` +
      `and ${values[values.length - 1]}`
    );
  }

  function formatDepartmentCounts(
    departmentCounts
  ) {
    const parts =
      Array.from(
        departmentCounts.entries()
      )
        .filter(([, count]) => count > 0)
        .sort(
          (a, b) =>
            b[1] - a[1] ||
            a[0].localeCompare(b[0])
        )
        .map(
          ([department, count]) =>
            `${count} ${department}`
        );

    return formatNaturalList(parts);
  }

  function formatCoderDateDetail(detail) {
    if (!detail || !detail.total) {
      return '';
    }

    /*
     * Show only payment modes that are actually present. Insurance is listed
     * first, followed by Self-Pay, matching the operational summary wording.
     */
    const paymentParts = [];

    if (detail.insurance > 0) {
      paymentParts.push(
        `${detail.insurance} Insurance`
      );
    }

    if (detail.selfPay > 0) {
      paymentParts.push(
        `${detail.selfPay} Self-Pay`
      );
    }

    const paymentText =
      formatNaturalList(
        paymentParts
      );

    const departmentText =
      formatDepartmentCounts(
        detail.departmentCounts
      );

    const lines = [];

    if (paymentText) {
      lines.push(
        `Payment Mode: ${paymentText}.`
      );
    }

    if (departmentText) {
      lines.push(
        `Departments: ${departmentText}.`
      );
    }

    return lines.join('\n');
  }

  function getSummaryClaimDateInfo(row) {
    const rawDate =
      row['Claim Date'] ||
      row.ClaimDateText ||
      '';

    const parsed =
      rawDate instanceof Date &&
      !Number.isNaN(rawDate.getTime())
        ? rawDate
        : parseDateValue(rawDate);

    if (parsed) {
      return {
        key: formatDate(parsed),
        label: formatDate(parsed),
        sortValue: parsed.getTime()
      };
    }

    const fallback =
      String(
        row.ClaimDateText ||
        rawDate ||
        ''
      ).trim() ||
      '(No Date)';

    return {
      key: fallback,
      label: fallback,
      sortValue:
        Number.POSITIVE_INFINITY
    };
  }

  function buildAllocationSummary(
    allocationRows,
    allConfiguredCoders = []
  ) {
    const coderSummary =
      new Map();
    const facilitySummary =
      new Map();

    /*
     * The hierarchy is built only from claims that were actually assigned.
     * This keeps the Coder Allocation Summary focused on assigned work:
     *
     * Facility
     *   -> Claim Date
     *      -> Assigned Total / Detailed
     */
    const hierarchyMap =
      new Map();

    for (
      const row of
      allocationRows || []
    ) {
      if (
        row.Coder ===
        UNASSIGNED_CODER
      ) {
        continue;
      }

      const facility =
        getFriendlyFacilityName(
          row.Facility
        );

      const dateInfo =
        getSummaryClaimDateInfo(
          row
        );

      if (
        !hierarchyMap.has(
          facility
        )
      ) {
        hierarchyMap.set(
          facility,
          new Map()
        );
      }

      const dateMap =
        hierarchyMap.get(
          facility
        );

      if (
        !dateMap.has(
          dateInfo.key
        )
      ) {
        dateMap.set(
          dateInfo.key,
          dateInfo
        );
      }
    }

    const facilityDateHierarchy =
      Array.from(
        hierarchyMap.entries()
      )
        .map(
          ([facility, dateMap]) => ({
            facility,
            dates:
              Array.from(
                dateMap.values()
              )
                .sort(
                  (a, b) =>
                    a.sortValue -
                      b.sortValue ||
                    a.label.localeCompare(
                      b.label
                    )
                )
          })
        )
        .sort(
          (a, b) =>
            a.facility.localeCompare(
              b.facility
            )
        );

    function createCoderSummaryRow(
      coder
    ) {
      return {
        Coder: coder,
        'Total Assigned Claims': 0,
        _dateDetails:
          new Map()
      };
    }

    function ensureDateDetail(
      coderRow,
      facility,
      dateKey
    ) {
      const key =
        `${facility}|||${dateKey}`;

      if (
        !coderRow
          ._dateDetails
          .has(key)
      ) {
        coderRow
          ._dateDetails
          .set(
            key,
            {
              total: 0,
              selfPay: 0,
              insurance: 0,
              departmentCounts:
                new Map()
            }
          );
      }

      return coderRow
        ._dateDetails
        .get(key);
    }

    allConfiguredCoders.forEach(
      coder => {
        coderSummary.set(
          coder,
          createCoderSummaryRow(
            coder
          )
        );
      }
    );

    for (
      const row of
      allocationRows || []
    ) {
      const isAssigned =
        row.Coder !==
        UNASSIGNED_CODER;

      if (
        isAssigned &&
        !coderSummary.has(
          row.Coder
        )
      ) {
        coderSummary.set(
          row.Coder,
          createCoderSummaryRow(
            row.Coder
          )
        );
      }

      if (isAssigned) {
        const coderRow =
          coderSummary.get(
            row.Coder
          );

        coderRow[
          'Total Assigned Claims'
        ]++;

        const facility =
          getFriendlyFacilityName(
            row.Facility
          );

        const dateInfo =
          getSummaryClaimDateInfo(
            row
          );

        const detail =
          ensureDateDetail(
            coderRow,
            facility,
            dateInfo.key
          );

        detail.total++;

        const paymentCategory =
          row.PaymentModeCategory ||
          getPaymentModeCategory(
            row.PaymentMode
          );

        if (
          paymentCategory ===
          'insurance'
        ) {
          detail.insurance++;
        } else {
          detail.selfPay++;
        }

        const department =
          String(
            row.Department || ''
          ).trim();

        const departmentLabel =
          department
            ? formatDepartmentDisplay(
                department
              )
            : '(Blank)';

        detail.departmentCounts.set(
          departmentLabel,
          (
            detail
              .departmentCounts
              .get(
                departmentLabel
              ) ||
            0
          ) + 1
        );
      }

      if (
        !facilitySummary.has(
          row.Facility
        )
      ) {
        facilitySummary.set(
          row.Facility,
          {
            Facility:
              row.Facility,
            Allocated: 0,
            Unassigned: 0
          }
        );
      }

      facilitySummary
        .get(row.Facility)[
          isAssigned
            ? 'Allocated'
            : 'Unassigned'
        ]++;
    }

    const coderRows =
      Array.from(
        coderSummary.values()
      )
        .map(row => {
          const output = {
            Coder: row.Coder,
            'Total Assigned Claims':
              row[
                'Total Assigned Claims'
              ],
            _dateDetails:
              row._dateDetails
          };

          for (
            const facilityGroup of
            facilityDateHierarchy
          ) {
            for (
              const date of
              facilityGroup.dates
            ) {
              const detailKey =
                `${facilityGroup.facility}|||${date.key}`;

              const detail =
                row._dateDetails.get(
                  detailKey
                ) || {
                  total: 0,
                  selfPay: 0,
                  insurance: 0,
                  departmentCounts:
                    new Map()
                };

              output[
                `${detailKey}|||Assigned Total`
              ] = detail.total;

              output[
                `${detailKey}|||Detailed`
              ] =
                formatCoderDateDetail(
                  detail
                );
            }
          }

          return output;
        })
        .sort(
          (a, b) =>
            a.Coder.localeCompare(
              b.Coder
            )
        );

    return {
      coderRows,
      facilityDateHierarchy,
      facilityAssignedRows:
        Array.from(
          facilitySummary.values()
        )
          .sort(
            (a, b) =>
              a.Facility.localeCompare(
                b.Facility
              )
          )
    };
  }


  function buildFacilityMatrix(
    allocationRows,
    coderRows
  ) {
    const facilities = Array.from(
      new Set(
        allocationRows.map(row => row.Facility)
      )
    ).sort((a, b) => a.localeCompare(b));

    const matrixRows =
      coderRows.map(coderRow => {
        const row = {
          Coder: coderRow.Coder
        };

        let total = 0;

        for (const facility of facilities) {
          const count =
            allocationRows.filter(
              item =>
                item.Coder === coderRow.Coder &&
                item.Facility === facility
            ).length;

          row[facility] = count;
          total += count;
        }

        row.Total = total;
        return row;
      });

    return {
      facilities,
      matrixRows
    };
  }

  function sortCodificationStatuses(statuses) {
    const priority = [
      'new',
      'not seen',
      'under process',
      'completed needs verification',
      'completed-needs verification'
    ];

    return statuses.slice().sort((a, b) => {
      const normA = normalizeStatus(a);
      const normB = normalizeStatus(b);
      const indexA = priority.indexOf(normA);
      const indexB = priority.indexOf(normB);

      if (indexA !== -1 || indexB !== -1) {
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        if (indexA !== indexB) return indexA - indexB;
      }

      return String(a).localeCompare(String(b));
    });
  }

  function buildDepartmentStatusSummary(filteredClaims) {
    const statuses = sortCodificationStatuses(
      Array.from(
        new Set(
          filteredClaims.map(
            claim =>
              String(claim.codificationStatus || '').trim() || '(Blank)'
          )
        )
      )
    );

    const byDepartment = new Map();

    for (const claim of filteredClaims) {
      const department = claim.department || '(Blank)';
      const departmentDisplay = department === '(Blank)'
        ? department
        : formatDepartmentDisplay(department);
      const status =
        String(claim.codificationStatus || '').trim() || '(Blank)';

      if (!byDepartment.has(department)) {
        const initial = {
          Department: departmentDisplay,
          Total: 0
        };
        statuses.forEach(value => {
          initial[value] = 0;
        });
        byDepartment.set(department, initial);
      }

      const row = byDepartment.get(department);
      row[status] = (row[status] || 0) + 1;
      row.Total++;
    }

    return {
      headers: ['Department', ...statuses, 'Total'],
      rows: Array.from(byDepartment.values())
        .sort(
          (a, b) =>
            a.Department.localeCompare(b.Department)
        )
    };
  }

  function formatFacilityExclusionBreakdown(exclusions) {
    const entries = [
      ['Terminal Status (Closed / Submitted / Audited / Verified and Closed / Merged)', exclusions.terminalStatus || 0],
      ['Payment Mode Filter', exclusions.paymentMode || 0],
      ['Department Filter', exclusions.department || 0],
      ['Codification Status Filter', exclusions.codificationStatus || 0],
      ['Already Codified', exclusions.alreadyCodified || 0],
      ['No Bill', exclusions.noBill || 0],
      ['Claim Date Filter', exclusions.claimDate || 0]
    ].filter(([, count]) => count > 0);

    const total = entries.reduce(
      (sum, [, count]) => sum + count,
      0
    );

    if (!total) return '0';

    const parts = entries.map(
      ([label, count]) => `${count} ${label}`
    );

    let detail = '';
    if (parts.length === 1) {
      detail = parts[0];
    } else if (parts.length === 2) {
      detail = `${parts[0]} and ${parts[1]}`;
    } else {
      detail = `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
    }

    return `${total} — ${detail}`;
  }


  function buildSummarySheetData({
    importStats,
    filteredClaims,
    allocationRows,
    fairness,
    facilityConfigs,
    duplicateGroups,
    filterBreakdown
  }) {
    const allocationSummary =
      buildAllocationSummary(
        allocationRows,
        fairness.comparableCoders
      );

    const matrix =
      buildFacilityMatrix(
        allocationRows,
        allocationSummary.coderRows
      );

    const departmentStatus =
      buildDepartmentStatusSummary(
        filteredClaims
      );

    const facilityFiltered = new Map();

    const paymentSet = new Set(
      filterBreakdown?.paymentFiltered || []
    );
    const departmentSet = new Set(
      filterBreakdown?.departmentFiltered || []
    );
    const statusSet = new Set(
      filterBreakdown?.statusFiltered || []
    );
    const codifiedSet = new Set(
      filterBreakdown?.codifiedFiltered || []
    );
    const noBillSet = new Set(
      filterBreakdown?.noBillFiltered || []
    );
    const eligibleSet = new Set(
      filterBreakdown?.eligibleClaims || filteredClaims
    );

    function ensureFacilityRow(claim) {
      if (!facilityFiltered.has(claim.facilityKey)) {
        facilityFiltered.set(
          claim.facilityKey,
          {
            Facility: getFacilityOutputName(
              claim,
              facilityConfigs
            ),
            'Claims Loaded': 0,
            'Excluded / Why': '0',
            Eligible: 0,
            Allocated: 0,
            Unassigned: 0,
            _exclusions: {
              terminalStatus: 0,
              paymentMode: 0,
              department: 0,
              codificationStatus: 0,
              alreadyCodified: 0,
              noBill: 0,
              claimDate: 0
            }
          }
        );
      }

      return facilityFiltered.get(claim.facilityKey);
    }

    /*
     * Reconcile every loaded unique claim to exactly one outcome.  This keeps
     * Claims Loaded = Excluded + Eligible and makes the reason for any gap
     * visible instead of only reporting terminal-status exclusions.
     */
    for (const claim of duplicateGroups) {
      const facilityRow = ensureFacilityRow(claim);
      facilityRow['Claims Loaded']++;

      if (claim.autoExcludedStatus) {
        facilityRow._exclusions.terminalStatus++;
        continue;
      }

      if (!paymentSet.has(claim)) {
        facilityRow._exclusions.paymentMode++;
      } else if (!departmentSet.has(claim)) {
        facilityRow._exclusions.department++;
      } else if (!statusSet.has(claim)) {
        facilityRow._exclusions.codificationStatus++;
      } else if (!codifiedSet.has(claim)) {
        facilityRow._exclusions.alreadyCodified++;
      } else if (!noBillSet.has(claim)) {
        facilityRow._exclusions.noBill++;
      } else if (!eligibleSet.has(claim)) {
        facilityRow._exclusions.claimDate++;
      } else {
        facilityRow.Eligible++;
      }
    }

    for (const facilityRow of facilityFiltered.values()) {
      facilityRow['Excluded / Why'] =
        formatFacilityExclusionBreakdown(
          facilityRow._exclusions
        );
      delete facilityRow._exclusions;
    }

    for (const row of allocationRows) {
      const facilityRow =
        Array.from(
          facilityFiltered.values()
        ).find(
          item =>
            item.Facility === row.Facility
        );

      if (facilityRow) {
        facilityRow[
          row.Coder === UNASSIGNED_CODER
            ? 'Unassigned'
            : 'Allocated'
        ]++;
      }
    }

    const allocatedCount =
      allocationRows.filter(
        row => row.Coder !== UNASSIGNED_CODER
      ).length;

    const unassignedCount =
      allocationRows.filter(
        row => row.Coder === UNASSIGNED_CODER
      ).length;

    return {
      coderRows:
        allocationSummary.coderRows,

      coderFacilityDateHierarchy:
        allocationSummary.facilityDateHierarchy,

      matrixHeaders: [
        'Coder',
        ...matrix.facilities,
        'Total'
      ],

      matrixRows:
        matrix.matrixRows,

      facilityRows:
        Array.from(
          facilityFiltered.values()
        ).sort(
          (a, b) =>
            a.Facility.localeCompare(
              b.Facility
            )
        ),

      departmentHeaders:
        departmentStatus.headers,

      departmentRows:
        departmentStatus.rows,

      topCards: [
        ['Eligible Claims', filteredClaims.length],
        ['Allocated Claims', allocatedCount],
        ['Unassigned Claims', unassignedCount],
        [
          'Facilities',
          Array.from(
            facilityFiltered.values()
          ).length
        ],
        [
          'Terminal Status Excluded',
          importStats.terminalStatusExcluded
        ],
        [
          'Already Codified Excluded',
          importStats.alreadyCodifiedExcluded
        ],
        [
          'Filter Excluded',
          (importStats.paymentModeFilteredOut || 0) +
            (importStats.departmentFilteredOut || 0) +
            (importStats.codificationStatusFilteredOut || 0) +
            (importStats.claimDateFilteredOut || 0)
        ],
        [
          'No-Bill Excluded',
          importStats.noBillExcluded
        ]
      ],

      fairness
    };
  }


  const EXCEL_COLORS = Object.freeze({
    navy: '1F4E78',
    blue: '5B9BD5',
    lightBlue: 'D9EAF7',
    paleBlue: 'EDF4FB',
    lightGray: 'F3F6F9',
    border: 'B8C6D1',
    darkText: '1F2933',
    white: 'FFFFFF',
    total: 'E2F0D9',
    notes: 'FFF8D8'
  });

  const EXCEL_STYLES = Object.freeze({
    title: {
      font: {
        bold: true,
        color: { rgb: EXCEL_COLORS.white },
        sz: 15
      },
      fill: {
        patternType: 'solid',
        fgColor: { rgb: EXCEL_COLORS.navy }
      },
      alignment: {
        horizontal: 'left',
        vertical: 'center'
      }
    },
    section: {
      font: {
        bold: true,
        color: { rgb: EXCEL_COLORS.white },
        sz: 11
      },
      fill: {
        patternType: 'solid',
        fgColor: { rgb: EXCEL_COLORS.blue }
      },
      alignment: {
        horizontal: 'left',
        vertical: 'center'
      }
    },
    header: {
      font: {
        bold: true,
        color: { rgb: EXCEL_COLORS.darkText }
      },
      fill: {
        patternType: 'solid',
        fgColor: { rgb: EXCEL_COLORS.lightBlue }
      },
      border: {
        top: { style: 'thin', color: { rgb: EXCEL_COLORS.border } },
        bottom: { style: 'thin', color: { rgb: EXCEL_COLORS.border } },
        left: { style: 'thin', color: { rgb: EXCEL_COLORS.border } },
        right: { style: 'thin', color: { rgb: EXCEL_COLORS.border } }
      },
      alignment: {
        horizontal: 'center',
        vertical: 'center',
        wrapText: true
      }
    },
    body: {
      border: {
        top: { style: 'thin', color: { rgb: 'D9E1E8' } },
        bottom: { style: 'thin', color: { rgb: 'D9E1E8' } },
        left: { style: 'thin', color: { rgb: 'D9E1E8' } },
        right: { style: 'thin', color: { rgb: 'D9E1E8' } }
      },
      alignment: {
        vertical: 'top'
      }
    },
    altBody: {
      fill: {
        patternType: 'solid',
        fgColor: { rgb: EXCEL_COLORS.paleBlue }
      },
      border: {
        top: { style: 'thin', color: { rgb: 'D9E1E8' } },
        bottom: { style: 'thin', color: { rgb: 'D9E1E8' } },
        left: { style: 'thin', color: { rgb: 'D9E1E8' } },
        right: { style: 'thin', color: { rgb: 'D9E1E8' } }
      },
      alignment: {
        vertical: 'top'
      }
    },
    total: {
      font: { bold: true },
      fill: {
        patternType: 'solid',
        fgColor: { rgb: EXCEL_COLORS.total }
      },
      border: {
        top: { style: 'thin', color: { rgb: EXCEL_COLORS.border } },
        bottom: { style: 'thin', color: { rgb: EXCEL_COLORS.border } },
        left: { style: 'thin', color: { rgb: EXCEL_COLORS.border } },
        right: { style: 'thin', color: { rgb: EXCEL_COLORS.border } }
      }
    },
    notes: {
      fill: {
        patternType: 'solid',
        fgColor: { rgb: EXCEL_COLORS.notes }
      },
      border: {
        top: { style: 'thin', color: { rgb: 'D9E1E8' } },
        bottom: { style: 'thin', color: { rgb: 'D9E1E8' } },
        left: { style: 'thin', color: { rgb: 'D9E1E8' } },
        right: { style: 'thin', color: { rgb: 'D9E1E8' } }
      },
      alignment: {
        vertical: 'top',
        wrapText: true
      }
    }
  });

  function autoSizeColumns(headers, rows) {
    return headers.map(header => {
      const width = Math.max(
        String(header).length,
        ...rows.map(
          row =>
            String(
              row[header] == null
                ? ''
                : row[header]
            ).length
        )
      );

      const maximum =
        header === 'Notes' ? 48 :
        header === 'Department' ? 28 :
        header === 'Facility' ? 32 :
        24;

      return {
        wch: Math.min(
          Math.max(width + 2, 12),
          maximum
        )
      };
    });
  }

  function applyCellStyle(ws, row, col, style) {
    const ref = root.XLSX.utils.encode_cell({ r: row, c: col });
    if (!ws[ref]) return;
    ws[ref].s = style;
  }

  function styleTableRange(
    ws,
    headerRowIndex,
    dataStartRowIndex,
    rowCount,
    columnCount,
    options = {}
  ) {
    const startColumn =
      Number.isInteger(options.startColumn)
        ? options.startColumn
        : 0;

    for (let col = 0; col < columnCount; col++) {
      applyCellStyle(
        ws,
        headerRowIndex,
        startColumn + col,
        EXCEL_STYLES.header
      );
    }

    for (let rowOffset = 0; rowOffset < rowCount; rowOffset++) {
      const style = rowOffset % 2
        ? EXCEL_STYLES.altBody
        : EXCEL_STYLES.body;

      for (let col = 0; col < columnCount; col++) {
        const cellStyle =
          options.notesColumnIndex === col
            ? EXCEL_STYLES.notes
            : style;

        applyCellStyle(
          ws,
          dataStartRowIndex + rowOffset,
          startColumn + col,
          cellStyle
        );
      }
    }
  }


  function buildStyledFacilityWorksheet(title, headers, rows, dateHeaders = new Set()) {
    const aoa = [
      [title],
      [],
      headers,
      ...rows.map(row =>
        headers.map(header => {
          if (
            dateHeaders.has(header) &&
            row[header] instanceof Date
          ) {
            return row[header];
          }
          return row[header] == null ? '' : row[header];
        })
      )
    ];

    const ws = root.XLSX.utils.aoa_to_sheet(aoa);
    const lastCol = headers.length - 1;
    const lastDataRow = Math.max(2, rows.length + 2);

    ws['!merges'] = [{
      s: { r: 0, c: 0 },
      e: { r: 0, c: lastCol }
    }];

    ws['!rows'] = [
      { hpt: 24 },
      { hpt: 6 },
      { hpt: 22 }
    ];

    ws['!freeze'] = {
      xSplit: 0,
      ySplit: 3
    };

    ws['!panes'] = [{
      ySplit: 3,
      topLeftCell: 'A4',
      activePane: 'bottomLeft',
      state: 'frozen'
    }];

    ws['!autofilter'] = {
      ref: root.XLSX.utils.encode_range({
        s: { r: 2, c: 0 },
        e: { r: lastDataRow, c: lastCol }
      })
    };

    ws['!cols'] = autoSizeColumns(headers, rows);

    applyCellStyle(ws, 0, 0, EXCEL_STYLES.title);
    styleTableRange(
      ws,
      2,
      3,
      rows.length,
      headers.length,
      { notesColumnIndex: headers.indexOf('Notes') }
    );

    rows.forEach((row, rowIndex) => {
      headers.forEach((header, colIndex) => {
        const cellRef = root.XLSX.utils.encode_cell({
          r: rowIndex + 3,
          c: colIndex
        });

        if (
          dateHeaders.has(header) &&
          row[header] instanceof Date &&
          ws[cellRef]
        ) {
          ws[cellRef].z = 'dd/mm/yyyy';
        }
      });
    });

    return ws;
  }

  function getFriendlyFacilityName(facility) {
    const text = String(facility || '').trim();
    const normalized = normalizeLoose(text);

    const rules = [
      ['truelife', 'Truelife'],
      ['khabisi', 'Khabisi'],
      ['alyahar', 'Al Yahar'],
      ['extramall', 'Extramall'],
      ['emirates', 'Emirates'],
      ['ivory', 'Ivory'],
      ['lauretta', 'Lauretta'],
      ['majestic', 'Majestic'],
      ['nazek', 'Nazek'],
      ['scandcare', 'Scandcare'],
      ['talat', 'Talat'],
      ['wldy', 'WLDY'],
      ['alwagan', 'Al Wagan'],
      ['korean', 'Korean']
    ];

    for (const [needle, label] of rules) {
      if (normalized.includes(needle)) return label;
    }

    return text
      .replace(/\bmedical\b/ig, '')
      .replace(/\bcenter\b/ig, '')
      .replace(/\bcentre\b/ig, '')
      .replace(/\bprimary care\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Facility';
  }

  function makeUniqueSheetName(facility, usedNames) {
    const base = `${getFriendlyFacilityName(facility)} Allocation`
      .replace(/[\\/?*\[\]:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 31) || 'Facility Allocation';

    let candidate = base;
    let suffix = 2;

    while (usedNames.has(candidate.toLowerCase())) {
      const suffixText = ` ${suffix}`;
      candidate = `${base.slice(0, 31 - suffixText.length)}${suffixText}`;
      suffix++;
    }

    usedNames.add(candidate.toLowerCase());
    return candidate;
  }

  function setSummaryCell(aoa, rowIndex, colIndex, value) {
    while (aoa.length <= rowIndex) {
      aoa.push([]);
    }

    while (aoa[rowIndex].length <= colIndex) {
      aoa[rowIndex].push('');
    }

    aoa[rowIndex][colIndex] =
      value == null ? '' : value;
  }

  function placeSummarySection(
    aoa,
    sections,
    merges,
    {
      title,
      headers,
      rows,
      startRow,
      startColumn
    }
  ) {
    const sectionRow = startRow;
    const headerRow = startRow + 1;
    const dataStartRow = startRow + 2;

    setSummaryCell(
      aoa,
      sectionRow,
      startColumn,
      title
    );

    headers.forEach((header, index) => {
      setSummaryCell(
        aoa,
        headerRow,
        startColumn + index,
        header
      );
    });

    rows.forEach((row, rowOffset) => {
      headers.forEach((header, colOffset) => {
        setSummaryCell(
          aoa,
          dataStartRow + rowOffset,
          startColumn + colOffset,
          row[header] ?? ''
        );
      });
    });

    merges.push({
      s: {
        r: sectionRow,
        c: startColumn
      },
      e: {
        r: sectionRow,
        c: startColumn + headers.length - 1
      }
    });

    sections.push({
      sectionRow,
      headerRow,
      dataStartRow,
      rowCount: rows.length,
      columnCount: headers.length,
      startColumn,
      title,
      headers
    });

    return rows.length
      ? dataStartRow + rows.length - 1
      : headerRow;
  }

  function placeCoderSummarySection(
    aoa,
    sections,
    merges,
    rows,
    facilityDateHierarchy,
    startRow,
    startColumn
  ) {
    const sectionRow =
      startRow;
    const facilityHeaderRow =
      startRow + 1;
    const dateHeaderRow =
      startRow + 2;
    const subHeaderRow =
      startRow + 3;
    const dataStartRow =
      startRow + 4;

    const fixedHeaders = [
      'Coder',
      'Total Assigned Claims'
    ];

    const hierarchyColumnCount =
      facilityDateHierarchy.reduce(
        (sum, facilityGroup) =>
          sum +
          facilityGroup.dates.length *
            2,
        0
      );

    const columnCount =
      fixedHeaders.length +
      hierarchyColumnCount;

    setSummaryCell(
      aoa,
      sectionRow,
      startColumn,
      'Coder Allocation Summary'
    );

    fixedHeaders.forEach(
      (header, index) => {
        const column =
          startColumn + index;

        setSummaryCell(
          aoa,
          facilityHeaderRow,
          column,
          header
        );

        merges.push({
          s: {
            r: facilityHeaderRow,
            c: column
          },
          e: {
            r: subHeaderRow,
            c: column
          }
        });
      }
    );

    let column =
      startColumn +
      fixedHeaders.length;

    for (
      const facilityGroup of
      facilityDateHierarchy
    ) {
      const facilityStartColumn =
        column;

      for (
        const date of
        facilityGroup.dates
      ) {
        setSummaryCell(
          aoa,
          dateHeaderRow,
          column,
          date.label
        );

        merges.push({
          s: {
            r: dateHeaderRow,
            c: column
          },
          e: {
            r: dateHeaderRow,
            c: column + 1
          }
        });

        setSummaryCell(
          aoa,
          subHeaderRow,
          column,
          'Assigned Total'
        );

        setSummaryCell(
          aoa,
          subHeaderRow,
          column + 1,
          'Detailed'
        );

        column += 2;
      }

      const facilityEndColumn =
        column - 1;

      setSummaryCell(
        aoa,
        facilityHeaderRow,
        facilityStartColumn,
        facilityGroup.facility
      );

      if (
        facilityEndColumn >
        facilityStartColumn
      ) {
        merges.push({
          s: {
            r: facilityHeaderRow,
            c:
              facilityStartColumn
          },
          e: {
            r: facilityHeaderRow,
            c:
              facilityEndColumn
          }
        });
      }
    }

    rows.forEach(
      (row, rowOffset) => {
        const targetRow =
          dataStartRow +
          rowOffset;

        fixedHeaders.forEach(
          (header, index) => {
            setSummaryCell(
              aoa,
              targetRow,
              startColumn + index,
              row[header] ?? ''
            );
          }
        );

        let targetColumn =
          startColumn +
          fixedHeaders.length;

        for (
          const facilityGroup of
          facilityDateHierarchy
        ) {
          for (
            const date of
            facilityGroup.dates
          ) {
            const detailKey =
              `${facilityGroup.facility}|||${date.key}`;

            setSummaryCell(
              aoa,
              targetRow,
              targetColumn,
              row[
                `${detailKey}|||Assigned Total`
              ] ?? 0
            );

            setSummaryCell(
              aoa,
              targetRow,
              targetColumn + 1,
              row[
                `${detailKey}|||Detailed`
              ] || ''
            );

            targetColumn += 2;
          }
        }
      }
    );

    merges.push({
      s: {
        r: sectionRow,
        c: startColumn
      },
      e: {
        r: sectionRow,
        c:
          startColumn +
          columnCount -
          1
      }
    });

    sections.push({
      sectionRow,
      headerRow:
        subHeaderRow,
      extraHeaderRows: [
        facilityHeaderRow,
        dateHeaderRow
      ],
      dataStartRow,
      rowCount:
        rows.length,
      columnCount,
      startColumn,
      kind:
        'coderSummary',
      facilityDateHierarchy
    });

    return rows.length
      ? dataStartRow +
          rows.length -
          1
      : subHeaderRow;
  }

  function emphasizeSummaryCell(ws, row, col, mode) {
    const ref =
      root.XLSX.utils.encode_cell({
        r: row,
        c: col
      });

    if (!ws[ref]) return;

    const currentStyle =
      ws[ref].s || {};

    const currentFont =
      currentStyle.font || {};

    ws[ref].s = {
      ...currentStyle,
      font: {
        ...currentFont,
        bold:
          mode === 'important'
            ? true
            : Boolean(
                currentFont.bold
              ),
        italic:
          mode === 'secondary'
            ? true
            : Boolean(
                currentFont.italic
              )
      }
    };
  }

  function applySummaryEmphasis(
    ws,
    sections
  ) {
    for (const section of sections) {
      for (
        let rowOffset = 0;
        rowOffset < section.rowCount;
        rowOffset++
      ) {
        const row =
          section.dataStartRow +
          rowOffset;

        if (
          section.kind ===
          'coderSummary'
        ) {
          /*
           * Coder stays neutral.
           * Total Assigned Claims and each date's Assigned Total are important.
           * Detailed is supporting information.
           */
          emphasizeSummaryCell(
            ws,
            row,
            section.startColumn + 1,
            'important'
          );

          for (
            let colOffset = 2;
            colOffset <
            section.columnCount;
            colOffset += 2
          ) {
            emphasizeSummaryCell(
              ws,
              row,
              section.startColumn +
                colOffset,
              'important'
            );

            emphasizeSummaryCell(
              ws,
              row,
              section.startColumn +
                colOffset + 1,
              'secondary'
            );
          }

          continue;
        }

        if (
          section.title ===
          'Facility Summary'
        ) {
          /*
           * Facility name stays neutral.
           * Eligible + Allocated are the important operational numbers.
           * Loaded / exclusion explanation / unassigned are supporting.
           */
          [1, 2, 5].forEach(
            colOffset =>
              emphasizeSummaryCell(
                ws,
                row,
                section.startColumn +
                  colOffset,
                'secondary'
              )
          );

          [3, 4].forEach(
            colOffset =>
              emphasizeSummaryCell(
                ws,
                row,
                section.startColumn +
                  colOffset,
                'important'
              )
          );

          continue;
        }

        if (
          section.title ===
          'Coder Claims per Facility'
        ) {
          /*
           * Coder stays neutral. Facility counts are supporting;
           * the final Total is important.
           */
          for (
            let colOffset = 1;
            colOffset <
            section.columnCount - 1;
            colOffset++
          ) {
            emphasizeSummaryCell(
              ws,
              row,
              section.startColumn +
                colOffset,
              'secondary'
            );
          }

          if (
            section.columnCount > 1
          ) {
            emphasizeSummaryCell(
              ws,
              row,
              section.startColumn +
                section.columnCount -
                1,
              'important'
            );
          }

          continue;
        }

        if (
          section.title ===
          'Department Status Summary'
        ) {
          /*
           * Department stays neutral. Status splits are supporting;
           * Total is important.
           */
          for (
            let colOffset = 1;
            colOffset <
            section.columnCount - 1;
            colOffset++
          ) {
            emphasizeSummaryCell(
              ws,
              row,
              section.startColumn +
                colOffset,
              'secondary'
            );
          }

          if (
            section.columnCount > 1
          ) {
            emphasizeSummaryCell(
              ws,
              row,
              section.startColumn +
                section.columnCount -
                1,
              'important'
            );
          }
        }
      }
    }
  }


  function forceSummaryNumericCells(ws, sections, aoa) {
    for (const section of sections) {
      for (let rowOffset = 0; rowOffset < section.rowCount; rowOffset++) {
        for (let col = 0; col < section.columnCount; col++) {
          const rowIndex =
            section.dataStartRow + rowOffset;
          const columnIndex =
            section.startColumn + col;
          const value =
            aoa[rowIndex]?.[columnIndex];

          if (
            typeof value !== 'number' ||
            !Number.isFinite(value)
          ) {
            continue;
          }

          const ref = root.XLSX.utils.encode_cell({
            r: rowIndex,
            c: columnIndex
          });

          if (!ws[ref]) continue;

          ws[ref].t = 'n';
          ws[ref].v = value;
          ws[ref].z = '0';
          delete ws[ref].w;
        }
      }
    }
  }

  function autoFitCoderAllocationDetails(
    ws,
    aoa,
    maximumColumns,
    coderSection
  ) {
    const widths = [];

    for (
      let col = 0;
      col < maximumColumns;
      col++
    ) {
      let maxLineLength = 1;

      for (
        let row = 0;
        row < aoa.length;
        row++
      ) {
        const value =
          aoa[row]?.[col];

        if (
          value == null ||
          value === ''
        ) {
          continue;
        }

        const lines =
          String(value).split(
            /\r?\n/
          );

        for (const line of lines) {
          maxLineLength =
            Math.max(
              maxLineLength,
              line.length
            );
        }
      }

      let minWidth = 8;
      let maxWidth = 24;

      if (col === 0) {
        minWidth = 16;
        maxWidth = 28;
      } else if (col === 1) {
        minWidth = 14;
        maxWidth = 20;
      } else if (
        coderSection &&
        col >= 2 &&
        col <
          coderSection.columnCount
      ) {
        const isDetailed =
          (col - 2) % 2 === 1;

        if (isDetailed) {
          minWidth = 24;
          maxWidth = 42;
        } else {
          minWidth = 11;
          maxWidth = 16;
        }
      }

      widths.push({
        wch:
          Math.min(
            Math.max(
              maxLineLength + 2,
              minWidth
            ),
            maxWidth
          )
      });
    }

    ws['!cols'] = widths;

    /*
     * Estimate wrapped row height from the fitted column widths. This keeps
     * short rows tight while expanding Detailed rows only when their content
     * actually wraps.
     */
    ws['!rows'] =
      ws['!rows'] || [];

    for (
      let row = 0;
      row < aoa.length;
      row++
    ) {
      let requiredLines = 1;

      for (
        let col = 0;
        col < maximumColumns;
        col++
      ) {
        const value =
          aoa[row]?.[col];

        if (
          value == null ||
          value === ''
        ) {
          continue;
        }

        const width =
          widths[col]?.wch || 10;

        const explicitLines =
          String(value).split(
            /\r?\n/
          );

        let cellLines = 0;

        for (
          const line of
          explicitLines
        ) {
          cellLines +=
            Math.max(
              1,
              Math.ceil(
                line.length /
                Math.max(
                  width - 1,
                  1
                )
              )
            );
        }

        requiredLines =
          Math.max(
            requiredLines,
            cellLines
          );
      }

      /*
       * Title/header rows remain compact; data rows scale with wrapped text.
       */
      const isTitleRow =
        row === 0;

      const isHeaderRow =
        coderSection &&
        row >=
          coderSection.sectionRow &&
        row <
          coderSection.dataStartRow;

      if (isTitleRow) {
        ws['!rows'][row] = {
          hpt: 20
        };
      } else if (isHeaderRow) {
        ws['!rows'][row] = {
          hpt:
            Math.max(
              18,
              requiredLines * 15
            )
        };
      } else {
        ws['!rows'][row] = {
          hpt:
            Math.max(
              16,
              requiredLines * 15
            )
        };
      }
    }
  }


  function buildStyledCoderAllocationDetailsWorksheet(
    summaryData
  ) {
    const aoa = [
      ['Coder Allocation Details']
    ];
    const sections = [];
    const merges = [];

    const topStartRow = 1;

    /*
     * This sheet is intentionally dedicated to the wide coder allocation
     * hierarchy:
     *
     * Coder
     * Total Assigned Claims
     * Facility > Claim Date > Assigned Total / Detailed
     *
     * No other summary tables share this sheet.
     */
    placeCoderSummarySection(
      aoa,
      sections,
      merges,
      summaryData.coderRows,
      summaryData.coderFacilityDateHierarchy || [],
      topStartRow,
      0
    );

    const coderColumnCount =
      2 +
      (
        summaryData
          .coderFacilityDateHierarchy ||
        []
      ).reduce(
        (sum, facilityGroup) =>
          sum +
          facilityGroup.dates.length *
            2,
        0
      );

    const maximumColumns =
      Math.max(
        coderColumnCount,
        2
      );

    merges.unshift({
      s: { r: 0, c: 0 },
      e: {
        r: 0,
        c:
          maximumColumns -
          1
      }
    });

    const ws =
      root.XLSX.utils.aoa_to_sheet(
        aoa
      );

    ws['!merges'] = merges;

    applyCellStyle(
      ws,
      0,
      0,
      EXCEL_STYLES.title
    );

    ws['!rows'] = [];

    for (const section of sections) {
      applyCellStyle(
        ws,
        section.sectionRow,
        section.startColumn,
        EXCEL_STYLES.section
      );

      (
        section
          .extraHeaderRows ||
        []
      ).forEach(
        headerRowIndex => {
          for (
            let col = 0;
            col <
            section.columnCount;
            col++
          ) {
            applyCellStyle(
              ws,
              headerRowIndex,
              section.startColumn +
                col,
              EXCEL_STYLES.header
            );
          }

        }
      );

      styleTableRange(
        ws,
        section.headerRow,
        section.dataStartRow,
        section.rowCount,
        section.columnCount,
        {
          startColumn:
            section.startColumn
        }
      );

    }

    const coderSection =
      sections.find(
        section =>
          section.kind ===
          'coderSummary'
      );

    if (coderSection) {
      for (
        let rowOffset = 0;
        rowOffset <
        coderSection.rowCount;
        rowOffset++
      ) {
        const rowIndex =
          coderSection
            .dataStartRow +
          rowOffset;


        /*
         * Under each Facility > Claim Date pair, the second leaf column is
         * Detailed. Wrap the payment/department split text.
         */
        for (
          let colOffset = 3;
          colOffset <
          coderSection
            .columnCount;
          colOffset += 2
        ) {
          const ref =
            root.XLSX.utils
              .encode_cell({
                r: rowIndex,
                c:
                  coderSection
                    .startColumn +
                  colOffset
              });

          if (ws[ref]) {
            const baseStyle =
              rowOffset % 2
                ? EXCEL_STYLES
                    .altBody
                : EXCEL_STYLES
                    .body;

            ws[ref].s = {
              ...baseStyle,
              alignment: {
                ...(
                  baseStyle
                    .alignment ||
                  {}
                ),
                vertical:
                  'top',
                wrapText:
                  true
              }
            };
          }
        }
      }
    }

    applySummaryEmphasis(
      ws,
      sections
    );

    forceSummaryNumericCells(
      ws,
      sections,
      aoa
    );

    autoFitCoderAllocationDetails(
      ws,
      aoa,
      maximumColumns,
      coderSection
    );

    /*
     * The blank spacer row is gone, leaving five heading rows:
     * 1 title, 2 section title, 3 facility, 4 claim date,
     * 5 Assigned Total / Detailed.
     *
     * Freeze those five heading rows plus the first two columns. Freezing six
     * rows now would unnecessarily freeze the first coder-data row.
     */
    ws['!freeze'] = {
      xSplit: 2,
      ySplit: 5
    };

    ws['!panes'] = [{
      xSplit: 2,
      ySplit: 5,
      topLeftCell: 'C6',
      activePane: 'bottomRight',
      state: 'frozen'
    }];

    return ws;
  }


  function buildStyledDetailedSummariesWorksheet(
    summaryData
  ) {
    const aoa = [
      ['Detailed Summaries'],
      []
    ];
    const sections = [];
    const merges = [];

    const topStartRow = 2;

    const facilityEndRow =
      placeSummarySection(
        aoa,
        sections,
        merges,
        {
          title:
            'Facility Summary',
          headers: [
            'Facility',
            'Claims Loaded',
            'Excluded / Why',
            'Eligible',
            'Allocated',
            'Unassigned'
          ],
          rows:
            summaryData.facilityRows,
          startRow:
            topStartRow,
          startColumn:
            0
        }
      );

    const departmentEndRow =
      placeSummarySection(
        aoa,
        sections,
        merges,
        {
          title:
            'Department Status Summary',
          headers:
            summaryData.departmentHeaders,
          rows:
            summaryData.departmentRows,
          startRow:
            topStartRow,
          startColumn:
            8
        }
      );

    const matrixStartRow =
      Math.max(
        facilityEndRow,
        departmentEndRow
      ) + 2;

    placeSummarySection(
      aoa,
      sections,
      merges,
      {
        title:
          'Coder Claims per Facility',
        headers:
          summaryData.matrixHeaders,
        rows:
          summaryData.matrixRows,
        startRow:
          matrixStartRow,
        startColumn:
          0
      }
    );

    const maximumColumns =
      Math.max(
        summaryData
          .matrixHeaders
          .length,
        8 +
          summaryData
            .departmentHeaders
            .length,
        7
      );

    merges.unshift({
      s: { r: 0, c: 0 },
      e: {
        r: 0,
        c:
          maximumColumns -
          1
      }
    });

    const ws =
      root.XLSX.utils.aoa_to_sheet(
        aoa
      );

    ws['!merges'] = merges;

    applyCellStyle(
      ws,
      0,
      0,
      EXCEL_STYLES.title
    );

    ws['!rows'] = [];
    ws['!rows'][0] = {
      hpt: 24
    };
    ws['!rows'][1] = {
      hpt: 6
    };

    for (const section of sections) {
      applyCellStyle(
        ws,
        section.sectionRow,
        section.startColumn,
        EXCEL_STYLES.section
      );

      styleTableRange(
        ws,
        section.headerRow,
        section.dataStartRow,
        section.rowCount,
        section.columnCount,
        {
          startColumn:
            section.startColumn
        }
      );

      ws['!rows'][
        section.headerRow
      ] = {
        hpt: 30
      };
    }

    applySummaryEmphasis(
      ws,
      sections
    );

    forceSummaryNumericCells(
      ws,
      sections,
      aoa
    );

    const widths = [];

    for (
      let col = 0;
      col <
      maximumColumns;
      col++
    ) {
      let maxLength = 10;

      for (
        let row = 0;
        row <
        aoa.length;
        row++
      ) {
        const value =
          aoa[row]?.[col];

        if (
          value != null
        ) {
          maxLength =
            Math.max(
              maxLength,
              String(value)
                .length + 2
            );
        }
      }

      let width =
        Math.min(
          Math.max(
            maxLength,
            10
          ),
          24
        );

      if (col === 0) {
        width =
          Math.min(
            Math.max(
              maxLength,
              24
            ),
            32
          );
      }

      if (col === 2) {
        width =
          Math.min(
            Math.max(
              maxLength,
              28
            ),
            60
          );
      }

      if (col === 7) {
        width =
          Math.max(
            width,
            4
          );
      }

      widths.push({
        wch: width
      });
    }

    ws['!cols'] = widths;

    return ws;
  }


  function buildWorkbook(lastAllocationResult) {
    const wb = root.XLSX.utils.book_new();
    const summaryData = lastAllocationResult.summaryData;

    wb.Props = {
      Title: 'Facility Allocation',
      Subject: 'Claims allocation by facility and coder',
      Author: 'Allocator',
      CreatedDate: new Date()
    };

    const wsCoderAllocationDetails =
      buildStyledCoderAllocationDetailsWorksheet(
        summaryData
      );

    root.XLSX.utils.book_append_sheet(
      wb,
      wsCoderAllocationDetails,
      'Coder Allocation Details'
    );

    const wsDetailedSummaries =
      buildStyledDetailedSummariesWorksheet(
        summaryData
      );

    root.XLSX.utils.book_append_sheet(
      wb,
      wsDetailedSummaries,
      'Detailed Summaries'
    );

    const allocationHeaders = [
      'Facility',
      'Claim ID',
      'Claim Date',
      'Department',
      'Codification Status',
      'Payment Mode',
      'Coder',
      'Date Assigned',
      'Query',
      'Status',
      'Notes'
    ];

    const rowsByFacility = new Map();

    for (const row of lastAllocationResult.allocationRows) {
      if (!rowsByFacility.has(row.Facility)) {
        rowsByFacility.set(row.Facility, []);
      }
      rowsByFacility.get(row.Facility).push(
        getAllocationSheetRow(
          row,
          lastAllocationResult.allocationDate
        )
      );
    }

    const usedSheetNames = new Set([
      'coder allocation details',
      'detailed summaries'
    ]);

    Array.from(rowsByFacility.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([facility, rows]) => {
        const sheetName =
          makeUniqueSheetName(
            facility,
            usedSheetNames
          );

        const worksheet =
          buildStyledFacilityWorksheet(
            `${getFriendlyFacilityName(facility)} Facility Allocation`,
            allocationHeaders,
            rows,
            new Set(['Claim Date'])
          );

        root.XLSX.utils.book_append_sheet(
          wb,
          worksheet,
          sheetName
        );
      });

    return wb;
  }


  function renderSummaryCards(
    importStats
  ) {
    const importSummary =
      getEl('import-summary');

    if (!importSummary) return;

    const cards = [
      [
        'Reports Loaded',
        importStats.reportsLoaded
      ],
      [
        'Rows Detected',
        importStats.rowsDetected
      ],
      [
        'Facilities Found',
        importStats.facilitiesFound
      ],
      [
        'Eligible Claims',
        importStats.eligibleClaims
      ],
      [
        'Duplicate Claims Resolved',
        importStats.duplicateClaimsResolved
      ],
      [
        'Automatically Excluded',
        importStats.automaticallyExcluded
      ]
    ];

    importSummary.innerHTML =
      cards.map(
        ([label, value]) => `
          <div class="summary-card">
            <span class="label">${escapeHtml(label)}</span>
            <span class="value">${escapeHtml(value)}</span>
          </div>
        `
      ).join('');
  }

  function getFacilityTabLabel(displayName) {
    const text = String(displayName || '').trim();
    if (!text) return 'Facility';

    const parenthetical = text.match(/\(([^)]+)\)\s*$/);
    if (parenthetical && parenthetical[1].trim()) {
      return parenthetical[1].trim();
    }

    return getFriendlyFacilityName(text) || text;
  }

  function renderDepartmentChips(facilityKey, coderIndex, row) {
    const entries = [];
    const seen = new Set();

    normalizeDepartmentList(row?.assignedDepartments || [])
      .forEach(department => {
        const key = normalizeDepartmentKey(department);
        if (!key || seen.has(key)) return;
        seen.add(key);
        entries.push({ department, type: 'assigned' });
      });

    normalizeDepartmentList(row?.preferredDepartments || [])
      .forEach(department => {
        const key = normalizeDepartmentKey(department);
        if (!key || seen.has(key)) return;
        seen.add(key);
        entries.push({ department, type: 'preferred' });
      });

    entries.sort((a, b) => a.department.localeCompare(b.department));

    return entries.map(({ department, type }) => {
      const assigned = type === 'assigned';
      const roleLabel = assigned ? 'A' : 'P';
      const roleTitle = assigned
        ? 'Assigned department — hard override. Click to change to Preferred.'
        : 'Preferred department — soft preference. Click to change to Assigned.';

      return `
        <span class="department-chip ${assigned ? 'department-chip-assigned' : 'department-chip-preferred'}">
          <button
            type="button"
            class="department-chip-role"
            data-action="toggle-department-chip"
            data-facility-key="${escapeHtml(facilityKey)}"
            data-coder-index="${coderIndex}"
            data-department-type="${escapeHtml(type)}"
            data-department="${escapeHtml(department)}"
            aria-label="${escapeHtml(roleTitle)}"
            title="${escapeHtml(roleTitle)}"
          >${roleLabel}</button>
          <span>${escapeHtml(department)}</span>
          <button
            type="button"
            class="department-chip-remove"
            data-action="remove-department-chip"
            data-facility-key="${escapeHtml(facilityKey)}"
            data-coder-index="${coderIndex}"
            data-department-type="${escapeHtml(type)}"
            data-department="${escapeHtml(department)}"
            aria-label="Remove ${escapeHtml(department)}"
            title="Remove ${escapeHtml(department)}"
          >&times;</button>
        </span>
      `;
    }).join('');
  }

  function renderCoderEditorRows(facilityKey, config, departmentListId) {
    const rows = getConfigCoderRows(config);

    if (!rows.length) {
      return `
        <div class="coder-editor-empty">
          No coders configured. Use <strong>Add Coder</strong> or reload the preset defaults.
        </div>
      `;
    }

    return rows.map((row, coderIndex) => `
      <div class="coder-config-row" data-coder-index="${coderIndex}">
        <div class="coder-config-field coder-name-field">
          <label class="coder-field-label">Coder</label>
          <input
            type="text"
            class="form-control form-control-sm coder-name-input"
            data-facility-key="${escapeHtml(facilityKey)}"
            data-coder-index="${coderIndex}"
            value="${escapeHtml(row.name || '')}"
            placeholder="Coder name"
          />
        </div>

        <div class="coder-config-field">
          <label class="coder-field-label">Departments</label>
          <div class="department-tag-editor combined-department-editor">
            <div class="department-chip-list">
              ${renderDepartmentChips(
                facilityKey,
                coderIndex,
                row
              )}
            </div>
            <input
              type="text"
              class="department-tag-input"
              data-facility-key="${escapeHtml(facilityKey)}"
              data-coder-index="${coderIndex}"
              list="${escapeHtml(departmentListId)}"
              placeholder="Add / assign department…"
              autocomplete="off"
              title="Newly added departments are Assigned by default"
            />
          </div>
        </div>

        <div class="coder-config-actions">
          <button
            type="button"
            class="btn btn-outline-danger btn-sm remove-coder-row-btn"
            data-facility-key="${escapeHtml(facilityKey)}"
            data-coder-index="${coderIndex}"
            title="Remove coder"
          >Remove</button>
        </div>
      </div>
    `).join('');
  }

  function renderFacilitySummary() {
    const container = getEl('facility-summary-list');
    const configsContainer = getEl('facility-configs');

    if (!container || !configsContainer) return;

    const facilityStats = getFacilityClaimStats(state.dedupedClaims);

    container.innerHTML = `
      <div class="summary-muted">
        <strong>${facilityStats.length}</strong>
        ${facilityStats.length === 1 ? 'facility' : 'facilities'} detected
      </div>
    `;

    if (!facilityStats.length) {
      configsContainer.innerHTML = '';
      state.activeFacilityTab = '';
      return;
    }

    const validFacilityKeys = new Set(facilityStats.map(item => item.facilityKey));
    if (!validFacilityKeys.has(state.activeFacilityTab)) {
      const savedTab = String(state.persistedUserState?.activeFacilityTab || '');
      state.activeFacilityTab = validFacilityKeys.has(savedTab)
        ? savedTab
        : facilityStats[0].facilityKey;
    }

    const tabButtons = facilityStats.map(item => {
      const config = state.facilityConfigs[item.facilityKey] ||
        createFacilityConfig(item.facilityKey, item.presetName);
      const presetName = config.presetName || item.presetName || '';
      const displayName = presetName || item.displayName;
      const tabLabel = getFacilityTabLabel(displayName);
      const active = item.facilityKey === state.activeFacilityTab;
      const statusClass = presetName ? 'tab-status-ok' : 'tab-status-bad';

      return `
        <button
          type="button"
          class="facility-tab-btn ${active ? 'active' : ''}"
          data-facility-tab-key="${escapeHtml(item.facilityKey)}"
          role="tab"
          aria-selected="${active ? 'true' : 'false'}"
          title="${escapeHtml(displayName)}"
        >
          <span class="facility-tab-name">${escapeHtml(tabLabel)}</span>
          <span class="facility-tab-meta">${item.count} claim${item.count === 1 ? '' : 's'}</span>
          <span class="facility-tab-dot ${statusClass}" aria-hidden="true"></span>
        </button>
      `;
    }).join('');

    const tabPanels = facilityStats.map((item, facilityIndex) => {
      const config = state.facilityConfigs[item.facilityKey] ||
        createFacilityConfig(item.facilityKey, item.presetName);
      const presetName = config.presetName || '';
      const displayName = presetName || item.displayName;
      const active = item.facilityKey === state.activeFacilityTab;
      const departments = getFacilityDepartmentOptions(item.facilityKey);
      const departmentListId = `facility-departments-${facilityIndex}`;

      return `
        <section
          class="facility-tab-panel"
          data-facility-panel-key="${escapeHtml(item.facilityKey)}"
          role="tabpanel"
          ${active ? '' : 'hidden'}
        >
          <div class="facility-tab-panel-header">
            <div>
              <div class="facility-tab-panel-title">${escapeHtml(displayName)}</div>
              <div class="facility-config-meta">${departments.length} department${departments.length === 1 ? '' : 's'} available for preference/assignment.</div>
            </div>
            <div class="facility-tab-panel-count">${item.count} eligible claim${item.count === 1 ? '' : 's'}</div>
          </div>

          <div class="facility-config-body">
            <div class="facility-rules-note mb-3">
              Department chips share one field. <span class="department-legend-chip preferred">P</span> means <strong>Preferred</strong> (soft hint) and
              <span class="department-legend-chip assigned">A</span> means <strong>Assigned</strong> (manual hard override).
              New departments you add are Assigned by default. Click the P/A badge on a chip to switch its mode.
            </div>

            <div class="facility-toolbar mb-3">
              <div class="facility-preset-control">
                <label class="form-label fw-bold small mb-1">Preset</label>
                <select
                  class="form-select form-select-sm facility-preset-select"
                  data-facility-key="${escapeHtml(item.facilityKey)}"
                >
                  <option value="">-- None --</option>
                  ${state.presetOptions.map(name => `
                    <option value="${escapeHtml(name)}" ${name === presetName ? 'selected' : ''}>
                      ${escapeHtml(name)}
                    </option>
                  `).join('')}
                </select>
              </div>

              <div class="facility-toolbar-actions">
                <button
                  type="button"
                  class="btn btn-outline-secondary btn-sm facility-reset-coders-btn"
                  data-facility-key="${escapeHtml(item.facilityKey)}"
                  ${presetName ? '' : 'disabled'}
                  title="Reload coder names and preferred departments from the selected preset; assigned departments will be cleared"
                >Use Preset Defaults</button>
                <button
                  type="button"
                  class="btn btn-outline-primary btn-sm add-coder-row-btn"
                  data-facility-key="${escapeHtml(item.facilityKey)}"
                >Add Coder</button>
              </div>
            </div>

            <datalist id="${escapeHtml(departmentListId)}">
              ${departments.map(department =>
                `<option value="${escapeHtml(department)}"></option>`
              ).join('')}
            </datalist>

            <div class="coder-config-grid-header" aria-hidden="true">
              <span>Coder</span>
              <span>Departments</span>
              <span></span>
            </div>
            <div class="coder-config-rows">
              ${renderCoderEditorRows(item.facilityKey, config, departmentListId)}
            </div>
          </div>
        </section>
      `;
    }).join('');

    configsContainer.innerHTML = `
      <div class="facility-tabs" role="tablist" aria-label="Facility coder assignments">
        ${tabButtons}
      </div>
      <div class="facility-tab-panels">${tabPanels}</div>
    `;
  }

  function countEntries(entries) {
    const counts = {};

    for (const entry of entries) {
      counts[entry] =
        (counts[entry] || 0) + 1;
    }

    return Object.entries(counts)
      .sort(
        (a, b) =>
          a[0].localeCompare(b[0])
      );
  }

  function createCheckItems(
    container,
    items,
    selectedValues,
    defaultChecked = true
  ) {
    if (!container) return;

    if (!items.length) {
      container.textContent =
        'No values found.';
      return;
    }

    container.innerHTML =
      items.map(
        ([value, count]) => {
          const checked =
            selectedValues instanceof Set
              ? selectedValues.has(value)
              : defaultChecked;

          return `
            <div class="form-check">
              <input
                class="form-check-input"
                type="checkbox"
                value="${escapeHtml(value)}"
                ${checked ? 'checked' : ''}
              >
              <label class="form-check-label">
                (${count}) ${escapeHtml(value)}
              </label>
            </div>
          `;
        }
      ).join('');
  }

  function refreshFilterOptions() {
    const paymentContainer =
      getEl('payment-mode-section');

    const deptContainer =
      getEl('dept-section');

    const statusContainer =
      getEl('codif-status-section');

    const codifiedByContainer =
      getEl('codified-by-section');

    const claimDateContainer =
      getEl('claim-date-section');

    const noBillLabel =
      getEl('no-bill-count-label');

    const paymentCounts =
      countEntries(
        state.dedupedClaims
          .map(claim => claim.paymentMode)
          .filter(Boolean)
      );

    const paymentFiltered =
      state.dedupedClaims.filter(
        claim =>
          !claim.paymentMode ||
          state.filterState.paymentModes
            .has(claim.paymentMode)
      );

    const departmentCounts =
      countEntries(
        paymentFiltered
          .map(claim => claim.department)
          .filter(Boolean)
      );

    const departmentFiltered =
      paymentFiltered.filter(
        claim =>
          !claim.department ||
          state.filterState.departments
            .has(claim.department)
      );

    const statusCounts =
      countEntries(
        departmentFiltered
          .map(
            claim =>
              claim.codificationStatus
          )
          .filter(Boolean)
      );

    const statusFiltered =
      departmentFiltered.filter(
        claim =>
          !claim.codificationStatus ||
          state.filterState.codifStatuses
            .has(
              claim.codificationStatus
            )
      );

    const codifiedByCounts =
      countEntries(
        statusFiltered
          .flatMap(
            claim =>
              claim.codifiedByValues || []
          )
          .filter(Boolean)
      );

    const codifiedFiltered =
      statusFiltered.filter(
        claim =>
          !claimHasBlockingCodifiedBy(
            claim
          )
      );

    const noBillFiltered =
      state.filterState
        .includeNoBills
        ? codifiedFiltered
        : codifiedFiltered.filter(
            claim => !claim.noBill
          );

    const claimDateCounts =
      sortClaimDateEntries(
        countEntries(
          noBillFiltered.map(
            claim =>
              getClaimDateFilterValue(
                claim
              )
          )
        )
      );

    createCheckItems(
      paymentContainer,
      paymentCounts,
      state.filterState.paymentModes,
      true
    );

    createCheckItems(
      deptContainer,
      departmentCounts,
      state.filterState.departments,
      true
    );

    createCheckItems(
      statusContainer,
      statusCounts,
      state.filterState.codifStatuses,
      true
    );

    createCheckItems(
      codifiedByContainer,
      codifiedByCounts,
      state.filterState.codifiedBy,
      false
    );

    createCheckItems(
      claimDateContainer,
      claimDateCounts,
      state.filterState.claimDates,
      true
    );

    if (noBillLabel) {
      noBillLabel.textContent =
        `No Bills: ${
          statusFiltered.filter(
            claim => claim.noBill
          ).length
        }`;
    }

    const includeNoBill =
      getEl('include-no-bill-cb');

    if (includeNoBill) {
      includeNoBill.checked =
        state.filterState
          .includeNoBills;
    }
  }

  function syncFilterStateFromDom() {
    state.filterState.paymentModes =
      new Set(
        Array.from(
          getEl(
            'payment-mode-section'
          )?.querySelectorAll(
            'input:checked'
          ) || []
        ).map(input => input.value)
      );

    state.filterState.departments =
      new Set(
        Array.from(
          getEl(
            'dept-section'
          )?.querySelectorAll(
            'input:checked'
          ) || []
        ).map(input => input.value)
      );

    state.filterState.codifStatuses =
      new Set(
        Array.from(
          getEl(
            'codif-status-section'
          )?.querySelectorAll(
            'input:checked'
          ) || []
        ).map(input => input.value)
      );

    state.filterState.codifiedBy =
      new Set(
        Array.from(
          getEl(
            'codified-by-section'
          )?.querySelectorAll(
            'input:checked'
          ) || []
        ).map(input => input.value)
      );

    state.filterState.claimDates =
      new Set(
        Array.from(
          getEl(
            'claim-date-section'
          )?.querySelectorAll(
            'input:checked'
          ) || []
        ).map(
          input =>
            input.value
        )
      );

    state.filterState.includeNoBills =
      Boolean(
        getEl(
          'include-no-bill-cb'
        )?.checked
      );

    persistUserState();
  }

  function renderPreAllocationState() {
    if (!state.importedReports.length) {
      return;
    }

    const importStats =
      buildImportSummary();

    renderSummaryCards(
      importStats
    );

    /*
     * renderFacilitySummary reads state.facilityConfigs.
     * It never recreates/overwrites an existing config, so manual coder edits
     * survive filter changes, panel refreshes, and allocation previews.
     */
    renderFacilitySummary();
    refreshFilterOptions();

    state.lastAllocationResult = null;

    const downloadBtn =
      getEl('download-btn');

    if (downloadBtn) {
      downloadBtn.disabled = true;
    }

    const previewBtn = getEl('preview-btn');
    if (previewBtn) {
      previewBtn.disabled = true;
    }
  }

  function renderPreviewTable(
    allocationResult
  ) {
    const container =
      getEl('allocation-preview');

    if (!container) return;

    if (
      !allocationResult ||
      !allocationResult.allocationRows.length
    ) {
      container.classList.add(
        'preview-empty'
      );
      container.textContent =
        'No claims matched the current filters.';
      return;
    }

    container.classList.remove(
      'preview-empty'
    );

    const { summaryData } =
      allocationResult;

    const topCards =
      summaryData.topCards.map(
        ([label, value]) => `
          <div class="summary-card preview-metric-card">
            <span class="label">${escapeHtml(label)}</span>
            <span class="value">${escapeHtml(value)}</span>
          </div>
        `
      ).join('');

    const coderRows =
      summaryData.coderRows.map(
        row => `
          <tr>
            <td>${escapeHtml(row.Coder)}</td>
            <td class="numeric-cell"><strong>${escapeHtml(row['Total Assigned Claims'])}</strong></td>
            ${
              (summaryData.coderFacilityDateHierarchy || []).map(
                facilityGroup =>
                  facilityGroup.dates.map(
                    date => {
                      const detailKey =
                        `${facilityGroup.facility}|||${date.key}`;

                      return `
                        <td class="numeric-cell"><strong>${escapeHtml(row[`${detailKey}|||Assigned Total`] ?? 0)}</strong></td>
                        <td><em>${escapeHtml(row[`${detailKey}|||Detailed`] || '').replace(/\n/g, '<br>')}</em></td>
                      `;
                    }
                  ).join('')
              ).join('')
            }
          </tr>
        `
      ).join('');

    const facilityRows =
      summaryData.facilityRows.map(
        row => `
          <tr>
            <td>${escapeHtml(row.Facility)}</td>
            <td class="numeric-cell"><em>${escapeHtml(row['Claims Loaded'])}</em></td>
            <td><em>${escapeHtml(row['Excluded / Why'] || '0')}</em></td>
            <td class="numeric-cell"><strong>${escapeHtml(row.Eligible)}</strong></td>
            <td class="numeric-cell"><strong>${escapeHtml(row.Allocated)}</strong></td>
            <td class="numeric-cell"><em>${escapeHtml(row.Unassigned)}</em></td>
          </tr>
        `
      ).join('');

    const matrixRows =
      summaryData.matrixRows.map(
        row => `
          <tr>
            ${
              summaryData.matrixHeaders.map(
                header => {
                  const value =
                    escapeHtml(
                      row[header] ?? ''
                    );

                  if (header === 'Coder') {
                    return `<td>${value}</td>`;
                  }

                  if (header === 'Total') {
                    return `<td class="numeric-cell"><strong>${value}</strong></td>`;
                  }

                  return `<td class="numeric-cell"><em>${value}</em></td>`;
                }
              ).join('')
            }
          </tr>
        `
      ).join('');

    const deptRows =
      summaryData.departmentRows.map(
        row => `
          <tr>
            ${
              summaryData.departmentHeaders.map(
                header => {
                  const value =
                    escapeHtml(
                      row[header] ?? 0
                    );

                  if (
                    header ===
                    'Department'
                  ) {
                    return `<td>${value}</td>`;
                  }

                  if (
                    header ===
                    'Total'
                  ) {
                    return `<td class="numeric-cell total-cell"><strong>${value}</strong></td>`;
                  }

                  return `<td class="numeric-cell"><em>${value}</em></td>`;
                }
              ).join('')
            }
          </tr>
        `
      ).join('');

    container.innerHTML = `
      <section class="preview-section preview-hero-section">
        <div class="preview-section-heading">
          <div>
            <h2 class="section-title mb-1">
              Facility Allocation Preview
            </h2>
            <div class="summary-muted">
              Review the allocation totals below before downloading the facility sheets.
            </div>
          </div>
          <div class="balance-pill ${summaryData.fairness.statusText === 'EVEN' ? 'balance-even' : 'balance-constrained'}">
            ${escapeHtml(summaryData.fairness.statusText)}
          </div>
        </div>

        <div class="summary-grid preview-metric-grid mt-3">
          ${topCards}
        </div>
      </section>

      <section class="preview-section">
        <div class="preview-section-heading">
          <h2 class="section-title mb-0">
            Coder Allocation Summary
          </h2>
        </div>
        <div class="preview-table-wrap">
          <table class="preview-table">
            <thead>
              <tr>
                <th rowspan="3">Coder</th>
                <th rowspan="3">Total Assigned Claims</th>
                ${
                  (summaryData.coderFacilityDateHierarchy || []).map(
                    facilityGroup =>
                      `<th colspan="${facilityGroup.dates.length * 2}">${escapeHtml(facilityGroup.facility)}</th>`
                  ).join('')
                }
              </tr>
              <tr>
                ${
                  (summaryData.coderFacilityDateHierarchy || []).map(
                    facilityGroup =>
                      facilityGroup.dates.map(
                        date =>
                          `<th colspan="2">${escapeHtml(date.label)}</th>`
                      ).join('')
                  ).join('')
                }
              </tr>
              <tr>
                ${
                  (summaryData.coderFacilityDateHierarchy || []).map(
                    facilityGroup =>
                      facilityGroup.dates.map(
                        () =>
                          '<th>Assigned Total</th><th>Detailed</th>'
                      ).join('')
                  ).join('')
                }
              </tr>
            </thead>
            <tbody>${coderRows}</tbody>
          </table>
        </div>
      </section>

      <section class="preview-section">
        <div class="preview-section-heading">
          <h2 class="section-title mb-0">
            Facility Summary
          </h2>
        </div>
        <div class="preview-table-wrap">
          <table class="preview-table">
            <thead>
              <tr>
                <th>Facility</th>
                <th>Claims Loaded</th>
                <th>Excluded / Why</th>
                <th>Eligible</th>
                <th>Allocated</th>
                <th>Unassigned</th>
              </tr>
            </thead>
            <tbody>${facilityRows}</tbody>
          </table>
        </div>
      </section>

      <section class="preview-section">
        <div class="preview-section-heading">
          <h2 class="section-title mb-0">
            Coder Claims per Facility
          </h2>
        </div>
        <div class="preview-table-wrap">
          <table class="preview-table matrix-table">
            <thead>
              <tr>
                ${
                  summaryData.matrixHeaders.map(
                    header =>
                      `<th>${escapeHtml(header)}</th>`
                  ).join('')
                }
              </tr>
            </thead>
            <tbody>${matrixRows}</tbody>
          </table>
        </div>
      </section>

      <section class="preview-section">
        <div class="preview-section-heading">
          <div>
            <h2 class="section-title mb-1">
              Department Status Summary
            </h2>
            <div class="summary-muted">
              Counts are grouped by the current Codification Status. Terminal statuses are already excluded.
            </div>
          </div>
        </div>
        <div class="preview-table-wrap">
          <table class="preview-table department-status-table">
            <thead>
              <tr>
                ${
                  summaryData.departmentHeaders.map(
                    header =>
                      `<th>${escapeHtml(header)}</th>`
                  ).join('')
                }
              </tr>
            </thead>
            <tbody>${deptRows}</tbody>
          </table>
        </div>
      </section>
    `;
  }


  async function readWorkbookFile(file) {
    const buffer =
      await new Promise(
        (resolve, reject) => {
          const reader =
            new FileReader();

          reader.onload =
            event =>
              resolve(
                event.target.result
              );

          reader.onerror =
            () =>
              reject(
                new Error(
                  `Failed to read ${file.name}.`
                )
              );

          reader.readAsArrayBuffer(
            file
          );
        }
      );

    const workbook =
      root.XLSX.read(
        new Uint8Array(buffer),
        {
          type: 'array'
        }
      );

    const sheetName =
      workbook.SheetNames[0];

    const worksheet =
      workbook.Sheets[sheetName];

    const sheetRows =
      root.XLSX.utils.sheet_to_json(
        worksheet,
        {
          header: 1,
          defval: '',
          raw: true
        }
      );

    return {
      fileName: file.name,
      rows: sheetToObjects(
        sheetRows
      )
    };
  }

  function buildFacilityConfigsFromClaims(
    claims
  ) {
    const configs = {};

    for (
      const item of
      getFacilityClaimStats(claims)
    ) {
      configs[item.facilityKey] =
        createFacilityConfig(
          item.facilityKey,
          item.presetName
        );
    }

    return configs;
  }

  async function handleFiles(files) {
    const messageBox =
      getEl('messageBox');

    if (messageBox) {
      messageBox.textContent = '';
    }

    if (!files.length) return;

    try {
      await presetsReady;

      const reports =
        await Promise.all(
          Array.from(files)
            .map(readWorkbookFile)
        );

      const totalRows =
        reports.reduce(
          (sum, report) =>
            sum + report.rows.length,
          0
        );

      if (!totalRows) {
        if (messageBox) {
          messageBox.textContent =
            'No data found in the uploaded files.';
        }
        return;
      }

      state.importedReports =
        reports;

      state.rawClaims =
        normalizeRawClaims(
          reports,
          state.presetsData
        );

      const deduped =
        deduplicateClaims(
          state.rawClaims
        );

      state.dedupedClaims =
        deduped.dedupedClaims;

      state.duplicateGroups =
        deduped.duplicateGroups;

      state.importSummary =
        deduped.stats;

      /*
       * A new upload is a new allocation session, so it is appropriate to load
       * the detected preset coder defaults once here.
       */
      state.facilityConfigs =
        restorePersistedFacilityConfigs(
          buildFacilityConfigsFromClaims(
            state.duplicateGroups
          )
        );

      initializeFilterState(
        state.dedupedClaims
      );
      restorePersistedFilterState(
        state.dedupedClaims
      );

      const advancedFiltersPanel =
        getEl('advanced-filters-panel');
      const coderAssignmentPanel =
        getEl('coder-assignment-panel');
      const savedUiVersion = Number(
        state.persistedUserState?.version || 0
      );

      if (advancedFiltersPanel) {
        advancedFiltersPanel.open =
          savedUiVersion >= 5 &&
          typeof state.persistedUserState?.advancedFiltersOpen === 'boolean'
            ? state.persistedUserState.advancedFiltersOpen
            : false;
      }

      if (coderAssignmentPanel) {
        coderAssignmentPanel.open =
          savedUiVersion >= 5 &&
          typeof state.persistedUserState?.coderAssignmentOpen === 'boolean'
            ? state.persistedUserState.coderAssignmentOpen
            : true;
      }

      getEl(
        'allocator-workflow'
      )?.classList.remove(
        'hidden'
      );

      renderPreAllocationState();
    } catch (error) {
      if (messageBox) {
        messageBox.textContent =
          error.message ||
          'Failed to read uploaded files.';
      }
    }
  }

  function invalidateAllocationResult() {
    state.lastAllocationResult = null;

    const downloadBtn =
      getEl('download-btn');

    if (downloadBtn) {
      downloadBtn.disabled = true;
    }

    const previewBtn = getEl('preview-btn');
    if (previewBtn) {
      previewBtn.disabled = true;
    }
  }

  function updateFacilityPreset(
    facilityKey,
    presetName
  ) {
    const existing =
      state.facilityConfigs[facilityKey] ||
      createFacilityConfig(facilityKey, '');

    state.facilityConfigs[facilityKey] =
      applyPresetSelection(
        existing,
        facilityKey,
        presetName
      );

    persistUserState();
    invalidateAllocationResult();
    renderFacilitySummary();
  }

  function updateFacilityCoderRows(facilityKey, mutator, rerender = false) {
    const existing =
      state.facilityConfigs[facilityKey] ||
      createFacilityConfig(facilityKey, '');
    const rows = cloneCoderRows(getConfigCoderRows(existing));

    mutator(rows);

    state.facilityConfigs[facilityKey] =
      applyUserCoderRows(existing, rows);

    persistUserState();
    invalidateAllocationResult();

    if (rerender) {
      renderFacilitySummary();
    }
  }

  function updateFacilityCoders(facilityKey, codersText) {
    const existing =
      state.facilityConfigs[facilityKey] ||
      createFacilityConfig(facilityKey, '');

    state.facilityConfigs[facilityKey] =
      applyUserCoderText(existing, codersText);

    persistUserState();
    invalidateAllocationResult();
  }

  function addDepartmentToCoder(facilityKey, coderIndex, typedValue) {
    const department =
      getFacilityDepartmentDisplayValue(facilityKey, typedValue);
    if (!department) return false;

    const departmentKey = normalizeDepartmentKey(department);

    updateFacilityCoderRows(
      facilityKey,
      rows => {
        const row = rows[coderIndex];
        if (!row) return;

        // Manual additions are explicit assignments by default. If the same
        // department was previously only Preferred, promote it to Assigned.
        row.preferredDepartments = (row.preferredDepartments || []).filter(
          item => normalizeDepartmentKey(item) !== departmentKey
        );
        row.assignedDepartments = normalizeDepartmentList([
          ...(row.assignedDepartments || []),
          department
        ]);
      },
      true
    );

    return true;
  }

  function removeDepartmentFromCoder(
    facilityKey,
    coderIndex,
    type,
    department
  ) {
    const removeKey = normalizeDepartmentKey(department);

    updateFacilityCoderRows(
      facilityKey,
      rows => {
        const row = rows[coderIndex];
        if (!row) return;
        const key = type === 'assigned'
          ? 'assignedDepartments'
          : 'preferredDepartments';
        row[key] = (row[key] || []).filter(
          item => normalizeDepartmentKey(item) !== removeKey
        );
      },
      true
    );
  }

  function toggleDepartmentMode(
    facilityKey,
    coderIndex,
    type,
    department
  ) {
    const departmentKey = normalizeDepartmentKey(department);
    if (!departmentKey) return;

    updateFacilityCoderRows(
      facilityKey,
      rows => {
        const row = rows[coderIndex];
        if (!row) return;

        const fromKey = type === 'assigned'
          ? 'assignedDepartments'
          : 'preferredDepartments';
        const toKey = type === 'assigned'
          ? 'preferredDepartments'
          : 'assignedDepartments';

        const existing = (row[fromKey] || []).find(
          item => normalizeDepartmentKey(item) === departmentKey
        ) || department;

        row[fromKey] = (row[fromKey] || []).filter(
          item => normalizeDepartmentKey(item) !== departmentKey
        );
        row[toKey] = normalizeDepartmentList([
          ...(row[toKey] || []),
          existing
        ]);
      },
      true
    );
  }

  function focusNewestCoderRow(facilityKey) {
    if (!configsRootForFocus()) return;

    root.setTimeout(() => {
      const rootEl = configsRootForFocus();
      if (!rootEl) return;

      const panel = Array.from(
        rootEl.querySelectorAll('.facility-tab-panel')
      ).find(item => item.dataset.facilityPanelKey === facilityKey);

      const input = panel?.querySelector(
        '.coder-name-input[data-coder-index="0"]'
      );

      if (!(input instanceof HTMLInputElement)) return;

      input.classList.remove('coder-name-attention');
      // Force a reflow so repeated Add Coder clicks restart the animation.
      void input.offsetWidth;
      input.classList.add('coder-name-attention');
      input.focus();
      input.select();

      root.setTimeout(
        () => input.classList.remove('coder-name-attention'),
        2200
      );
    }, 0);
  }

  function configsRootForFocus() {
    return getEl('facility-configs');
  }

  function usePresetCoders(facilityKey) {
    const existing =
      state.facilityConfigs[facilityKey] ||
      createFacilityConfig(facilityKey, '');

    if (!existing.presetName) return;

    state.facilityConfigs[facilityKey] =
      resetConfigToPreset(existing, facilityKey);

    persistUserState();
    invalidateAllocationResult();
    renderFacilitySummary();
  }

  function openPreviewModal() {
    const modal = getEl('preview-modal');
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    doc?.body?.classList.add('preview-modal-open');
    getEl('preview-modal-close')?.focus();
  }

  function closePreviewModal() {
    const modal = getEl('preview-modal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    doc?.body?.classList.remove('preview-modal-open');
  }

  function attachUiHandlers() {
    const fileInput = getEl('allocator-file');
    const dropzone = getEl('allocator-dropzone');
    const downloadBtn = getEl('download-btn');
    const allocateBtn = getEl('allocate-btn');
    const previewBtn = getEl('preview-btn');
    const configsRoot = getEl('facility-configs');

    fileInput?.addEventListener(
      'change',
      event => handleFiles(event.target.files || [])
    );

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
          handleFiles(event.dataTransfer?.files || []);
        }

        dropzone.classList.remove('dragover');
      });
    });

    configsRoot?.addEventListener('change', event => {
      const target = event.target;

      if (
        target instanceof HTMLSelectElement &&
        target.classList.contains('facility-preset-select')
      ) {
        const facilityKey = target.dataset.facilityKey;
        if (facilityKey) {
          updateFacilityPreset(facilityKey, target.value);
        }
        return;
      }

      if (
        target instanceof HTMLInputElement &&
        target.classList.contains('department-tag-input')
      ) {
        const facilityKey = target.dataset.facilityKey;
        const coderIndex = Number(target.dataset.coderIndex);
        if (
          facilityKey &&
          Number.isInteger(coderIndex) &&
          target.value.trim()
        ) {
          if (addDepartmentToCoder(
            facilityKey,
            coderIndex,
            target.value
          )) {
            target.value = '';
          } else {
            target.classList.add('tag-input-invalid');
            setTimeout(
              () => target.classList.remove('tag-input-invalid'),
              900
            );
          }
        }
      }
    });

    configsRoot?.addEventListener('input', event => {
      const target = event.target;

      if (
        !(target instanceof HTMLInputElement) ||
        !target.classList.contains('coder-name-input')
      ) {
        return;
      }

      const facilityKey = target.dataset.facilityKey;
      const coderIndex = Number(target.dataset.coderIndex);
      if (!facilityKey || !Number.isInteger(coderIndex)) return;

      updateFacilityCoderRows(
        facilityKey,
        rows => {
          if (rows[coderIndex]) {
            rows[coderIndex].name = target.value;
          }
        },
        false
      );
    });

    configsRoot?.addEventListener('keydown', event => {
      const target = event.target;
      if (
        !(target instanceof HTMLInputElement) ||
        !target.classList.contains('department-tag-input')
      ) {
        return;
      }

      if (event.key !== 'Enter' && event.key !== ',') return;
      event.preventDefault();

      const facilityKey = target.dataset.facilityKey;
      const coderIndex = Number(target.dataset.coderIndex);
      if (!facilityKey || !Number.isInteger(coderIndex)) return;

      if (addDepartmentToCoder(
        facilityKey,
        coderIndex,
        target.value
      )) {
        target.value = '';
      } else if (target.value.trim()) {
        target.classList.add('tag-input-invalid');
        setTimeout(
          () => target.classList.remove('tag-input-invalid'),
          900
        );
      }
    });

    configsRoot?.addEventListener('click', event => {
      const tab = event.target.closest?.('.facility-tab-btn');
      if (tab) {
        const facilityKey = tab.dataset.facilityTabKey;
        if (!facilityKey) return;

        state.activeFacilityTab = facilityKey;
        persistUserState();

        configsRoot.querySelectorAll('.facility-tab-btn').forEach(button => {
          const isActive = button.dataset.facilityTabKey === facilityKey;
          button.classList.toggle('active', isActive);
          button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        configsRoot.querySelectorAll('.facility-tab-panel').forEach(panel => {
          panel.hidden = panel.dataset.facilityPanelKey !== facilityKey;
        });
        return;
      }

      const resetButton = event.target.closest?.('.facility-reset-coders-btn');
      if (resetButton) {
        const facilityKey = resetButton.dataset.facilityKey;
        if (facilityKey) usePresetCoders(facilityKey);
        return;
      }

      const addButton = event.target.closest?.('.add-coder-row-btn');
      if (addButton) {
        const facilityKey = addButton.dataset.facilityKey;
        if (!facilityKey) return;

        updateFacilityCoderRows(
          facilityKey,
          rows => rows.unshift({
            name: '',
            preferredDepartments: [],
            assignedDepartments: []
          }),
          true
        );
        focusNewestCoderRow(facilityKey);
        return;
      }

      const removeCoderButton = event.target.closest?.('.remove-coder-row-btn');
      if (removeCoderButton) {
        const facilityKey = removeCoderButton.dataset.facilityKey;
        const coderIndex = Number(removeCoderButton.dataset.coderIndex);
        if (!facilityKey || !Number.isInteger(coderIndex)) return;

        updateFacilityCoderRows(
          facilityKey,
          rows => rows.splice(coderIndex, 1),
          true
        );
        return;
      }

      const chipToggleButton = event.target.closest?.('[data-action="toggle-department-chip"]');
      if (chipToggleButton) {
        const facilityKey = chipToggleButton.dataset.facilityKey;
        const coderIndex = Number(chipToggleButton.dataset.coderIndex);
        const type = chipToggleButton.dataset.departmentType || 'preferred';
        const department = chipToggleButton.dataset.department || '';
        if (!facilityKey || !Number.isInteger(coderIndex)) return;

        toggleDepartmentMode(
          facilityKey,
          coderIndex,
          type,
          department
        );
        return;
      }

      const chipRemoveButton = event.target.closest?.('[data-action="remove-department-chip"]');
      if (chipRemoveButton) {
        const facilityKey = chipRemoveButton.dataset.facilityKey;
        const coderIndex = Number(chipRemoveButton.dataset.coderIndex);
        const type = chipRemoveButton.dataset.departmentType || 'preferred';
        const department = chipRemoveButton.dataset.department || '';
        if (!facilityKey || !Number.isInteger(coderIndex)) return;

        removeDepartmentFromCoder(
          facilityKey,
          coderIndex,
          type,
          department
        );
      }
    });

    const setAllChecked = (sectionId, checked) => {
      const section = getEl(sectionId);

      section?.querySelectorAll('input[type="checkbox"]')
        .forEach(input => {
          input.checked = checked;
        });

      syncFilterStateFromDom();
      renderPreAllocationState();
    };

    getEl('select-all-payment-btn')?.addEventListener(
      'click',
      () => setAllChecked('payment-mode-section', true)
    );
    getEl('deselect-all-payment-btn')?.addEventListener(
      'click',
      () => setAllChecked('payment-mode-section', false)
    );
    getEl('select-all-btn')?.addEventListener(
      'click',
      () => setAllChecked('dept-section', true)
    );
    getEl('deselect-all-btn')?.addEventListener(
      'click',
      () => setAllChecked('dept-section', false)
    );
    getEl('select-all-codif-btn')?.addEventListener(
      'click',
      () => setAllChecked('codif-status-section', true)
    );
    getEl('deselect-all-codif-btn')?.addEventListener(
      'click',
      () => setAllChecked('codif-status-section', false)
    );
    getEl('select-all-codified-by-btn')?.addEventListener(
      'click',
      () => setAllChecked('codified-by-section', true)
    );
    getEl('deselect-all-codified-by-btn')?.addEventListener(
      'click',
      () => setAllChecked('codified-by-section', false)
    );
    getEl('select-all-date-btn')?.addEventListener(
      'click',
      () => setAllChecked('claim-date-section', true)
    );
    getEl('deselect-all-date-btn')?.addEventListener(
      'click',
      () => setAllChecked('claim-date-section', false)
    );

    [
      'payment-mode-section',
      'dept-section',
      'codif-status-section',
      'codified-by-section',
      'claim-date-section'
    ].forEach(sectionId => {
      getEl(sectionId)?.addEventListener('change', () => {
        syncFilterStateFromDom();
        renderPreAllocationState();
      });
    });

    getEl('include-no-bill-cb')?.addEventListener('change', () => {
      syncFilterStateFromDom();
      renderPreAllocationState();
    });

    getEl('advanced-filters-panel')?.addEventListener('toggle', () => {
      persistUserState();
    });

    getEl('coder-assignment-panel')?.addEventListener('toggle', () => {
      persistUserState();
    });

    allocateBtn?.addEventListener('click', () => {
      const messageBox = getEl('messageBox');
      if (messageBox) messageBox.textContent = '';

      syncFilterStateFromDom();

      const filtered = applyClaimFilters(
        state.dedupedClaims,
        state.filterState
      );

      if (!filtered.eligibleClaims.length) {
        renderPreviewTable(null);
        invalidateAllocationResult();
        return;
      }

      const allocationDate = formatToday();
      const allocation = allocateClaims(
        filtered.eligibleClaims,
        state.facilityConfigs,
        allocationDate
      );

      const importStats = buildImportSummary();
      const allocationResult = {
        allocationRows: allocation.allocationRows,
        filteredClaims: filtered.eligibleClaims,
        importStats,
        allocationDate,
        fairness: allocation.fairness,
        facilityConfigs: state.facilityConfigs,
        duplicateGroups: state.duplicateGroups,
        filterBreakdown: filtered
      };

      allocationResult.summaryData =
        buildSummarySheetData(allocationResult);

      state.lastAllocationResult = {
        ...allocationResult
      };

      renderPreviewTable(state.lastAllocationResult);

      const hasRows = Boolean(allocation.allocationRows.length);
      if (downloadBtn) downloadBtn.disabled = !hasRows;
      if (previewBtn) previewBtn.disabled = !hasRows;
    });

    previewBtn?.addEventListener('click', () => {
      if (state.lastAllocationResult) {
        openPreviewModal();
      }
    });

    getEl('preview-modal')?.addEventListener('click', event => {
      if (event.target.closest?.('[data-preview-close]')) {
        closePreviewModal();
      }
    });

    doc?.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !getEl('preview-modal')?.hidden) {
        closePreviewModal();
      }
    });

    downloadBtn?.addEventListener('click', () => {
      if (!state.lastAllocationResult) return;

      const workbook = buildWorkbook(state.lastAllocationResult);
      const timestamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/:/g, '-');

      root.XLSX.writeFile(
        workbook,
        `facility_allocation_${timestamp}.xlsx`
      );
    });
  }

  function loadPresets() {
    if (
      typeof fetch !== 'function'
    ) {
      return;
    }

    presetsReady =
      fetch(
        '../json/allocator_presets.json',
        { cache: 'no-store' }
      )
        .then(response => {
          if (!response.ok) {
            throw new Error(
              `Failed to load allocator presets (${response.status}).`
            );
          }
          return response.json();
        })
        .then(data => {
          state.presetsData =
            data || {};

          state.presetOptions =
            Object.keys(
              state.presetsData
            )
              .filter(
                name =>
                  !name.startsWith('_')
              )
              .sort(
                (a, b) =>
                  a.localeCompare(b)
              );
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
    isDefaultExcludedDepartment,
    isReassignableCodifiedByValue,
    claimRequiresReassignment,
    claimHasBlockingCodifiedBy,
    getClaimDateFilterValue,
    matchFacilityValue:
      (value, presetsData) =>
        matchFacilityValue(
          value,
          buildPresetIndex(
            presetsData
          )
        ),
    normalizeRawClaims,
    deduplicateClaims,
    applyClaimFilters,
    allocateClaims,
    buildInitialFilterState,
    getAllocationSheetRow,
    parseDateValue,
    formatDate,
    sheetToObjects,
    collectColumnKeys,
    createFacilityConfig,
    getEligibleCoders,
    getCoderPreferenceCost,
    buildPreferenceMap,
    buildPresetIndex,
    buildDepartmentStatusSummary,
    formatFacilityExclusionBreakdown,
    buildSummarySheetData,
    getFriendlyFacilityName,
    makeUniqueSheetName,
    coderEntriesToText,
    applyUserCoderText,
    applyPresetSelection,
    resetConfigToPreset,
    parseCodersText,
    normalizeDepartmentKey,
    normalizeDepartmentList,
    getConfigCoderRows,
    getConfigCoderNames,
    applyUserCoderRows
  };

  if (
    !doc ||
    !getEl('allocator-file')
  ) {
    return;
  }

  loadPresets();
  attachUiHandlers();
})();
