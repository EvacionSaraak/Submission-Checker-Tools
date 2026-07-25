// checker_elig.js - Claim-to-eligibility validation
//
// Matching methodology:
//   1. Match by Emirates ID + encounter date when a usable Emirates ID exists.
//   2. Fall back to Member ID + encounter date.
//   3. Provider, eligibility status, and time proximity rank candidates.
//      Clinician is informational only and does not affect matching or validity.
//
// The View All modal uses delegated document-level handling and a per-run
// detail store, so it works in both the individual checker and cloned Check All
// results.

(function eligibilityCheckerModule(root) {
  'use strict';

  const MODULE_NAME = 'Eligibility Checker';
  const ELIGIBLE_STATUS_PATTERN = /^eligible$/i;
  const DENTAL_CATEGORY_PATTERN = /dental/i;
  const PLACEHOLDER_EID_PATTERN = /^(0+|1+|2+|9+)$/;

  const HEADER_ALIASES = Object.freeze({
    payerName: ['Payer Name', 'Payer'],
    memberName: ['Member Name', 'Patient Name'],
    transactionId: ['Transcation Id', 'Transaction Id', 'Transaction ID'],
    requestNumber: ['Eligibility Request Number', 'Eligibility Number', 'Request Number'],
    memberId: [
      'Card Number / DHA Member ID',
      'DHA Member ID',
      'Member ID',
      'MemberID',
      'Card Number'
    ],
    eid: ['EID', 'Emirates ID', 'EmiratesID', 'Emirates ID Number', 'EmiratesIDNumber'],
    orderedOn: ['Ordered On', 'Requested On', 'Request Date'],
    answeredOn: ['Answered On', 'Response Date'],
    authorizationNumber: ['Authorization Number', 'Authorisation Number'],
    status: ['Status', 'Eligibility Status'],
    denialCode: ['Denial Code/Rule ID', 'Denial Code', 'Rule ID'],
    denialDescription: [
      'Denial Description/Rule Description',
      'Denial Description',
      'Rule Description'
    ],
    clinician: ['Clinician', 'Clinician License', 'Doctor License'],
    clinicianName: ['Clinician Name', 'Doctor Name'],
    providerLicense: ['Provider License', 'Facility License', 'Provider ID'],
    providerName: ['Provider Name', 'Facility Name'],
    serviceCategory: ['Service Category', 'Service'],
    consultationStatus: ['Consultation Status', 'Visit Type'],
    voiNumber: ['VOI Number', 'VOI'],
    voiMessage: ['VOI Message'],
    packageName: ['Package Name', 'Package'],
    cardNetwork: ['Card Network', 'Network']
  });

  let detailRunCounter = 0;
  let lastResults = [];
  let lastWorkbookContext = null;
  const detailStore = new Map();
  let modalDelegationInstalled = false;

  function normalizeHeader(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeUpper(value) {
    return normalizeText(value).toUpperCase();
  }

  function normalizeMemberId(value) {
    const raw = normalizeText(value);
    if (!raw) return '';

    if (/^\d+(?:\.0+)?$/.test(raw)) {
      return raw.replace(/\.0+$/, '').replace(/^0+(?=\d)/, '');
    }

    return raw.toUpperCase().replace(/\s+/g, '');
  }

  function normalizeEid(value) {
    return normalizeText(value).replace(/\D/g, '');
  }

  function isUsableEid(value) {
    const eid = normalizeEid(value);
    return eid.length >= 12 && !PLACEHOLDER_EID_PATTERN.test(eid);
  }

  function normalizeClinician(value) {
    return normalizeUpper(value).replace(/\s+/g, '');
  }

  function normalizeProvider(value) {
    return normalizeUpper(value).replace(/\s+/g, '');
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function dateToKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function parseDateTime(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return {
        date: value,
        dateKey: dateToKey(value),
        timestamp: value.getTime(),
        display: formatDateTime(value)
      };
    }

    if (typeof value === 'number' && Number.isFinite(value) && root.XLSX?.SSF?.parse_date_code) {
      const parsed = root.XLSX.SSF.parse_date_code(value);
      if (parsed) {
        const date = new Date(
          parsed.y,
          parsed.m - 1,
          parsed.d,
          parsed.H || 0,
          parsed.M || 0,
          Math.floor(parsed.S || 0)
        );
        return {
          date,
          dateKey: dateToKey(date),
          timestamp: date.getTime(),
          display: formatDateTime(date)
        };
      }
    }

    const raw = normalizeText(value);
    if (!raw) return { date: null, dateKey: '', timestamp: null, display: '' };

    let match = raw.match(
      /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
    );

    if (match) {
      const day = Number(match[1]);
      const month = Number(match[2]);
      const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
      const hour = Number(match[4] || 0);
      const minute = Number(match[5] || 0);
      const second = Number(match[6] || 0);
      const date = new Date(year, month - 1, day, hour, minute, second);

      if (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
      ) {
        return {
          date,
          dateKey: dateToKey(date),
          timestamp: date.getTime(),
          display: formatDateTime(date)
        };
      }
    }

    match = raw.match(
      /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
    );

    if (match) {
      const monthMap = {
        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
      };
      const monthIndex = monthMap[match[2].toUpperCase()];
      const day = Number(match[1]);
      const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
      const hour = Number(match[4] || 0);
      const minute = Number(match[5] || 0);
      const second = Number(match[6] || 0);

      if (monthIndex != null) {
        const date = new Date(year, monthIndex, day, hour, minute, second);
        return {
          date,
          dateKey: dateToKey(date),
          timestamp: date.getTime(),
          display: formatDateTime(date)
        };
      }
    }

    const fallback = new Date(raw);
    if (!Number.isNaN(fallback.getTime())) {
      return {
        date: fallback,
        dateKey: dateToKey(fallback),
        timestamp: fallback.getTime(),
        display: formatDateTime(fallback)
      };
    }

    return { date: null, dateKey: '', timestamp: null, display: raw };
  }

  function formatDateTime(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return (
      `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()} ` +
      `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    );
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getDirectChild(parent, tagName) {
    return Array.from(parent?.children || []).find(
      child => String(child.nodeName || '').trim() === tagName
    ) || null;
  }

  function getDirectText(parent, tagName) {
    return normalizeText(getDirectChild(parent, tagName)?.textContent);
  }

  function getNestedText(parent, tagName) {
    const element = parent?.getElementsByTagName?.(tagName)?.[0];
    return normalizeText(element?.textContent);
  }

  function resolveInputFile(inputId, cacheKey, explicitFile) {
    if (explicitFile) return explicitFile;

    const cached = root.unifiedCheckerFiles?.[cacheKey];
    if (cached) return cached;

    const input = document.getElementById(inputId);
    return input?.files?.[0] || null;
  }

  function parseXMLClaims(xmlText) {
    const parser = new DOMParser();
    const xmlDocument = parser.parseFromString(xmlText, 'application/xml');
    const parserError = xmlDocument.getElementsByTagName('parsererror')[0];

    if (parserError) {
      throw new Error(`XML parsing failed: ${normalizeText(parserError.textContent)}`);
    }

    const claims = Array.from(xmlDocument.getElementsByTagName('Claim'));
    if (!claims.length) throw new Error('The XML contains no Claim entries.');

    return claims.map((claim, claimIndex) => {
      const encounter = claim.getElementsByTagName('Encounter')[0] || null;
      const encounterStartRaw = getNestedText(encounter, 'Start');
      const encounterStart = parseDateTime(encounterStartRaw);
      const activities = Array.from(claim.getElementsByTagName('Activity'));
      const clinicians = new Set();
      const performingClinicians = new Set();
      const orderingClinicians = new Set();

      activities.forEach(activity => {
        const performing = normalizeClinician(getNestedText(activity, 'Clinician'));
        const ordering = normalizeClinician(getNestedText(activity, 'OrderingClinician'));
        if (performing) {
          clinicians.add(performing);
          performingClinicians.add(performing);
        }
        if (ordering) {
          clinicians.add(ordering);
          orderingClinicians.add(ordering);
        }
      });

      const activityTypes = new Set(
        activities.map(activity => normalizeText(getNestedText(activity, 'Type'))).filter(Boolean)
      );
      const isDental = activityTypes.has('6');

      return {
        claimIndex,
        claimID: getDirectText(claim, 'ID') || `Claim ${claimIndex + 1}`,
        memberIDRaw: getDirectText(claim, 'MemberID'),
        memberID: normalizeMemberId(getDirectText(claim, 'MemberID')),
        eidRaw: getDirectText(claim, 'EmiratesIDNumber'),
        eid: normalizeEid(getDirectText(claim, 'EmiratesIDNumber')),
        providerIDRaw: getDirectText(claim, 'ProviderID') || getNestedText(encounter, 'FacilityID'),
        providerID: normalizeProvider(
          getDirectText(claim, 'ProviderID') || getNestedText(encounter, 'FacilityID')
        ),
        encounterStartRaw,
        encounterDate: encounterStart.dateKey,
        encounterTimestamp: encounterStart.timestamp,
        clinicians,
        performingClinicians,
        orderingClinicians,
        isDental,
        claimXML: claim.outerHTML
      };
    });
  }

  function findHeaderRow(matrix) {
    const scanLimit = Math.min(matrix.length, 20);
    let best = null;

    for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
      const row = matrix[rowIndex] || [];
      const normalized = row.map(normalizeHeader);
      let score = 0;

      const hasAlias = aliases => aliases.some(alias => normalized.includes(normalizeHeader(alias)));
      if (hasAlias(HEADER_ALIASES.memberId)) score += 3;
      if (hasAlias(HEADER_ALIASES.eid)) score += 3;
      if (hasAlias(HEADER_ALIASES.orderedOn)) score += 3;
      if (hasAlias(HEADER_ALIASES.status)) score += 2;
      if (hasAlias(HEADER_ALIASES.clinician)) score += 1;
      if (hasAlias(HEADER_ALIASES.providerLicense)) score += 1;

      if (!best || score > best.score) best = { rowIndex, score };
    }

    if (!best || best.score < 8) {
      throw new Error(
        'Eligibility: could not identify all matching columns. ' +
        'Expected a header row containing EID or Member ID, Ordered On, and Status.'
      );
    }

    return best.rowIndex;
  }

  function buildUniqueHeaders(headerRow) {
    const counts = new Map();

    return headerRow.map((value, index) => {
      const base = normalizeText(value) || `Column ${index + 1}`;
      const normalized = normalizeHeader(base);
      const count = (counts.get(normalized) || 0) + 1;
      counts.set(normalized, count);
      return count === 1 ? base : `${base} (${count})`;
    });
  }

  function resolveHeaderIndex(rawHeaders, aliases) {
    const normalizedHeaders = rawHeaders.map(normalizeHeader);

    for (const alias of aliases) {
      const target = normalizeHeader(alias);
      const index = normalizedHeaders.indexOf(target);
      if (index !== -1) return index;
    }

    return -1;
  }

  function parseEligibilityWorkbook(arrayBuffer) {
    if (!root.XLSX || typeof root.XLSX.read !== 'function') {
      throw new Error('SheetJS (XLSX) is unavailable.');
    }

    const workbook = root.XLSX.read(arrayBuffer, {
      type: 'array',
      cellDates: true,
      raw: true
    });

    const allRows = [];
    const warnings = [];

    workbook.SheetNames.forEach(sheetName => {
      const worksheet = workbook.Sheets[sheetName];
      const matrix = root.XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: '',
        raw: true,
        blankrows: false
      });

      if (!matrix.length) return;

      let headerRowIndex;
      try {
        headerRowIndex = findHeaderRow(matrix);
      } catch (error) {
        warnings.push(`${sheetName}: ${error.message}`);
        return;
      }

      const rawHeaders = matrix[headerRowIndex].map(value => normalizeText(value));
      const displayHeaders = buildUniqueHeaders(rawHeaders);
      const indexes = {};

      Object.entries(HEADER_ALIASES).forEach(([key, aliases]) => {
        indexes[key] = resolveHeaderIndex(rawHeaders, aliases);
      });

      if (indexes.orderedOn < 0 || indexes.status < 0 || (indexes.eid < 0 && indexes.memberId < 0)) {
        warnings.push(
          `${sheetName}: missing EID/Member ID, Ordered On, or Status columns.`
        );
        return;
      }

      for (let rowIndex = headerRowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
        const values = matrix[rowIndex] || [];
        if (!values.some(value => normalizeText(value))) continue;

        const sourceRow = {};
        displayHeaders.forEach((header, columnIndex) => {
          sourceRow[header] = values[columnIndex] ?? '';
        });

        const orderedOn = parseDateTime(values[indexes.orderedOn]);
        const row = {
          sheetName,
          sheetRowNumber: rowIndex + 1,
          sourceRow,
          rawValues: values,
          memberIDRaw: indexes.memberId >= 0 ? values[indexes.memberId] : '',
          memberID: indexes.memberId >= 0 ? normalizeMemberId(values[indexes.memberId]) : '',
          eidRaw: indexes.eid >= 0 ? values[indexes.eid] : '',
          eid: indexes.eid >= 0 ? normalizeEid(values[indexes.eid]) : '',
          orderedOnRaw: indexes.orderedOn >= 0 ? values[indexes.orderedOn] : '',
          orderedOnDisplay: orderedOn.display || normalizeText(values[indexes.orderedOn]),
          orderedDate: orderedOn.dateKey,
          orderedTimestamp: orderedOn.timestamp,
          answeredOn: indexes.answeredOn >= 0 ? normalizeText(values[indexes.answeredOn]) : '',
          status: indexes.status >= 0 ? normalizeText(values[indexes.status]) : '',
          clinicianRaw: indexes.clinician >= 0 ? normalizeText(values[indexes.clinician]) : '',
          clinician: indexes.clinician >= 0 ? normalizeClinician(values[indexes.clinician]) : '',
          clinicianName: indexes.clinicianName >= 0 ? normalizeText(values[indexes.clinicianName]) : '',
          providerLicenseRaw:
            indexes.providerLicense >= 0 ? normalizeText(values[indexes.providerLicense]) : '',
          providerLicense:
            indexes.providerLicense >= 0 ? normalizeProvider(values[indexes.providerLicense]) : '',
          providerName: indexes.providerName >= 0 ? normalizeText(values[indexes.providerName]) : '',
          serviceCategory:
            indexes.serviceCategory >= 0 ? normalizeText(values[indexes.serviceCategory]) : '',
          consultationStatus:
            indexes.consultationStatus >= 0 ? normalizeText(values[indexes.consultationStatus]) : '',
          requestNumber: indexes.requestNumber >= 0 ? normalizeText(values[indexes.requestNumber]) : '',
          authorizationNumber:
            indexes.authorizationNumber >= 0 ? normalizeText(values[indexes.authorizationNumber]) : '',
          payerName: indexes.payerName >= 0 ? normalizeText(values[indexes.payerName]) : '',
          memberName: indexes.memberName >= 0 ? normalizeText(values[indexes.memberName]) : '',
          transactionId: indexes.transactionId >= 0 ? normalizeText(values[indexes.transactionId]) : '',
          denialCode: indexes.denialCode >= 0 ? normalizeText(values[indexes.denialCode]) : '',
          denialDescription:
            indexes.denialDescription >= 0 ? normalizeText(values[indexes.denialDescription]) : '',
          voiNumber: indexes.voiNumber >= 0 ? normalizeText(values[indexes.voiNumber]) : '',
          voiMessage: indexes.voiMessage >= 0 ? normalizeText(values[indexes.voiMessage]) : '',
          packageName: indexes.packageName >= 0 ? normalizeText(values[indexes.packageName]) : '',
          cardNetwork: indexes.cardNetwork >= 0 ? normalizeText(values[indexes.cardNetwork]) : ''
        };

        allRows.push(row);
      }
    });

    if (!allRows.length) {
      throw new Error(
        warnings.length
          ? `Eligibility workbook contains no usable rows. ${warnings.join(' ')}`
          : 'Eligibility workbook contains no usable rows.'
      );
    }

    return {
      workbook,
      rows: allRows,
      warnings
    };
  }

  function addToIndex(index, key, row) {
    if (!key || key.startsWith('|') || key.endsWith('|')) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }

  function buildEligibilityIndexes(rows) {
    const eidDate = new Map();
    const memberDate = new Map();

    rows.forEach(row => {
      if (row.eid && row.orderedDate) addToIndex(eidDate, `${row.eid}|${row.orderedDate}`, row);
      if (row.memberID && row.orderedDate) {
        addToIndex(memberDate, `${row.memberID}|${row.orderedDate}`, row);
      }
    });

    return { eidDate, memberDate };
  }

  function scoreCandidate(claim, row, basis) {
    let score = basis === 'EID' ? 10000 : 5000;

    if (claim.eid && row.eid === claim.eid) score += 1000;
    if (claim.memberID && row.memberID === claim.memberID) score += 700;
    if (claim.providerID && row.providerLicense === claim.providerID) score += 300;
    if (ELIGIBLE_STATUS_PATTERN.test(row.status)) score += 150;

    let minutesDifference = null;
    if (claim.encounterTimestamp != null && row.orderedTimestamp != null) {
      minutesDifference = Math.abs(claim.encounterTimestamp - row.orderedTimestamp) / 60000;
      score += Math.max(0, 90 - Math.min(90, minutesDifference));
    }

    return { score, minutesDifference };
  }

  function findBestEligibilityMatch(claim, indexes) {
    let candidates = [];
    let basis = '';

    if (isUsableEid(claim.eid) && claim.encounterDate) {
      candidates = indexes.eidDate.get(`${claim.eid}|${claim.encounterDate}`) || [];
      if (candidates.length) basis = 'EID';
    }

    if (!candidates.length && claim.memberID && claim.encounterDate) {
      candidates = indexes.memberDate.get(`${claim.memberID}|${claim.encounterDate}`) || [];
      if (candidates.length) basis = 'Member ID';
    }

    if (!candidates.length) {
      return { row: null, basis: '', candidateCount: 0, minutesDifference: null };
    }

    const ranked = candidates
      .map(row => ({ row, ...scoreCandidate(claim, row, basis) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aTime = a.minutesDifference == null ? Number.POSITIVE_INFINITY : a.minutesDifference;
        const bTime = b.minutesDifference == null ? Number.POSITIVE_INFINITY : b.minutesDifference;
        if (aTime !== bTime) return aTime - bTime;
        return b.row.sheetRowNumber - a.row.sheetRowNumber;
      });

    return {
      row: ranked[0].row,
      basis,
      candidateCount: candidates.length,
      minutesDifference: ranked[0].minutesDifference
    };
  }

  function analyzeClaim(claim, match) {
    const matchedRow = match.row;
    const invalidRemarks = [];
    const notes = [];

    if (!claim.encounterDate) {
      invalidRemarks.push('Encounter Start is missing or has an invalid date.');
    }

    if (!matchedRow) {
      invalidRemarks.push(
        `No eligibility match was found for EID ${claim.eidRaw || '(blank)'} ` +
        `or Member ID ${claim.memberIDRaw || '(blank)'} on ` +
        `${claim.encounterDate || claim.encounterStartRaw || '(unknown date)'}.`
      );
    } else {
      if (!ELIGIBLE_STATUS_PATTERN.test(matchedRow.status)) {
        invalidRemarks.push(
          `Eligibility status is ${matchedRow.status || '(blank)'} instead of Eligible.`
        );
      }

      if (claim.isDental && matchedRow.serviceCategory && !DENTAL_CATEGORY_PATTERN.test(matchedRow.serviceCategory)) {
        invalidRemarks.push(
          `Dental claim matched eligibility Service Category ` +
          `\`${matchedRow.serviceCategory}\` instead of Dental Services.`
        );
      }

      if (claim.providerID && matchedRow.providerLicense && claim.providerID !== matchedRow.providerLicense) {
        notes.push(
          `Provider differs: claim ${claim.providerIDRaw}, eligibility ${matchedRow.providerLicenseRaw}.`
        );
      }

      if (
        claim.memberID &&
        matchedRow.memberID &&
        claim.memberID !== matchedRow.memberID
      ) {
        notes.push(
          `Member ID differs: claim ${claim.memberIDRaw}, eligibility ${matchedRow.memberIDRaw}; ` +
          `the match was made by Emirates ID.`
        );
      }

      if (match.candidateCount > 1) {
        notes.push(
          `${match.candidateCount} eligibility rows matched ${match.basis} and date; ` +
          `the closest/highest-ranked row was selected.`
        );
      }
    }

    const status = invalidRemarks.length ? 'Invalid' : 'Valid';

    return {
      ClaimID: claim.claimID,
      MemberID: claim.memberIDRaw,
      EmiratesID: claim.eidRaw,
      EncounterStart: claim.encounterStartRaw,
      EncounterDate: claim.encounterDate,
      ClaimClinicians: Array.from(claim.clinicians).join(', '),
      ProviderID: claim.providerIDRaw,
      MatchBasis: match.basis || '',
      Status: status,
      Remarks: invalidRemarks.join('\n') || 'OK',
      Notes: notes.join('\n'),
      EligibilityRequestNumber: matchedRow?.requestNumber || '',
      EligibilityOrderedOn: matchedRow?.orderedOnDisplay || '',
      EligibilityStatus: matchedRow?.status || '',
      EligibilityClinician: matchedRow?.clinicianRaw || '',
      EligibilityClinicianName: matchedRow?.clinicianName || '',
      ServiceCategory: matchedRow?.serviceCategory || '',
      ConsultationStatus: matchedRow?.consultationStatus || '',
      AuthorizationNumber: matchedRow?.authorizationNumber || '',
      EligibilitySheet: matchedRow?.sheetName || '',
      EligibilityRowNumber: matchedRow?.sheetRowNumber || '',
      EligibilityRow: matchedRow?.sourceRow || null,
      ClaimContext: claim,
      Valid: status === 'Valid'
    };
  }

  function clearDetailStoreForRun() {
    detailRunCounter += 1;
    detailStore.clear();
    return `elig-${Date.now()}-${detailRunCounter}`;
  }

  function registerDetail(runId, result, index) {
    const detailId = `${runId}-${index}`;
    detailStore.set(detailId, {
      claim: {
        'Claim ID': result.ClaimID,
        'Member ID': result.MemberID,
        'Emirates ID': result.EmiratesID,
        'Encounter Start': result.EncounterStart,
        'Claim Clinicians': result.ClaimClinicians,
        'Provider ID': result.ProviderID,
        'Match Basis': result.MatchBasis,
        Status: result.Status,
        Remarks: result.Remarks,
        Notes: result.Notes
      },
      eligibility: result.EligibilityRow,
      sheetName: result.EligibilitySheet,
      sheetRowNumber: result.EligibilityRowNumber
    });
    return detailId;
  }

  function createResultsWrapper(results, context) {
    const wrapper = document.createElement('div');
    wrapper.className = 'elig-checker-results';

    const total = results.length;
    const valid = results.filter(result => result.Status === 'Valid').length;
    const invalid = total - valid;
    const percentage = total ? ((valid / total) * 100).toFixed(1) : '100.0';

    const summary = document.createElement('div');
    summary.className = 'alert alert-info';
    summary.innerHTML =
      `<strong>Eligibility results:</strong> ${valid} valid / ${total} total ` +
      `(${percentage}%). ${invalid} invalid.`;
    wrapper.appendChild(summary);

    if (context.warnings?.length) {
      const warning = document.createElement('div');
      warning.className = 'alert alert-warning';
      warning.textContent = context.warnings.join(' ');
      wrapper.appendChild(warning);
    }

    const responsive = document.createElement('div');
    responsive.className = 'table-responsive';

    const table = document.createElement('table');
    table.className =
      'table table-bordered table-striped checker-table result-table eligibility-results-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Member ID</th>
          <th>Emirates ID</th>
          <th>Encounter Start</th>
          <th>Claim Clinician</th>
          <th>Match Basis</th>
          <th>Eligibility Request</th>
          <th>Ordered On</th>
          <th>Eligibility Clinician</th>
          <th>Service Category</th>
          <th>Status</th>
          <th>Remarks</th>
          <th>Notes</th>
          <th>Eligibility Details</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    const runId = clearDetailStoreForRun();

    results.forEach((result, index) => {
      const row = document.createElement('tr');
      row.className = result.Status === 'Valid'
        ? 'table-success valid-row valid'
        : 'table-danger invalid-row invalid';
      row.dataset.claimId = result.ClaimID || '';
      row.dataset.status = result.Status.toLowerCase();

      const detailId = result.EligibilityRow ? registerDetail(runId, result, index) : '';
      const detailButton = detailId
        ? `<button type="button" class="details-btn eligibility-details" ` +
          `data-eligibility-detail-id="${escapeHtml(detailId)}">View All</button>`
        : '';

      row.innerHTML = `
        <td class="nowrap-col claim-id-cell">${escapeHtml(result.ClaimID)}</td>
        <td>${escapeHtml(result.MemberID)}</td>
        <td>${escapeHtml(result.EmiratesID)}</td>
        <td>${escapeHtml(result.EncounterStart)}</td>
        <td>${escapeHtml(result.ClaimClinicians)}</td>
        <td>${escapeHtml(result.MatchBasis)}</td>
        <td>${escapeHtml(result.EligibilityRequestNumber)}</td>
        <td>${escapeHtml(result.EligibilityOrderedOn)}</td>
        <td>${escapeHtml(result.EligibilityClinician)}</td>
        <td>${escapeHtml(result.ServiceCategory)}</td>
        <td>${escapeHtml(result.Status)}</td>
        <td style="white-space:pre-line">${escapeHtml(result.Remarks)}</td>
        <td style="white-space:pre-line">${escapeHtml(result.Notes)}</td>
        <td>${detailButton}</td>
      `;

      tbody.appendChild(row);
    });

    responsive.appendChild(table);
    wrapper.appendChild(responsive);
    return wrapper;
  }

  function createErrorWrapper(error) {
    const wrapper = document.createElement('div');
    wrapper.className = 'elig-checker-results';

    const alert = document.createElement('div');
    alert.className = 'alert alert-danger';
    alert.textContent = `${MODULE_NAME} failed: ${error?.message || String(error)}`;
    wrapper.appendChild(alert);

    const table = document.createElement('table');
    table.className = 'table checker-table';
    table.innerHTML =
      '<tbody><tr class="table-danger invalid-row invalid">' +
      '<td>Eligibility checker did not complete.</td></tr></tbody>';
    wrapper.appendChild(table);
    return wrapper;
  }

  function closeEligibilityModal() {
    document.getElementById('eligibilityDetailsModal')?.remove();
  }

  function objectToRows(object) {
    if (!object || typeof object !== 'object') {
      return '<tr><td colspan="2">No data available.</td></tr>';
    }

    return Object.entries(object)
      .map(([key, value]) => {
        let displayValue = value;
        if (value instanceof Date) displayValue = formatDateTime(value);
        else if (value && typeof value === 'object') displayValue = JSON.stringify(value);
        return `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(displayValue)}</td></tr>`;
      })
      .join('');
  }

  function openEligibilityDetails(detailId) {
    const detail = detailStore.get(String(detailId || ''));

    if (!detail) {
      alert(
        'Eligibility details are no longer available for this result. ' +
        'Run the Eligibility checker again.'
      );
      return;
    }

    closeEligibilityModal();

    const modal = document.createElement('div');
    modal.id = 'eligibilityDetailsModal';
    modal.className = 'modal';
    modal.style.cssText =
      'display:flex;position:fixed;inset:0;z-index:10050;' +
      'background:rgba(0,0,0,.45);align-items:center;justify-content:center;padding:20px;';

    modal.innerHTML = `
      <div class="modal-content eligibility-modal modal-scrollable" style="
        width:min(1100px,96vw);max-height:92vh;overflow:auto;background:#fff;
        border-radius:8px;padding:18px;box-shadow:0 10px 30px rgba(0,0,0,.3);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
          <h3 style="margin:0;">Eligibility Details</h3>
          <button type="button" class="details-btn eligibility-modal-close" aria-label="Close">&times;</button>
        </div>
        <p style="margin:8px 0 14px;">
          Sheet: <strong>${escapeHtml(detail.sheetName)}</strong>, row
          <strong>${escapeHtml(detail.sheetRowNumber)}</strong>
        </p>
        <h4>Claim Match</h4>
        <div class="table-responsive">
          <table class="table table-bordered eligibility-detail-table">
            <tbody>${objectToRows(detail.claim)}</tbody>
          </table>
        </div>
        <h4>Complete Eligibility Row</h4>
        <div class="table-responsive">
          <table class="table table-bordered eligibility-detail-table">
            <tbody>${objectToRows(detail.eligibility)}</tbody>
          </table>
        </div>
        <div style="text-align:right;margin-top:12px;">
          <button type="button" class="details-btn eligibility-modal-close">Close</button>
        </div>
      </div>
    `;

    modal.addEventListener('click', event => {
      if (event.target === modal || event.target.closest('.eligibility-modal-close')) {
        closeEligibilityModal();
      }
    });

    document.body.appendChild(modal);
  }

  function installModalDelegation() {
    if (modalDelegationInstalled) return;
    modalDelegationInstalled = true;

    document.addEventListener('click', event => {
      const button = event.target.closest?.(
        'button.eligibility-details[data-eligibility-detail-id]'
      );
      if (!button) return;

      event.preventDefault();
      event.stopPropagation();
      openEligibilityDetails(button.dataset.eligibilityDetailId);
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeEligibilityModal();
    });
  }

  function makeExportRows(results) {
    return results.map(result => ({
      'Claim ID': result.ClaimID,
      'Member ID': result.MemberID,
      'Emirates ID': result.EmiratesID,
      'Encounter Start': result.EncounterStart,
      'Claim Clinician': result.ClaimClinicians,
      'Provider ID': result.ProviderID,
      'Match Basis': result.MatchBasis,
      'Eligibility Request': result.EligibilityRequestNumber,
      'Eligibility Ordered On': result.EligibilityOrderedOn,
      'Eligibility Clinician': result.EligibilityClinician,
      'Service Category': result.ServiceCategory,
      Status: result.Status,
      Remarks: result.Remarks,
      Notes: result.Notes,
      'Eligibility Sheet': result.EligibilitySheet,
      'Eligibility Row': result.EligibilityRowNumber
    }));
  }

  function exportEligibilityResults(onlyInvalid = false) {
    if (!root.XLSX || typeof root.XLSX.writeFile !== 'function') {
      throw new Error('SheetJS (XLSX) is unavailable.');
    }

    const selected = onlyInvalid
      ? lastResults.filter(result => result.Status !== 'Valid')
      : lastResults;

    if (!selected.length) {
      alert(onlyInvalid ? 'No invalid eligibility results.' : 'No eligibility results to export.');
      return;
    }

    const workbook = root.XLSX.utils.book_new();
    const worksheet = root.XLSX.utils.json_to_sheet(makeExportRows(selected));
    root.XLSX.utils.book_append_sheet(workbook, worksheet, 'Eligibility Results');
    root.XLSX.writeFile(
      workbook,
      onlyInvalid ? 'eligibility_invalid_results.xlsx' : 'eligibility_results.xlsx'
    );
  }

  function wireOptionalExportButton() {
    const button = document.getElementById('exportInvalidBtn');
    if (!button) return;
    button.onclick = () => exportEligibilityResults(true);
    button.disabled = !lastResults.some(result => result.Status !== 'Valid');
  }

  async function runEligCheck(options) {
    const config = options || {};
    const xmlFile = resolveInputFile('xmlFileInput', 'xml', config.xmlFile);
    const eligibilityFile = resolveInputFile(
      'eligibilityFileInput',
      'eligibility',
      config.eligibilityFile
    );

    installModalDelegation();

    if (!xmlFile || !eligibilityFile) {
      const missing = [
        !xmlFile ? 'XML file' : '',
        !eligibilityFile ? 'Eligibility workbook' : ''
      ].filter(Boolean).join(' and ');
      return createErrorWrapper(new Error(`Missing ${missing}.`));
    }

    try {
      const [xmlText, eligibilityBuffer] = await Promise.all([
        typeof root.getUnifiedXmlText === 'function'
          ? root.getUnifiedXmlText()
          : xmlFile.text(),
        eligibilityFile.arrayBuffer()
      ]);

      const claims = parseXMLClaims(xmlText);
      const workbookContext = parseEligibilityWorkbook(eligibilityBuffer);
      const indexes = buildEligibilityIndexes(workbookContext.rows);

      const results = claims.map(claim => {
        const match = findBestEligibilityMatch(claim, indexes);
        return analyzeClaim(claim, match);
      });

      lastResults = results;
      lastWorkbookContext = workbookContext;
      root._lastEligibilityResults = results;
      root._lastEligibilityWorkbookContext = workbookContext;
      wireOptionalExportButton();

      console.log('[ELIG] Completed eligibility matching.', {
        claims: claims.length,
        eligibilityRows: workbookContext.rows.length,
        valid: results.filter(result => result.Status === 'Valid').length,
        invalid: results.filter(result => result.Status !== 'Valid').length
      });

      return createResultsWrapper(results, workbookContext);
    } catch (error) {
      console.error('[ELIG] Checker failed:', error);
      lastResults = [];
      lastWorkbookContext = null;
      return createErrorWrapper(error);
    }
  }

  installModalDelegation();

  root.runEligCheck = runEligCheck;
  root.openEligibilityDetails = openEligibilityDetails;
  root.closeEligibilityModal = closeEligibilityModal;
  root.exportEligibilityResults = exportEligibilityResults;
  root.initEligibilityModal = installModalDelegation;
  root._eligibilityCheckerTestApi = {
    normalizeMemberId,
    normalizeEid,
    normalizeClinician,
    parseDateTime,
    parseXMLClaims,
    parseEligibilityWorkbook,
    buildEligibilityIndexes,
    findBestEligibilityMatch,
    analyzeClaim
  };

  console.log('[ELIG] checker_elig.js loaded successfully.');
})(window);
