// checker_elig.js - Claim-to-eligibility validation
//
// Matching methodology:
//   1. Match by Emirates ID + encounter date when a usable Emirates ID exists.
//   2. Fall back to Member ID + encounter date.
//   3. Provider, clinician, status, and time proximity rank candidates, but a
//      clinician mismatch does not erase an otherwise valid eligibility match.
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
    if (claim.clinicians.size && row.clinician && claim.clinicians.has(row.clinician)) score += 100;

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

      if (claim.clinicians.size && matchedRow.clinician && !claim.clinicians.has(matchedRow.clinician)) {
        notes.push(
          `Clinician differs: claim ${Array.from(claim.clinicians).join(', ')}, ` +
          `eligibility ${matchedRow.clinicianRaw}. The eligibility was still matched by ` +
          `${match.basis} and encounter date.`
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


================================================================================
unified_checker.js — COMPLETE REPLACEMENT
================================================================================

// unified_checker.js - Unified controller for all checkers
// Refactored: Checkers return tables; rendering handled centrally

(function() {
  'use strict';

  // Constants
  const CLIPBOARD_FEEDBACK_DURATION_MS = 2000;
  const ERROR_FEEDBACK_DURATION_EXTENSION_FACTOR = 1.5; // Extend error messages display time by 50%
  const INVALID_ROW_CLASSES = 'tbody tr.table-danger, tbody tr.table-warning';

  // Checkers that are only applicable in Medical mode
  const MEDICAL_ONLY_CHECKERS = new Set(['exclusion', 'modifiers']);

  // Initialize session counter immediately
  (function initSessionCounter() {
    let sessionCount = sessionStorage.getItem('checkerSessionCount');
    sessionCount = sessionCount ? parseInt(sessionCount) + 1 : 1;
    sessionStorage.setItem('checkerSessionCount', sessionCount);
    console.log(`[INIT] Unified Checker v1.2.107 - Session #${sessionCount}`);
    
    // Update DOM when ready
    document.addEventListener('DOMContentLoaded', () => {
      const sessionElement = document.getElementById('sessionCount');
      if (sessionElement) {
        sessionElement.textContent = `v1.2.98 | Session #${sessionCount}`;
      }
    });
  })();

  // File storage
  const files = {
    xml: null,
    clinician: null,
    eligibility: null,
    auth: null,
    status: null,
    pricing: null
  };

  // Expose files globally for checkers to access
  window.unifiedCheckerFiles = files;

  // XML text cache: reads each uploaded File object at most once.
  // Keyed by File identity (object reference) so that two files with the
  // same name but different content are never confused.
  const parsedFileCache = {
    xmlFile: null,
    xmlTextPromise: null
  };

  function getXmlText(file) {
    if (!file) {
      return Promise.reject(new Error('No XML file uploaded.'));
    }

    // If the cached entry belongs to a different File object, invalidate it.
    if (parsedFileCache.xmlFile !== file) {
      parsedFileCache.xmlFile = file;
      parsedFileCache.xmlTextPromise = file.text();
    }

    return parsedFileCache.xmlTextPromise;
  }

  function clearXmlTextCache() {
    parsedFileCache.xmlFile = null;
    parsedFileCache.xmlTextPromise = null;
  }

  // Expose so the Observation checker can reuse the already-read text.
  window.getUnifiedXmlText = () => getXmlText(files.xml);

  /**
   * Normalise a value returned by any checker into { root, table }.
   *  - If the checker returned a <table> directly, root === table.
   *  - If the checker returned a wrapper <div> that contains a <table>,
   *    root is the wrapper and table is the first contained <table>.
   *  - Returns null when neither condition holds (checker produced no result).
   */
  function resolveCheckerResult(resultElement) {
    if (resultElement instanceof HTMLTableElement) {
      return { root: resultElement, table: resultElement };
    }
    if (resultElement instanceof HTMLElement) {
      const table = resultElement.querySelector('table');
      if (table instanceof HTMLTableElement) {
        return { root: resultElement, table };
      }
    }
    return null;
  }

  let activeChecker = null;
  
  // Filter state for floating button
  let filterActive = false;
  
  // Debug log for Check All functionality
  let debugLog = [];
  
  // Storage for invalid rows from Check All
  let invalidRowsData = [];

  // Helper function to add to debug log
  function logDebug(message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      message,
      data
    };
    debugLog.push(logEntry);
    console.log(`[DEBUG-LOG] ${timestamp} - ${message}`, data || '');
  }

  // Returns true when the Medical claim-type radio is checked
  function getGlobalClaimTypeMode() {
    const medical = document.getElementById('claimTypeMedical');
    const dental = document.getElementById('claimTypeDental');
    if (medical && medical.checked) return 'MEDICAL';
    if (dental && dental.checked) return 'DENTAL';
    return null;
  }

  // Returns true when the Medical claim-type radio is checked
  function isMedicalModeSelected() {
    return getGlobalClaimTypeMode() === 'MEDICAL';
  }

  // Returns the sidebar button element for a given checker name
  function getCheckerButton(checker) {
    const btnName = `btn${checker.charAt(0).toUpperCase() + checker.slice(1)}`;
    return elements[btnName] || null;
  }

  // Hides the checker container and clears its content if it is currently active
  function hideAndClearChecker(checker) {
    const container = document.getElementById(`checker-container-${checker}`);
    if (container && activeChecker === checker) {
      container.style.display = 'none';
      container.innerHTML = '';
      activeChecker = null;
      console.log(`[BUTTON] Cleared ${checker} container (switched to DENTAL)`);
    }
  }

  // Loading overlay functions
  function showLoadingOverlay(text = 'Processing...', subtext = 'Please wait while we check your data') {
    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const loadingSubtext = document.getElementById('loadingSubtext');
    
    if (overlay) {
      overlay.classList.add('active');
      if (loadingText) loadingText.textContent = text;
      if (loadingSubtext) loadingSubtext.textContent = subtext;
      console.log('[LOADING] Showing loading overlay:', text);
    }
  }
  
  function hideLoadingOverlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
      overlay.classList.remove('active');
      console.log('[LOADING] Hiding loading overlay');
    }
  }
  
  function updateLoadingOverlay(text, subtext) {
    const loadingText = document.getElementById('loadingText');
    const loadingSubtext = document.getElementById('loadingSubtext');
    if (loadingText) loadingText.textContent = text;
    if (loadingSubtext) loadingSubtext.textContent = subtext;
  }

  // DOM elements
  let elements = {};

  document.addEventListener('DOMContentLoaded', init);

  // LocalStorage helpers for file persistence
  function init() {
    elements = {
      // File inputs
      xmlInput: document.getElementById('xmlFileInput'),
      clinicianInput: document.getElementById('clinicianFileInput'),
      eligibilityInput: document.getElementById('eligibilityFileInput'),
      authInput: document.getElementById('authFileInput'),
      statusInput: document.getElementById('statusFileInput'),
      pricingInput: document.getElementById('pricingFileInput'),
      
      // Status spans
      xmlStatus: document.getElementById('xmlStatus'),
      clinicianStatus: document.getElementById('clinicianStatus'),
      eligibilityStatus: document.getElementById('eligibilityStatus'),
      authStatus: document.getElementById('authStatus'),
      statusStatus: document.getElementById('statusStatus'),
      pricingStatus: document.getElementById('pricingStatus'),
      
      // Buttons
      btnClinician: document.getElementById('btn-clinician'),
      btnElig: document.getElementById('btn-elig'),
      btnAuths: document.getElementById('btn-auths'),
      btnTimings: document.getElementById('btn-timings'),
      btnObservations: document.getElementById('btn-observations'),
      btnSchema: document.getElementById('btn-schema'),
      btnExclusion: document.getElementById('btn-exclusion'),
      btnPricing: document.getElementById('btn-pricing'),
      btnModifiers: document.getElementById('btn-modifiers'),
      btnCheckAll: document.getElementById('btn-check-all'),
      
      // Export and filter
      exportBtn: document.getElementById('exportBtn'),
      exportAllBtn: document.getElementById('exportAllBtn'),
      exportInvalidsBtn: document.getElementById('exportInvalidsBtn'),
      floatingFilterBtn: document.getElementById('floatingFilterBtn'),
      debugLogContainer: document.getElementById('debugLogContainer'),
      downloadDebugLogBtn: document.getElementById('downloadDebugLogBtn'),
      
      // Results
      uploadStatus: document.getElementById('uploadStatus'),
      resultsContainer: document.getElementById('results-container')
    };

    // File input event listeners - add null checks to prevent crashes
    // Also add click listeners to reset input value (allows re-uploading same filename)
    if (elements.xmlInput) {
      elements.xmlInput.addEventListener('click', (e) => {
        e.target.value = ''; // Reset to allow same file to be re-uploaded
      });
      elements.xmlInput.addEventListener('change', (e) => {
        handleFileChange(e, 'xml', elements.xmlStatus);
      });
    }
    if (elements.clinicianInput) {
      elements.clinicianInput.addEventListener('click', (e) => {
        e.target.value = '';
      });
      elements.clinicianInput.addEventListener('change', (e) => {
        handleFileChange(e, 'clinician', elements.clinicianStatus);
      });
    }
    if (elements.eligibilityInput) {
      elements.eligibilityInput.addEventListener('click', (e) => {
        e.target.value = '';
      });
      elements.eligibilityInput.addEventListener('change', (e) => {
        handleFileChange(e, 'eligibility', elements.eligibilityStatus);
      });
    }
    if (elements.authInput) {
      elements.authInput.addEventListener('click', (e) => {
        e.target.value = '';
      });
      elements.authInput.addEventListener('change', (e) => {
        handleFileChange(e, 'auth', elements.authStatus);
      });
    }
    if (elements.statusInput) {
      elements.statusInput.addEventListener('click', (e) => {
        e.target.value = '';
      });
      elements.statusInput.addEventListener('change', (e) => {
        handleFileChange(e, 'status', elements.statusStatus);
      });
    }
    if (elements.pricingInput) {
      elements.pricingInput.addEventListener('click', (e) => {
        e.target.value = '';
      });
      elements.pricingInput.addEventListener('change', (e) => {
        handleFileChange(e, 'pricing', elements.pricingStatus);
      });
    }

    // Checker button event listeners
    elements.btnTimings.addEventListener('click', () => {
      runChecker('timings');
    });
    elements.btnObservations.addEventListener('click', () => {
      runChecker('observations');
    });
    elements.btnSchema.addEventListener('click', () => {
      runChecker('schema');
    });
    elements.btnExclusion.addEventListener('click', () => {
      runChecker('exclusion');
    });
    elements.btnClinician.addEventListener('click', () => {
      runChecker('clinician');
    });
    elements.btnElig.addEventListener('click', () => {
      runChecker('elig');
    });
    elements.btnAuths.addEventListener('click', () => {
      runChecker('auths');
    });
    elements.btnPricing.addEventListener('click', () => {
      runChecker('pricing');
    });
    elements.btnModifiers.addEventListener('click', () => {
      runChecker('modifiers');
    });
    elements.btnCheckAll.addEventListener('click', () => {
      runAllCheckers();
    });

    // Filter button - make it toggleable
    elements.floatingFilterBtn.addEventListener('click', () => {
      filterActive = !filterActive;
      elements.floatingFilterBtn.classList.toggle('active', filterActive);
      applyFilter();
    });

    // Claim type radio buttons - update button states when changed
    const claimTypeDental = document.getElementById('claimTypeDental');
    const claimTypeMedical = document.getElementById('claimTypeMedical');
    if (claimTypeDental) {
      claimTypeDental.addEventListener('change', () => {
        updateButtonStates();
      });
    }
    if (claimTypeMedical) {
      claimTypeMedical.addEventListener('change', () => {
        updateButtonStates();
      });
    }

    // Export button
    if (elements.exportBtn) elements.exportBtn.addEventListener('click', exportResults);
    
    // Export All button
    if (elements.exportAllBtn) elements.exportAllBtn.addEventListener('click', exportResults);
    
    // Export Invalids button
    if (elements.exportInvalidsBtn) {
      elements.exportInvalidsBtn.addEventListener('click', exportInvalids);
      // Speech bubble is visible by default in HTML with initial message
    }

    // Debug log download button
    if (elements.downloadDebugLogBtn) {
      console.log('[INIT] Debug log button found, attaching click listener');
      elements.downloadDebugLogBtn.addEventListener('click', () => {
        console.log('[DEBUG-LOG] Debug button clicked');
        downloadDebugLog();
      });
    } else {
      console.warn('[INIT] Debug log button not found in DOM');
    }

    // Clear All button
    const clearAllBtn = document.getElementById('clearAllBtn');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', clearAll);
    }

    console.log('[INIT] Performing initial button state update...');
    updateButtonStates();
    
    console.log('[INIT] ✓ Initialization complete! Ready for file uploads.');
  }

  function handleFileChange(event, fileKey, statusElement) {
    const file = event.target.files[0];
    if (file) {
      files[fileKey] = file;
      statusElement.textContent = `✓ ${file.name}`;
      statusElement.style.color = '#0f5132';
      statusElement.style.backgroundColor = '#d1e7dd';
      statusElement.style.fontWeight = 'bold';
      
      // Console log
      console.log(`[FILE] Uploaded: ${fileKey} = "${file.name}" (${(file.size / 1024).toFixed(1)} KB, type: ${file.type})`);

      // Invalidate XML text cache whenever a new XML file is selected.
      if (fileKey === 'xml') {
        clearXmlTextCache();
      }
    } else {
      files[fileKey] = null;
      statusElement.textContent = '';
      statusElement.style.backgroundColor = '';
      
      console.log(`[FILE] Cleared: ${fileKey}`);

      if (fileKey === 'xml') {
        clearXmlTextCache();
      }
    }
    updateButtonStates();
  }

  function clearAll() {
    console.log('[CLEAR] Clearing all inputs and resetting to defaults...');

    // Clear file data
    for (const key in files) { files[key] = null; }

    // Clear file input elements and status spans
    const fileInputMap = [
      { input: elements.xmlInput,         status: elements.xmlStatus },
      { input: elements.clinicianInput,   status: elements.clinicianStatus },
      { input: elements.eligibilityInput, status: elements.eligibilityStatus },
      { input: elements.authInput,        status: elements.authStatus },
      { input: elements.statusInput,      status: elements.statusStatus },
      { input: elements.pricingInput,     status: elements.pricingStatus }
    ];
    fileInputMap.forEach(({ input, status }) => {
      if (input) input.value = '';
      if (status) {
        status.textContent = '';
        status.removeAttribute('style');
      }
    });

    // Reset radio buttons to default (Dental)
    const claimTypeDental = document.getElementById('claimTypeDental');
    if (claimTypeDental) claimTypeDental.checked = true;

    // Clear results and status message
    if (elements.uploadStatus) elements.uploadStatus.innerHTML = '';
    hideAllCheckerContainers();
    activeChecker = null;

    // Reset filter state
    filterActive = false;
    if (elements.floatingFilterBtn) {
      elements.floatingFilterBtn.classList.remove('active');
    }

    // Clear file cache
    if (window.FileCache && typeof window.FileCache.clear === 'function') window.FileCache.clear();

    // Clear XML text cache
    clearXmlTextCache();

    // Reset debug log and export state
    debugLog = [];
    invalidRowsData = [];
    if (elements.exportInvalidsBtn) {
      elements.exportInvalidsBtn.disabled = true;
    }
    if (elements.exportAllBtn) {
      elements.exportAllBtn.disabled = true;
    }
    if (elements.debugLogContainer) {
      elements.debugLogContainer.style.display = 'none';
    }

    updateButtonStates();
    console.log('[CLEAR] All inputs cleared and defaults restored.');
  }

  function updateButtonStates() {
    console.log('[BUTTON] Updating button states based on available files and claim type...');
    console.log('[BUTTON] Current files state:', JSON.stringify(files));
    
    const isMedical = isMedicalModeSelected();
    
    const requirements = {
      clinician: ['xml'], // clinician and status files are auto-loaded from resources
      elig: ['xml', 'eligibility'],
      auths: ['xml', 'auth'],
      timings: ['xml'],
      observations: ['xml'],
      schema: ['xml'],
      exclusion: ['xml'],
      pricing: ['xml'],
      modifiers: ['xml', 'eligibility']
    };

    for (const [checker, reqs] of Object.entries(requirements)) {
      const button = getCheckerButton(checker);
      console.log(`[BUTTON] Checking ${checker}: button element found = ${!!button}`);

      if (!button) {
        console.log(`[BUTTON] ${checker}: BUTTON ELEMENT NOT FOUND`);
        continue;
      }

      // Medical-only checkers are hidden and disabled when Dental is selected
      const isMedicalOnly = MEDICAL_ONLY_CHECKERS.has(checker);
      if (isMedicalOnly && !isMedical) {
        button.disabled = true;
        button.style.display = 'none';
        hideAndClearChecker(checker);
        console.log(`[BUTTON] ${checker}: HIDDEN (claim type is DENTAL, ${checker} only available for MEDICAL)`);
        continue;
      }

      button.style.display = ''; // Restore from possible Medical-only hide

      const hasAll = reqs.every(req => {
        const hasFile = files[req] !== null && files[req] !== undefined;
        console.log(`[BUTTON]   - Checking requirement '${req}': ${hasFile ? 'YES' : 'NO'} (value: ${files[req] ? 'File object' : files[req]})`);
        return hasFile;
      });
      button.disabled = !hasAll;
      
      const missingFiles = reqs.filter(req => !files[req]);
      if (hasAll) {
        console.log(`[BUTTON] ${checker}: ENABLED (has all required: ${reqs.join(', ')})`);
      } else {
        console.log(`[BUTTON] ${checker}: DISABLED (missing: ${missingFiles.join(', ')})`);
      }
    }

    if (elements.btnCheckAll) {
      elements.btnCheckAll.disabled = !files.xml;
      if (files.xml) {
        console.log('[BUTTON] Check All: ENABLED (has XML file)');
      } else {
        console.log('[BUTTON] Check All: DISABLED (missing XML file)');
      }
    }
    
    console.log('[BUTTON] Button state update complete');
  }

  async function runChecker(checkerName) {
    console.log(`[DEBUG] runChecker called with: ${checkerName}`);
    console.log(`[DEBUG] Files available:`, Object.keys(files).filter(k => files[k]));
    
    // Safety guard: Medical-only checkers must not run when Dental is selected.
    // This protects against stale or programmatic execution even when the button is hidden.
    if (MEDICAL_ONLY_CHECKERS.has(checkerName) && !isMedicalModeSelected()) {
      console.warn(
        `[CHECKER] Skipped ${checkerName}: ` +
        'Medical mode is not selected.'
      );
      return null;
    }
    
    try {
      // Show loading overlay
      showLoadingOverlay(`Running ${checkerName} checker...`, 'Processing your data...');
      
      elements.uploadStatus.innerHTML = `<div class="status-message info">Running ${checkerName} checker...</div>`;
      
      setActiveButton(checkerName);
      activeChecker = checkerName;

      // Reset filter when starting a new checker (Bug #26 fix)
      // Always set to inactive state when new tables are loaded
      filterActive = false;
      if (elements.floatingFilterBtn) {
        elements.floatingFilterBtn.classList.remove('active');
      }
      console.log('[FILTER] Auto-reset: Filter set to off when running new checker');

      // Hide all checker containers and show the active one
      hideAllCheckerContainers();
      const container = document.getElementById(`checker-container-${checkerName}`);
      if (!container) {
        throw new Error(`Container for ${checkerName} not found`);
      }
      container.style.display = 'block';

      // Always recreate interface to ensure fresh state (Bug #3 fix)
      console.log(`[DEBUG] Creating ${checkerName} interface...`);
      createCheckerInterface(checkerName, container);

      // Sync global claim type with timings checker if applicable
      if (checkerName === 'timings') {
        console.log('[DEBUG] Syncing claim type for timings');
        syncClaimType(container);
      }

      // Set files in the checker's hidden inputs and run
      console.log(`[DEBUG] Executing ${checkerName} checker...`);
      const tableElement = await executeChecker(checkerName, container);

      // Collect invalid rows from this individual checker
      if (tableElement) {
        const invalidRows = tableElement.querySelectorAll('tbody tr.table-danger, tbody tr.table-warning, tbody tr.invalid, tbody tr.unknown');
        if (invalidRows.length > 0) {
          console.log(`[CHECKER] Found ${invalidRows.length} invalid rows in ${checkerName}`);
          // Reset invalidRowsData for single checker (don't accumulate from previous runs)
          invalidRowsData = [];
          invalidRows.forEach(row => {
            const rowData = {
              checker: checkerName,
              cells: []
            };
            row.querySelectorAll('td').forEach(cell => {
              rowData.cells.push(cell.textContent.trim());
            });
            invalidRowsData.push(rowData);
          });
          
          // Enable Export Invalids button
          if (elements.exportInvalidsBtn) {
            elements.exportInvalidsBtn.disabled = false;
            console.log(`[CHECKER] Export Invalids button enabled (${invalidRows.length} invalid rows)`);
          }
        } else {
          // No invalids found, disable button
          invalidRowsData = [];
          if (elements.exportInvalidsBtn) {
            elements.exportInvalidsBtn.disabled = true;
            console.log(`[CHECKER] Export Invalids button disabled (no invalid rows)`);
          }
        }
      }

      // Bug #6: Clean up inactive containers to free memory
      cleanupInactiveContainers(checkerName);

      elements.uploadStatus.innerHTML = ''; // Clear status message
      if (elements.exportBtn) {
        elements.exportBtn.disabled = false;
      }
      if (elements.exportAllBtn) {
        elements.exportAllBtn.disabled = false;
      }
      console.log(`[DEBUG] ${checkerName} checker completed successfully`);

      // Apply filter if button is active (works on already-rendered tables)
      if (filterActive) {
        setTimeout(() => applyFilter(), 100); // Small delay to ensure table is fully rendered
      }
      
      // Hide loading overlay after completion
      hideLoadingOverlay();

    } catch (error) {
      console.error('[DEBUG] Error running checker:', error);
      console.error(error.stack);
      elements.uploadStatus.innerHTML = `<div class="status-message error">Error: ${error.message}</div>`;
      const container = document.getElementById(`checker-container-${checkerName}`);
      if (container) {
        container.innerHTML = `<div class="alert alert-danger" role="alert"><strong>Error:</strong> ${error.message}</div>`;
      }
      // Hide loading overlay on error
      hideLoadingOverlay();
    }
  }

  function hideAllCheckerContainers() {
    const containers = document.querySelectorAll('.checker-container');
    containers.forEach(c => c.style.display = 'none');
  }

  // Bug #6: Memory cleanup for inactive containers
  function cleanupInactiveContainers(activeCheckerName) {
    console.log(`[DEBUG] Cleaning up inactive containers (keeping ${activeCheckerName})`);
    const allCheckers = ['schema', 'exclusion', 'timings', 'observations', 'elig', 'auths', 'clinician', 'pricing', 'modifiers'];
    
    allCheckers.forEach(checkerName => {
      if (checkerName !== activeCheckerName) {
        const container = document.getElementById(`checker-container-${checkerName}`);
        if (container && container.style.display === 'none') {
          // Clear results from hidden containers to free memory
          const resultsDiv = container.querySelector('#results');
          if (resultsDiv && resultsDiv.innerHTML) {
            resultsDiv.innerHTML = '';
            console.log(`[DEBUG] Cleared results from inactive container: ${checkerName}`);
          }
        }
      }
    });
  }

  function createCheckerInterface(checkerName, container) {
    // Create a simple interface for the checker with necessary DOM elements
    const interfaces = {
      timings: () => {
        // Read current global radio button state
        const globalDental = document.getElementById('claimTypeDental');
        const globalMedical = document.getElementById('claimTypeMedical');
        const isDental = globalDental ? globalDental.checked : true;
        const isMedical = globalMedical ? globalMedical.checked : false;
        
        console.log('🟡 [TIMINGS-INIT] Creating interface with claim type:', isDental ? 'DENTAL' : 'MEDICAL');
        
        return `
          <div id="typeSelector" style="display:none;">
            <label><input type="radio" name="claimType" value="DENTAL" ${isDental ? 'checked' : ''}> Dental</label>
            <label><input type="radio" name="claimType" value="MEDICAL" ${isMedical ? 'checked' : ''}> Medical</label>
          </div>
          <input type="file" id="xmlFileInput" accept=".xml" style="display:none" />
          <button id="exportBtn" class="btn btn-secondary" style="display:none;">Export Invalid Entries</button>
          <div id="resultsSummary" style="margin:10px;font-weight:bold;"></div>
          <div id="results"></div>
        `;
      },
      observations: `
        <input type="file" id="xmlFile" accept=".xml" style="display:none" />
        <button id="exportBtn" class="btn btn-secondary" style="display:none;">Export Invalid Activities</button>
        <div id="messageBox" style="color: red; font-weight: bold;"></div>
        <div id="resultsSummary" style="margin:10px;font-weight:bold;"></div>
        <div id="results"></div>
      `,
      schema: `
        <input type="file" data-role="schema-xml-file" accept=".xml" style="display:none" />
        <div data-role="schema-status" aria-live="polite"></div>
        <div data-role="schema-results"></div>
      `,
      exclusion: `
        <input type="file" id="xmlFile" accept=".xml" style="display:none" />
        <div id="uploadStatus" aria-live="polite"></div>
        <div id="results"></div>
      `,
      clinician: `
        <input type="file" id="xmlFileInput" accept=".xml" style="display:none" />
        <input type="file" id="clinicianFileInput" accept=".xlsx" style="display:none" />
        <input type="file" id="statusFileInput" accept=".xlsx" style="display:none" />
        <button id="processBtn" class="btn btn-primary" style="display:none;">Validate</button>
        <button id="exportCsvBtn" class="btn btn-secondary" style="display:none;">Export to Excel</button>
        <div id="uploadStatus" aria-live="polite"></div>
        <div id="results"></div>
      `,
      elig: `
        <div id="xmlReportInputGroup" style="display:block;">
          <input type="file" id="xmlFileInput" accept=".xml" style="display:none" />
        </div>
        <div id="reportInputGroup" style="display:none;">
          <input type="file" id="reportFileInput" accept=".xlsx" style="display:none" />
        </div>
        <input type="file" id="eligibilityFileInput" accept=".xlsx" style="display:none" />
        <div style="display:none;">
          <label><input type="radio" name="reportSource" value="xml" checked> XML</label>
          <label><input type="radio" name="reportSource" value="xls"> XLS</label>
        </div>
        <button id="processBtn" class="btn btn-primary" style="display:none;">Process</button>
        <button id="exportInvalidBtn" class="btn btn-secondary" style="display:none;">Export Invalid Rows</button>
        <div id="uploadStatus" style="margin-top:12px; color:#0074D9;"></div>
        <div id="results" style="margin-top:20px;"></div>
      `,
      auths: `
        <input type="file" id="xmlInput" accept=".xml" style="display:none" />
        <input type="file" id="xlsxInput" accept=".xlsx" style="display:none" />
        <button id="processBtn" class="btn btn-primary" style="display:none;">Run Checker</button>
        <div id="uploadStatus" style="margin-top:12px; color:#0074D9;"></div>
        <div id="file-status"></div>
        <div id="results"></div>
      `,
      pricing: `
        <input type="file" id="xml-file" accept=".xml" style="display:none" />
        <input type="file" id="xlsx-file" accept=".xlsx" style="display:none" />
        <button id="run-button" class="btn btn-primary" style="display:none;">Run Check</button>
        <button id="download-button" class="btn btn-secondary" style="display:none;">Download Results</button>
        <div id="progress-bar-container" class="progress-bar-container"></div>
        <div id="messageBox" class="message-box" aria-live="polite"></div>
        <div id="results">
          <div id="outputTableContainer" class="results-container"></div>
        </div>
      `,
      modifiers: `
        <input type="file" id="xml-file" accept=".xml" style="display:none" />
        <input type="file" id="xlsx-file" accept=".xlsx" style="display:none" />
        <button id="run-button" class="btn btn-primary" style="display:none;">Run Check</button>
        <button id="download-button" class="btn btn-secondary" style="display:none;">Download Results</button>
        <div id="messageBox" class="message-box" aria-live="polite"></div>
        <div id="results">
          <div id="outputTableContainer" class="results-container"></div>
        </div>
      `
    };

    container.innerHTML = (typeof interfaces[checkerName] === 'function' ? interfaces[checkerName]() : interfaces[checkerName]) || '<div id="results"></div>';
  }

  function syncClaimType(container) {
    // Get the global claim type selection
    const globalDental = document.getElementById('claimTypeDental');
    const globalMedical = document.getElementById('claimTypeMedical');
    
    if (!globalDental || !globalMedical) {
      console.warn('[SYNC] WARNING: Global claim type radio buttons not found');
      return;
    }
    
    const selectedType = globalDental.checked ? 'DENTAL' : 'MEDICAL';
    
    // Set the hidden radio buttons in the timings checker to match
    const timingsRadios = container.querySelectorAll('input[name="claimType"]');
    
    if (timingsRadios.length === 0) {
      console.error('[SYNC] ERROR: No radio buttons found in timings container');
      return;
    }
    
    timingsRadios.forEach((radio) => {
      radio.checked = (radio.value === selectedType);
    });
    
    // Verify the sync worked
    const checkedRadio = container.querySelector('input[name="claimType"]:checked');
    if (!checkedRadio) {
      console.error('[SYNC] ERROR: No radio button checked after sync');
    }
  }

  async function executeChecker(checkerName, container) {
    console.log(`[DEBUG] executeChecker called for: ${checkerName}`);
    
    // ✅ Clear previous results before running checker
    const resultsDiv = container.querySelector('#results, [data-role="schema-results"]');
    if (resultsDiv) {
      resultsDiv.innerHTML = '';
      console.log(`[DEBUG] Cleared previous results for ${checkerName}`);
    }
    
    // Also clear other common result containers
    const resultsSummary = container.querySelector('#resultsSummary');
    if (resultsSummary) {
      resultsSummary.innerHTML = '';
    }
    
    const messageBox = container.querySelector('#messageBox');
    if (messageBox) {
      messageBox.innerHTML = '';
    }
    
    const uploadStatus = container.querySelector('#uploadStatus, [data-role="schema-status"]');
    if (uploadStatus) {
      uploadStatus.innerHTML = '';
    }
    
    const fileStatus = container.querySelector('#file-status');
    if (fileStatus) {
      fileStatus.innerHTML = '';
    }
    
    const fileInputMap = {
      clinician: { xmlFileInput: 'xml' }, // clinician and status files are auto-loaded from resources
      elig: { xmlFileInput: 'xml', eligibilityFileInput: 'eligibility' },
      auths: { xmlInput: 'xml', xlsxInput: 'auth' },
      timings: { xmlFileInput: 'xml' },
      observations: { xmlFile: 'xml' },
      schema: {},
      exclusion: { xmlFile: 'xml' },
      pricing: { 'xml-file': 'xml', 'xlsx-file': 'pricing' },
      modifiers: { 'xml-file': 'xml', 'xlsx-file': 'eligibility' }
    };

    const inputMap = fileInputMap[checkerName];
    if (!inputMap) {
      console.warn(`[DEBUG] No input map found for: ${checkerName}`);
      return;
    }

    // Set files in hidden inputs within the container
    console.log(`[DEBUG] Setting files for ${checkerName}:`, inputMap);
    for (const [inputId, fileKey] of Object.entries(inputMap)) {
      const input = container.querySelector(`#${inputId}`);
      console.log(`[DEBUG] Looking for input #${inputId}, found:`, !!input, 'File key:', fileKey, 'Has file:', !!files[fileKey]);
      
      if (input && files[fileKey]) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(files[fileKey]);
        input.files = dataTransfer.files;
        console.log(`[DEBUG] Set file for #${inputId}:`, input.files[0]?.name);
        
        // Trigger change event
        const event = new Event('change', { bubbles: true });
        input.dispatchEvent(event);
      }
    }

    // Call the checker function directly (scripts are already loaded)
    // Bug #5 fix: Use function registry map instead of if-else chain
    try {
      console.log(`[DEBUG] Calling ${checkerName} checker function...`);
      
      const checkerFunctions = {
        schema: () => {
          if (typeof window.validateXmlSchema !== 'function') {
            throw new Error(
              'Schema Checker failed to load: window.validateXmlSchema is unavailable.'
            );
          }

          return window.validateXmlSchema({
            file: files.xml,
            container,
            claimTypeMode: getGlobalClaimTypeMode()
          });
        },
        exclusion: runExclusionCheck,
        timings: validateTimingsAsync,
        observations: () => parseXML(files.xml),
        elig: () => {
          if (typeof window.runEligCheck !== 'function') {
            throw new Error(
              'Eligibility Checker failed to load: window.runEligCheck is unavailable.'
            );
          }

          return window.runEligCheck({
            xmlFile: files.xml,
            eligibilityFile: files.eligibility,
            container
          });
        },
        auths: runAuthsCheck,
        // Pass the shared XML file directly so the clinician checker can read it
        // without depending on an asynchronous dispatched-event side-effect.
        clinician: () => runClinicianCheck(files.xml),
        pricing: () => runPricingCheck({
          xmlFile: files.xml,
          xlsxFile: files.pricing || null,
          drugsFile: files.drugs || null,
          claimTypeMode: isMedicalModeSelected() ? 'MEDICAL' : 'DENTAL'
        }),
        modifiers: runModifiersCheck
      };
      
      const checkerFn = checkerFunctions[checkerName];
      
      if (!checkerFn || typeof checkerFn !== 'function') {
        throw new Error(`Checker function not found for: ${checkerName}`);
      }
      
      console.log(`[DEBUG] Executing ${checkerName} checker function`);
      const resultElement = await checkerFn();  // GET the returned element

      // Resolve the element into { root, table } if possible.
      // This handles checkers that return a wrapper <div> (e.g. clinician) as well
      // as checkers that return a <table> directly.
      const checkerResult = resolveCheckerResult(resultElement);

      if (checkerResult && resultsDiv) {
        // Render the full root element (preserves summary, modals, etc.)
        console.log(`[DEBUG] Rendering result from ${checkerName}`);
        resultsDiv.appendChild(checkerResult.root);
      } else if (resultElement && !checkerResult && resultsDiv) {
        // Result exists but contains no table — render as-is (informational/warning element)
        console.log(`[DEBUG] Rendering non-table result from ${checkerName}`);
        resultsDiv.appendChild(resultElement);
      } else if (!resultElement) {
        console.log(`[DEBUG] ${checkerName} returned no result (may have rendered status message instead)`);
      }
      
      // Return the raw result element so Check All can resolve it independently.
      return resultElement;
      
    } catch (error) {
      console.error(`[DEBUG] Error executing ${checkerName}:`, error);
      throw error;
    }
  }

  function setActiveButton(checkerName) {
    const allButtons = [
      elements.btnClinician, elements.btnElig, elements.btnAuths,
      elements.btnTimings, elements.btnObservations, elements.btnSchema,
      elements.btnExclusion, elements.btnPricing, elements.btnModifiers,
      elements.btnCheckAll
    ];
    
    allButtons.forEach(btn => btn && btn.classList.remove('active'));
    
    const btnName = `btn${checkerName.charAt(0).toUpperCase() + checkerName.slice(1)}`;
    const currentBtn = elements[btnName];
    if (currentBtn) {
      currentBtn.classList.add('active');
    }
  }

  /**
   * Re-attach event listeners to a cloned table for Check-All functionality
   * When tables are cloned, event listeners are lost. This function restores them.
   */
  function reattachEventListeners(clonedTable, checkerName) {
    console.log(`[CHECK-ALL] Re-attaching event listeners for ${checkerName} table`);
    
    try {
      if (checkerName === 'schema') {
        const buttons = clonedTable.querySelectorAll('.view-claim-btn[data-claim-xml]');
        buttons.forEach(btn => {
          btn.onclick = () => {
            if (typeof window.showModal === 'function' && typeof window.claimToHtmlTable === 'function') {
              const claimXml = decodeURIComponent(btn.getAttribute('data-claim-xml') || '');
              window.showModal(window.claimToHtmlTable(claimXml));
            } else {
              console.error('[CHECK-ALL] Modal functions not available');
            }
          };
        });
        console.log(`[CHECK-ALL] Re-attached ${buttons.length} event listeners for schema checker`);
      } else if (checkerName === 'elig') {
        // Eligibility detail buttons carry a stable detail ID. The Eligibility
        // checker registers one delegated document-level click handler, so the
        // buttons continue to work after Check All clones the result wrapper.
        if (typeof window.initEligibilityModal === 'function') {
          window.initEligibilityModal();
        }

        const detailButtons = clonedTable.querySelectorAll(
          'button.eligibility-details[data-eligibility-detail-id]'
        );

        detailButtons.forEach(button => {
          // Remove stale inline handlers from older Eligibility checker builds.
          button.removeAttribute('onclick');
        });

        console.log(
          `[CHECK-ALL] Found ${detailButtons.length} eligibility detail button(s) ` +
          '(handled by delegated modal listener).'
        );
      } else if (checkerName === 'clinician') {
        // Clinician checker uses .view-activities and .view-license-history buttons.
        // clonedTable is the full cloned root element (a <div> that contains the
        // <table>, summary, and modal elements).  All lookups must be scoped to
        // this root so they find the modals that were cloned along with it.
        console.log('[CHECK-ALL] Re-attaching clinician modal event listeners');
        
        const rootElement = clonedTable; // full cloned wrapper div
        
        // Re-attach .view-activities button listeners
        const activityButtons = rootElement.querySelectorAll('.view-activities');
        console.log(`[CHECK-ALL] Found ${activityButtons.length} activity buttons`);
        
        activityButtons.forEach(btn => {
          btn.addEventListener('click', function() {
            const uniqueIdFromButton = this.getAttribute('data-uniqueid');
            const modalId = this.getAttribute('data-modalid');
            
            console.log(`[CHECK-ALL] Activity button clicked: uniqueId=${uniqueIdFromButton}, modalId=${modalId}`);
            
            // Get modal data from global storage
            const modalData = window._clinicianModalData && window._clinicianModalData[uniqueIdFromButton];
            if (!modalData) {
              console.error('[CHECK-ALL] Modal data not found for uniqueId:', uniqueIdFromButton);
              return;
            }
            
            // Modals are inside the cloned root element
            const activityModal = rootElement.querySelector(`#activityModal_${uniqueIdFromButton}`);
            const activityModalText = rootElement.querySelector(`#activityModalText_${uniqueIdFromButton}`);
            
            if (activityModalText && modalData[modalId]) {
              activityModalText.innerHTML = modalData[modalId];
            }
            if (activityModal) {
              activityModal.style.display = 'block';
            }
          });
        });
        
        // Re-attach .view-license-history button listeners
        const licenseButtons = rootElement.querySelectorAll('.view-license-history');
        console.log(`[CHECK-ALL] Found ${licenseButtons.length} license history buttons`);
        
        licenseButtons.forEach(btn => {
          btn.addEventListener('click', function() {
            const uniqueIdFromButton = this.getAttribute('data-uniqueid');
            const fullHistory = decodeURIComponent(this.getAttribute('data-fullhistory'));
            
            console.log(`[CHECK-ALL] License history button clicked: uniqueId=${uniqueIdFromButton}`);
            
            // Modals are inside the cloned root element
            const licenseHistoryModal = rootElement.querySelector(`#licenseHistoryModal_${uniqueIdFromButton}`);
            const licenseHistoryText = rootElement.querySelector(`#licenseHistoryText_${uniqueIdFromButton}`);
            
            if (licenseHistoryText && window._formatClinicianLicenseHistory) {
              licenseHistoryText.innerHTML = window._formatClinicianLicenseHistory(fullHistory);
            }
            if (licenseHistoryModal) {
              licenseHistoryModal.style.display = 'block';
            }
          });
        });
        
        // Re-attach modal close handlers
        // Find all unique IDs from buttons
        const uniqueIds = new Set();
        activityButtons.forEach(btn => uniqueIds.add(btn.getAttribute('data-uniqueid')));
        licenseButtons.forEach(btn => uniqueIds.add(btn.getAttribute('data-uniqueid')));
        
        uniqueIds.forEach(uniqueId => {
          // Activity modal close handlers
          const activityModalClose = rootElement.querySelector(`#activityModalClose_${uniqueId}`);
          const activityModal = rootElement.querySelector(`#activityModal_${uniqueId}`);
          
          if (activityModalClose && activityModal) {
            activityModalClose.onclick = function() {
              activityModal.style.display = 'none';
            };
          }
          
          if (activityModal) {
            activityModal.onclick = function(event) {
              if (event.target === this) this.style.display = 'none';
            };
          }
          
          // License history modal close handlers
          const licenseHistoryClose = rootElement.querySelector(`#licenseHistoryClose_${uniqueId}`);
          const licenseHistoryModal = rootElement.querySelector(`#licenseHistoryModal_${uniqueId}`);
          
          if (licenseHistoryClose && licenseHistoryModal) {
            licenseHistoryClose.onclick = function() {
              licenseHistoryModal.style.display = 'none';
            };
          }
          
          if (licenseHistoryModal) {
            licenseHistoryModal.onclick = function(event) {
              if (event.target === this) this.style.display = 'none';
            };
          }
        });
        
        console.log(`[CHECK-ALL] Re-attached event listeners for ${activityButtons.length} activity buttons and ${licenseButtons.length} license buttons`);
      } else if (checkerName === 'pricing') {
        // Pricing checker uses Compare buttons with data-pricing-index
        const compareBtns = clonedTable.querySelectorAll('[data-pricing-index]');
        compareBtns.forEach(btn => {
          const idx = parseInt(btn.dataset.pricingIndex, 10);
          if (!isNaN(idx)) {
            btn.onclick = () => window.showPricingComparison(idx);
          }
        });
        console.log(`[CHECK-ALL] Re-attached ${compareBtns.length} pricing compare button(s)`);
      }
      // Add more checker types as needed
    } catch (error) {
      console.error(`[CHECK-ALL] Error re-attaching event listeners for ${checkerName}:`, error);
    }
  }

  async function runAllCheckers() {
    try {
      console.log('[CHECK-ALL] Starting Check All functionality...');
      
      // Show loading overlay
      showLoadingOverlay('Running all checkers...', 'Please wait while we check all your data');
      
      // Reset debug log and invalid rows data
      debugLog = [];
      invalidRowsData = [];
      logDebug('Check All Started', { timestamp: new Date().toISOString() });
    
    // Disable Export Invalids button initially
    if (elements.exportInvalidsBtn) {
      elements.exportInvalidsBtn.disabled = true;
    }
    
    // Disable Export All button initially
    if (elements.exportAllBtn) {
      elements.exportAllBtn.disabled = true;
    }
    
    // Hide debug log button initially
    if (elements.debugLogContainer) {
      elements.debugLogContainer.style.display = 'none';
    }
    
    // Log system information
    logDebug('System Information', {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screenResolution: `${screen.width}x${screen.height}`,
      viewportSize: `${window.innerWidth}x${window.innerHeight}`
    });
    
    // Log uploaded files
    logDebug('Uploaded Files', {
      xml: files.xml ? files.xml.name : 'Not uploaded',
      clinician: files.clinician ? files.clinician.name : 'Not uploaded',
      eligibility: files.eligibility ? files.eligibility.name : 'Not uploaded',
      auth: files.auth ? files.auth.name : 'Not uploaded',
      status: files.status ? files.status.name : 'Not uploaded',
      pricing: files.pricing ? files.pricing.name : 'Not uploaded'
    });
    
    // Determine which checkers are available (enabled buttons)
    const availableCheckers = [];
    const checkerButtons = {
      'elig': elements.btnElig,
      'auths': elements.btnAuths,
      'timings': elements.btnTimings,
      'observations': elements.btnObservations,
      'schema': elements.btnSchema,
      'exclusion': elements.btnExclusion,
      'clinician': elements.btnClinician,
      'pricing': elements.btnPricing,
      'modifiers': elements.btnModifiers
    };
    
    // Find all enabled checkers, explicitly skipping Medical-only checkers in Dental mode
    const isMedical = isMedicalModeSelected();
    for (const [checkerName, button] of Object.entries(checkerButtons)) {
      if (MEDICAL_ONLY_CHECKERS.has(checkerName) && !isMedical) {
        logDebug(`Checker Skipped: ${checkerName}`, { reason: 'Medical-only checker' });
        continue;
      }
      if (button && !button.disabled) {
        availableCheckers.push(checkerName);
        logDebug(`Checker Available: ${checkerName}`, { 
          buttonEnabled: true,
          buttonExists: !!button 
        });
      } else {
        logDebug(`Checker Unavailable: ${checkerName}`, { 
          buttonEnabled: false,
          buttonExists: !!button,
          reason: !button ? 'Button element not found' : 'Button is disabled (missing required files)'
        });
      }
    }
    
    console.log('[CHECK-ALL] Available checkers:', availableCheckers);
    logDebug('Available Checkers Detected', { 
      count: availableCheckers.length,
      checkers: availableCheckers 
    });
    
    if (availableCheckers.length === 0) {
      const errorMsg = 'No checkers are available. Please upload the required files first.';
      elements.uploadStatus.innerHTML = `<div class="status-message error">${errorMsg}</div>`;
      logDebug('Check All Aborted', { reason: 'No checkers available' });
      
      // Show debug log button even if aborted
      if (elements.debugLogContainer) {
        elements.debugLogContainer.style.display = 'block';
      }
      
      // Hide loading overlay since we're done
      hideLoadingOverlay();
      return;
    }
    
    // Show progress message
    elements.uploadStatus.innerHTML = `<div class="status-message info">Running ${availableCheckers.length} checker(s): ${availableCheckers.join(', ')}... Please wait.</div>`;
    logDebug('Check All Progress Started', { 
      totalCheckers: availableCheckers.length,
      checkerList: availableCheckers.join(', ')
    });
    
    // Set Check All button as active
    setActiveButton('checkAll');
    activeChecker = 'check-all';
    
    // Reset filter when starting Check All
    // Always set to inactive state when new tables are loaded
    filterActive = false;
    if (elements.floatingFilterBtn) {
      elements.floatingFilterBtn.classList.remove('active');
    }
    console.log('[FILTER] Auto-reset: Filter set to off when running Check All');
    
    // Hide all containers and show the check-all container
    hideAllCheckerContainers();
    const checkAllContainer = document.getElementById('checker-container-check-all');
    if (checkAllContainer) {
      checkAllContainer.style.display = 'block';
      checkAllContainer.innerHTML = '<div id="results"></div>';
    }
    
    logDebug('Results Container Cleared');
    
    // Array to store all results for combined export
    const allResults = [];
    let successCount = 0;
    let errorCount = 0;
    const checkerTimings = [];
    
    // Run each available checker sequentially
    for (const checkerName of availableCheckers) {
      const checkerStartTime = performance.now();
      logDebug(`Starting Checker: ${checkerName}`, {
        checkerNumber: successCount + errorCount + 1,
        totalCheckers: availableCheckers.length,
        timestamp: new Date().toISOString()
      });
      
      try {
        console.log(`[CHECK-ALL] Running ${checkerName} checker...`);
        
        // Update loading overlay with current progress
        updateLoadingOverlay(
          `Running ${checkerName} checker...`,
          `Progress: ${successCount + errorCount + 1}/${availableCheckers.length} checkers`
        );
        
        // Update status
        if (elements.uploadStatus) {
          elements.uploadStatus.innerHTML = `<div class="status-message info">Running ${checkerName} checker (${successCount + errorCount + 1}/${availableCheckers.length})...</div>`;
        }
        
        // Create a section for this checker's results
        const sectionDiv = document.createElement('div');
        sectionDiv.id = `${checkerName}-section`;
        sectionDiv.style.marginBottom = '30px';
        
        // Add clipboard button for ALL checkers
        const clipboardButton = `<button class="btn btn-sm btn-outline-primary checker-copy-button" data-checker="${checkerName}" style="margin-left:10px;" title="Copy invalid ${checkerName.toUpperCase()} results to clipboard">📋 Copy Invalids</button>`;
        
        sectionDiv.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #0d6efd;padding-bottom:10px;margin-top:20px;">
            <h3 style="color:#0d6efd;margin:0;">
              ${checkerName.toUpperCase()} Checker Results
            </h3>
            ${clipboardButton}
          </div>
          <div id="${checkerName}-results"></div>
        `;
        if (checkAllContainer) {
          checkAllContainer.appendChild(sectionDiv);
          
          // Attach event listener to clipboard button
          const copyBtn = sectionDiv.querySelector('.checker-copy-button');
          if (copyBtn) {
            copyBtn.addEventListener('click', () => copyCheckerInvalidResults(checkerName));
            logDebug(`${checkerName} copy button event listener attached`);
          }
        }
        
        logDebug(`Created Results Section: ${checkerName}`);
        
        // Get this checker's persistent container and run it
        const checkerContainer = document.getElementById(`checker-container-${checkerName}`);
        let table = null;
        
        if (checkerContainer) {
          // IMPORTANT: Ensure checker container stays hidden during Check All
          checkerContainer.style.display = 'none';
          
          // Execute the checker and get returned element (Bug #10 fix: removed duplicate initialization check)
          logDebug(`Executing Checker: ${checkerName}`);
          table = await executeChecker(checkerName, checkerContainer);
          
          // Re-confirm container is hidden after execution
          checkerContainer.style.display = 'none';
        }
        const checkerEndTime = performance.now();
        const executionTime = (checkerEndTime - checkerStartTime).toFixed(2);
        
        // Get section results container (needed for both success and failure cases)
        const sectionResults = document.getElementById(`${checkerName}-results`);

        // Accept either a <table> directly or a wrapper element that contains a <table>
        // (e.g. the clinician checker returns a <div> with summary, table, and modals).
        const checkerResult = resolveCheckerResult(table);
        
        if (checkerResult) {
          successCount++;
          const tableEl = checkerResult.table;
          const rootEl  = checkerResult.root;
          const rowCount = tableEl.querySelectorAll('tbody tr').length;
          console.log(`[CHECK-ALL] ✓ ${checkerName} checker completed successfully`);
          
          // Collect invalid rows from the resolved table
          const invalidRows = tableEl.querySelectorAll('tbody tr.table-danger, tbody tr.table-warning, tbody tr.invalid, tbody tr.unknown');
          if (invalidRows.length > 0) {
            console.log(`[CHECK-ALL] Found ${invalidRows.length} invalid rows in ${checkerName}`);
            invalidRows.forEach(row => {
              const rowData = {
                checker: checkerName,
                cells: []
              };
              row.querySelectorAll('td').forEach(cell => {
                rowData.cells.push(cell.textContent.trim());
              });
              invalidRowsData.push(rowData);
            });
          }
          
          // Copy the full root element (preserves wrapper, summary, and modals for checkers
          // like clinician that return a <div> instead of a bare <table>).
          if (sectionResults && rootEl) {
            const clonedRoot = rootEl.cloneNode(true);
            sectionResults.appendChild(clonedRoot);
            
            // Re-attach event listeners that were lost during cloning
            reattachEventListeners(clonedRoot, checkerName);
          }
          
          logDebug(`Checker Success: ${checkerName}`, {
            status: 'success',
            executionTimeMs: executionTime,
            rowsGenerated: rowCount,
            tableGenerated: true
          });
          
          checkerTimings.push({
            checker: checkerName,
            executionTimeMs: executionTime,
            status: 'success',
            rowCount: rowCount
          });
          
          // Store the resolved table (not the wrapper) for combined export
          allResults.push({
            checkerName: checkerName,
            table: tableEl.cloneNode(true)
          });
        } else if (table instanceof HTMLElement) {
          successCount++;
          console.log(`[CHECK-ALL] ✓ ${checkerName} checker returned a non-table result element`);
          if (sectionResults) {
            sectionResults.appendChild(table.cloneNode(true));
          }
          logDebug(`Checker Success: ${checkerName}`, {
            status: 'success',
            executionTimeMs: executionTime,
            rowsGenerated: 0,
            tableGenerated: false,
            elementType: table.className || table.tagName
          });
          checkerTimings.push({
            checker: checkerName,
            executionTimeMs: executionTime,
            status: 'success',
            rowCount: 0
          });
        } else {
          errorCount++;
          console.log(`[CHECK-ALL] ✗ ${checkerName} checker failed to generate table`);
          if (sectionResults) {
            const noResultsMsg = checkerName === 'pricing'
              ? 'XML Claims are non-Thiqa, prices are not being checked.'
              : 'No results or checker did not complete';
            sectionResults.innerHTML = `<div class="alert alert-warning">${noResultsMsg}</div>`;
          }
          
          logDebug(`Checker Failed: ${checkerName}`, {
            status: 'failed',
            executionTimeMs: executionTime,
            reason: 'No table generated',
            tableGenerated: false
          });
          
          checkerTimings.push({
            checker: checkerName,
            executionTimeMs: executionTime,
            status: 'failed',
            reason: 'No table generated'
          });
        }
        
      } catch (error) {
        errorCount++;
        const checkerEndTime = performance.now();
        const executionTime = (checkerEndTime - checkerStartTime).toFixed(2);
        
        console.error(`[CHECK-ALL] Error running ${checkerName}:`, error);
        const errorDiv = document.getElementById(`${checkerName}-results`);
        if (errorDiv) {
          errorDiv.innerHTML = `<div class="alert alert-danger">Error: ${error.message}</div>`;
        }
        
        logDebug(`Checker Error: ${checkerName}`, {
          status: 'error',
          executionTimeMs: executionTime,
          errorMessage: error.message,
          errorStack: error.stack,
          errorType: error.name
        });
        
        checkerTimings.push({
          checker: checkerName,
          executionTimeMs: executionTime,
          status: 'error',
          errorMessage: error.message
        });
      }
    }
    
    // Calculate total execution time
    const totalExecutionTime = checkerTimings.reduce((sum, timing) => 
      sum + parseFloat(timing.executionTimeMs), 0
    ).toFixed(2);
    
    // Show completion status
    const totalRun = successCount + errorCount;
    if (elements.uploadStatus) {
      elements.uploadStatus.innerHTML = `<div class="status-message success">Check All complete: ${successCount} successful, ${errorCount} failed out of ${totalRun} checker(s)</div>`;
    }
    
    logDebug('Check All Completed', {
      totalCheckers: totalRun,
      successCount: successCount,
      errorCount: errorCount,
      totalExecutionTimeMs: totalExecutionTime,
      timestamp: new Date().toISOString()
    });
    
    logDebug('Checker Execution Timings', checkerTimings);
    
    // Enable export button if we have results
    if (successCount > 0 && elements.exportBtn) {
      elements.exportBtn.disabled = false;
      logDebug('Export Button Enabled', { resultsCount: successCount });
    }
    
    // Enable Export All button if we have results
    if (successCount > 0 && elements.exportAllBtn) {
      elements.exportAllBtn.disabled = false;
      logDebug('Export All Button Enabled', { resultsCount: successCount });
    }
    
    // Enable Export Invalids button if we have invalid rows
    if (invalidRowsData.length > 0 && elements.exportInvalidsBtn) {
      elements.exportInvalidsBtn.disabled = false;
      console.log(`[CHECK-ALL] Export Invalids button enabled (${invalidRowsData.length} invalid rows from ${successCount} checkers)`);
      logDebug('Export Invalids Button Enabled', { invalidRowsCount: invalidRowsData.length });
    } else if (elements.exportInvalidsBtn) {
      elements.exportInvalidsBtn.disabled = true;
      console.log(`[CHECK-ALL] Export Invalids button disabled (no invalid rows found)`);
    }
    
    // Store results globally for export
    window._checkAllResults = allResults;
    
    logDebug('Results Stored for Export', { 
      checkersWithResults: allResults.length,
      checkerNames: allResults.map(r => r.checkerName)
    });
    
    // Show debug log download button
    if (elements.debugLogContainer) {
      elements.debugLogContainer.style.display = 'block';
      logDebug('Debug Log Button Displayed');
    }
    
    // Hide loading overlay after all checkers complete
    hideLoadingOverlay();
    
    console.log('[CHECK-ALL] ✓ Check All functionality complete');
    console.log('[CHECK-ALL] Results collected from', allResults.length, 'checkers');
    console.log('[CHECK-ALL] Debug log contains', debugLog.length, 'entries');
  } catch (error) {
    // Catch any unexpected errors to ensure loading overlay is hidden
    console.error('[CHECK-ALL] Unexpected error in runAllCheckers:', error);
    logDebug('Check All Fatal Error', {
      errorMessage: error.message,
      errorStack: error.stack
    });
    
    // Show error message to user
    if (elements.uploadStatus) {
      elements.uploadStatus.innerHTML = `<div class="status-message error">An unexpected error occurred: ${error.message}</div>`;
    }
    
    // Show debug log button so user can download the log
    if (elements.debugLogContainer) {
      elements.debugLogContainer.style.display = 'block';
    }
    
    // Always hide loading overlay on error
    hideLoadingOverlay();
  }
  }

  function applyFilter() {
    const filterEnabled = filterActive;
    
    // Get tables from the active checker's container
    const container = document.getElementById(`checker-container-${activeChecker}`);
    if (!container) {
      console.warn('[FILTER] No active checker container found');
      return;
    }
    
    const tables = container.querySelectorAll('table');
    console.log('[FILTER] Applying filter, enabled:', filterEnabled, 'to', tables.length, 'tables');

    tables.forEach(table => {
      const rows = table.querySelectorAll('tbody tr');
      
      // Track which Claim IDs have been shown in the filtered view
      // This is used to fill the claim ID for the first invalid occurrence only
      const shownClaimIds = new Set();
      
      rows.forEach(row => {
        // Skip the "no invalids" placeholder — handled separately below
        if (row.classList.contains('no-invalids-placeholder')) return;

        if (filterEnabled) {
          // Check for invalid/error indicators based on CSS classes only
          // CSS classes are set by the checker logic based on whether remarks exist
          // 1. Bootstrap danger class (red rows - has remarks/errors)
          // 2. Bootstrap warning class (yellow rows - warnings)
          // 3. Old 'invalid' or 'unknown' class (backward compatibility for other checkers)
          const hasInvalid = row.classList.contains('table-danger') ||
                            row.classList.contains('table-warning') ||
                            row.classList.contains('invalid') ||
                            row.classList.contains('unknown');
          const hideForInvalidOnly = row.getAttribute('data-hide-invalid-only') === 'true';
          
          if (hasInvalid && !hideForInvalidOnly) {
            // Show all invalid rows
            row.style.display = '';
            
            // Get the Claim ID from this row (if it has one)
            const claimId = row.getAttribute('data-claim-id');
            
            if (claimId && !shownClaimIds.has(claimId)) {
              // First invalid occurrence of this Claim ID - ensure it's displayed
              shownClaimIds.add(claimId);
              
              const claimIdCell = row.querySelector('.claim-id-cell');
              if (claimIdCell && claimIdCell.textContent.trim() === '') {
                claimIdCell.textContent = claimId;
                claimIdCell.style.color = '#666';
                claimIdCell.style.fontStyle = 'italic';
              }
            }
            // Subsequent invalid rows with the same Claim ID keep their blank cells
          } else {
            row.style.display = 'none';
          }
        } else {
          row.style.display = '';
        }
      });

      // Show the "no invalids" placeholder row only when filtering reveals no invalid rows
      const placeholder = table.querySelector('tbody tr.no-invalids-placeholder');
      if (placeholder) {
        if (filterEnabled) {
          const hasVisibleInvalid = Array.from(
            table.querySelectorAll('tbody tr.table-danger, tbody tr.table-warning, tbody tr.invalid, tbody tr.unknown')
          ).some(r => r.style.display !== 'none');
          placeholder.style.display = hasVisibleInvalid ? 'none' : '';
        } else {
          placeholder.style.display = 'none';
        }
      }
    });

    console.log('[FILTER] Filter applied to', tables.length, 'tables');
  }

  /**
   * Clone a table and fill any blank "Claim ID" cells by propagating the last
   * non-empty value downward.  The original DOM table is never mutated.
   * @param {HTMLTableElement} table
   * @returns {HTMLTableElement}
   */
  function fillClaimIdColumn(table) {
    const clone = table.cloneNode(true);

    // Locate the "Claim ID" column index from the header row
    let claimIdColIndex = -1;
    const headerRow = clone.querySelector('thead tr');
    if (headerRow) {
      headerRow.querySelectorAll('th').forEach((th, idx) => {
        if (th.textContent.trim() === 'Claim ID') claimIdColIndex = idx;
      });
    }

    if (claimIdColIndex === -1) return clone; // no Claim ID column – nothing to do

    // Walk body rows and propagate the last seen Claim ID into blank cells
    let lastClaimId = '';
    clone.querySelectorAll('tbody tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (claimIdColIndex < cells.length) {
        const cell = cells[claimIdColIndex];
        const value = cell.textContent.trim();
        if (value) {
          lastClaimId = value;
        } else if (lastClaimId) {
          cell.textContent = lastClaimId;
        }
      }
    });

    return clone;
  }

  function exportResults() {
    // Check if this is a Check All export
    if (activeChecker === 'check-all' && window._checkAllResults && window._checkAllResults.length > 0) {
      console.log('[EXPORT] Exporting Check All results from', window._checkAllResults.length, 'checkers');
      
      const wb = XLSX.utils.book_new();
      
      window._checkAllResults.forEach((result, index) => {
        const ws = XLSX.utils.table_to_sheet(fillClaimIdColumn(result.table));
        // Limit sheet name to 31 characters (Excel limit)
        const sheetName = result.checkerName.substring(0, 31);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
      });
      
      const filename = `check-all_results_${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(wb, filename);
      console.log('[EXPORT] ✓ Check All export complete:', filename);
      return;
    }
    
    // Regular single checker export - get tables from active checker's container
    const container = document.getElementById(`checker-container-${activeChecker}`);
    if (!container) {
      alert('No active checker container found');
      return;
    }
    
    const tables = container.querySelectorAll('table');
    if (tables.length === 0) {
      alert('No results to export');
      return;
    }

    const wb = XLSX.utils.book_new();
    tables.forEach((table, index) => {
      const ws = XLSX.utils.table_to_sheet(fillClaimIdColumn(table));
      const sheetName = activeChecker ? activeChecker.substring(0, 31) : `Sheet${index + 1}`;
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    const filename = `${activeChecker || 'checker'}_results_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    console.log('[EXPORT] ✓ Single checker export complete:', filename);
  }
  
  /**
   * Export only invalid rows to Excel with one sheet per checker (matching Export All style).
   * The Claim ID (first) column is guaranteed to be non-empty in every exported row.
   */
  function exportInvalids() {
    console.log('[EXPORT-INVALIDS] Starting per-checker sheet export of invalid rows...');

    const columnsToRemove = new Set(['View Full Entry', 'Valid']);

    // Group tables by resolved checker name
    const checkerTablesMap = new Map();
    const checkerContainers = document.querySelectorAll('[id^="checker-container-"]');
    checkerContainers.forEach(container => {
      const tables = container.querySelectorAll('table');
      tables.forEach(table => {
        let checkerName = container.id.replace('checker-container-', '');

        // If in check-all container, resolve the actual checker from its section
        if (checkerName === 'check-all') {
          const parentSection = table.closest('[id$="-section"]');
          if (parentSection) {
            checkerName = parentSection.id.replace('-section', '');
          } else {
            return; // skip unresolvable tables in check-all container
          }
        }

        if (!checkerTablesMap.has(checkerName)) {
          checkerTablesMap.set(checkerName, []);
        }
        checkerTablesMap.get(checkerName).push(table);
      });
    });

    const wb = XLSX.utils.book_new();
    let totalInvalidRows = 0;

    checkerTablesMap.forEach((tables, checkerName) => {
      const sheetRows = [];
      let sheetHeaders = null;

      tables.forEach(table => {
        // Extract raw column headers
        const rawHeaders = [];
        table.querySelectorAll('thead th').forEach(th => {
          rawHeaders.push(th.textContent.trim());
        });

        // Compute display headers: remove unwanted columns, normalise Remark -> Remarks
        const displayHeaders = rawHeaders
          .filter(h => !columnsToRemove.has(h))
          .map(h => (h === 'Remark' ? 'Remarks' : h));

        if (!sheetHeaders) sheetHeaders = displayHeaders;

        // Build a claim-ID lookup for every row by scanning all tbody rows in order.
        // This ensures that when a valid row is the first row of a claim (showing the
        // claim ID in its first cell) and is followed by an invalid row (whose first
        // cell is blank), the invalid row still gets the correct claim ID.
        let lastSeenClaimId = '';
        const rowClaimIdMap = new Map();
        table.querySelectorAll('tbody tr').forEach(rowElement => {
          const dataClaim = rowElement.getAttribute('data-claim-id');
          if (dataClaim) {
            // data-claim-id attribute is present and non-empty – use it
            lastSeenClaimId = dataClaim;
          } else if (dataClaim === null) {
            // No data-claim-id attribute – fall back to first cell content
            const firstTd = rowElement.querySelector('td');
            const firstCellText = firstTd ? firstTd.textContent.trim() : '';
            if (firstCellText) lastSeenClaimId = firstCellText;
          }
          rowClaimIdMap.set(rowElement, lastSeenClaimId);
        });

        // Collect only invalid rows
        const invalidRowElements = table.querySelectorAll(
          'tbody tr.table-danger, tbody tr.table-warning, tbody tr.invalid, tbody tr.unknown'
        );

        invalidRowElements.forEach(rowElement => {
          const cells = [];
          rowElement.querySelectorAll('td').forEach(td => {
            cells.push(td.textContent.trim());
          });

          // Resolve Claim ID from the pre-built lookup (covers both data-attribute
          // and first-cell patterns, propagating across valid rows that were skipped)
          const claimId = rowClaimIdMap.get(rowElement) || '';

          const rowObj = {};
          let isFirstKeptColumn = true;

          rawHeaders.forEach((rawHeader, idx) => {
            if (columnsToRemove.has(rawHeader)) return;

            const displayHeader = rawHeader === 'Remark' ? 'Remarks' : rawHeader;
            let value = idx < cells.length ? cells[idx] : '';

            // Guarantee the first kept column (Claim ID) is never empty
            if (isFirstKeptColumn && !value) {
              value = claimId;
            }
            isFirstKeptColumn = false;

            rowObj[displayHeader] = value;
          });

          sheetRows.push(rowObj);
          totalInvalidRows++;
        });
      });

      if (sheetRows.length > 0 && sheetHeaders) {
        const ws = XLSX.utils.json_to_sheet(sheetRows, { header: sheetHeaders });
        const sheetName = checkerName.toUpperCase().substring(0, 31);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        console.log(`[EXPORT-INVALIDS] Added sheet "${sheetName}" with ${sheetRows.length} row(s)`);
      }
    });

    if (totalInvalidRows === 0) {
      alert('No invalid entries found in any tables.');
      return;
    }

    const filename = `invalid_entries_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    console.log(`[EXPORT-INVALIDS] ✓ Export complete: ${filename} (${totalInvalidRows} invalid rows)`);
  }

  /**
   * Download comprehensive debug log as text file
   */
  function downloadDebugLog() {
    console.log('[DEBUG-LOG] downloadDebugLog() function called');
    console.log('[DEBUG-LOG] Debug log array length:', debugLog ? debugLog.length : 'undefined');
    console.log('[DEBUG-LOG] Debug log contents:', debugLog);
    
    if (!debugLog || debugLog.length === 0) {
      console.error('[DEBUG-LOG] Debug log is empty or undefined');
      alert('No debug log available. Please run Check All first.');
      return;
    }
    
    console.log('[DEBUG-LOG] Preparing debug log download...');
    
    try {
      // Build debug log text content
      const logLines = [];
      
      // Header
      logLines.push('='.repeat(80));
      logLines.push('UNIFIED CHECKER TOOL - DEBUG LOG');
      logLines.push('='.repeat(80));
      logLines.push('');
      logLines.push(`Generated: ${new Date().toISOString()}`);
      logLines.push(`Total Log Entries: ${debugLog.length}`);
      logLines.push('');
      logLines.push('='.repeat(80));
      logLines.push('');
      
      // Log entries
      debugLog.forEach((entry, index) => {
        logLines.push(`[${index + 1}] ${entry.timestamp}`);
        logLines.push(`Message: ${entry.message}`);
        
        if (entry.data) {
          logLines.push('Data:');
          try {
            const dataStr = JSON.stringify(entry.data, null, 2);
            // Indent each line of data
            dataStr.split('\n').forEach(line => {
              logLines.push(`  ${line}`);
            });
          } catch (e) {
            logLines.push(`  [Error serializing data: ${e.message}]`);
          }
        }
        
        logLines.push('-'.repeat(80));
        logLines.push('');
      });
      
      // Footer
      logLines.push('='.repeat(80));
      logLines.push('END OF DEBUG LOG');
      logLines.push('='.repeat(80));
      
      console.log('[DEBUG-LOG] Generated log text, length:', logLines.join('\n').length);
      
      // Create blob and download
      const logText = logLines.join('\n');
      const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      
      const filename = `check-all_debug_log_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
      
      // Create temporary link and click it
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      
      console.log('[DEBUG-LOG] Triggering download for:', filename);
      a.click();
      
      // Clean up
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log('[DEBUG-LOG] ✓ Download triggered and cleaned up');
      }, 100);
      
      logDebug('Debug Log Downloaded', { 
        filename: filename,
        entriesCount: debugLog.length,
        logSizeBytes: logText.length
      });
    } catch (error) {
      console.error('[DEBUG-LOG] Error during download:', error);
      alert(`Error downloading debug log: ${error.message}`);
    }
  }
  
  /**
   * Copy checker invalid results to clipboard in specified format
   * Format: CLAIM_ID\t\tRemark
   * Only copies invalid/unknown rows (table-danger or table-warning)
   * @param {string} checkerName - The name of the checker (e.g., 'elig', 'auths', 'pricing')
   */
  function copyCheckerInvalidResults(checkerName) {
    console.log(`[CLIPBOARD] Copying ${checkerName.toUpperCase()} checker invalid results...`);
    
    const button = document.querySelector(`.checker-copy-button[data-checker="${checkerName}"]`);
    
    // Helper function to show button feedback (uses textContent for security)
    const showButtonFeedback = (message, backgroundColor, duration = CLIPBOARD_FEEDBACK_DURATION_MS) => {
      if (!button) return;
      const originalText = button.textContent;
      button.textContent = message;
      button.style.backgroundColor = backgroundColor;
      button.style.color = 'white';
      
      setTimeout(() => {
        button.textContent = originalText;
        button.style.backgroundColor = '';
        button.style.color = '';
      }, duration);
    };
    
    // Find the checker results section
    const checkerSection = document.getElementById(`${checkerName}-results`);
    if (!checkerSection) {
      console.error(`[CLIPBOARD] ${checkerName} results section not found`);
      showButtonFeedback('⚠ Section Not Found', '#dc3545');
      return;
    }
    
    // Find the table in the checker section
    const table = checkerSection.querySelector('table');
    if (!table) {
      console.error(`[CLIPBOARD] ${checkerName} results table not found`);
      showButtonFeedback('⚠ Table Not Found', '#dc3545');
      return;
    }
    
    // Find the Remarks column index by searching table headers
    const headers = table.querySelectorAll('thead th');
    let remarksColumnIndex = -1;
    
    // Find first header matching "Remark" or "Remarks" (exact match, case-insensitive)
    for (let i = 0; i < headers.length; i++) {
      const headerText = headers[i].textContent.trim();
      const headerLower = headerText.toLowerCase();
      // Use exact match for "remark" or "remarks" to avoid false positives
      if (headerLower === 'remark' || headerLower === 'remarks') {
        remarksColumnIndex = i;
        console.log(`[CLIPBOARD] Found remarks column at index ${i}: "${headerText}"`);
        break; // Stop after finding first match
      }
    }
    
    if (remarksColumnIndex === -1) {
      console.error(`[CLIPBOARD] Could not find Remarks column in ${checkerName} table headers`);
      showButtonFeedback('⚠ No Remarks Column', '#dc3545');
      return;
    }
    
    // Extract data from INVALID rows only (table-danger or table-warning)
    const invalidRows = table.querySelectorAll(INVALID_ROW_CLASSES);
    if (invalidRows.length === 0) {
      console.log(`[CLIPBOARD] No invalid rows found in ${checkerName}`);
      showButtonFeedback('⚠ No Invalids', '#ffc107');
      return;
    }
    
    // Use a Map to group remarks by ClaimID: key = claimID, value = Set of remark texts
    const claimRemarks = new Map();
    
    invalidRows.forEach(row => {
      // Get all cells in the row
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) return; // Skip if not enough cells
      
      // Get Claim ID from data attribute first (for checkers that hide duplicate IDs visually)
      // or fall back to first cell's textContent
      let claimID = row.getAttribute('data-claim-id') || cells[0].textContent.trim();
      
      // Skip empty claim IDs
      if (!claimID) return;
      
      if (!claimRemarks.has(claimID)) claimRemarks.set(claimID, new Set());
      const remarks = claimRemarks.get(claimID);
      
      // Get the Remarks cell using the dynamically found column index
      const remarksCell = cells[remarksColumnIndex];
      
      if (!remarksCell) return;
      
      // Get all remark divs from the cell
      const remarkDivs = remarksCell.querySelectorAll('div');
      
      // Only include rows that have remarks (not "No remarks")
      if (remarkDivs.length > 0) {
        remarkDivs.forEach(div => {
          // Replace newlines with spaces to keep everything on one line
          const remarkText = div.textContent.trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ');
          // Skip "No remarks" entries and source notes
          if (remarkText && remarkText !== 'No remarks' && !div.classList.contains('source-note')) {
            remarks.add(remarkText);
          }
        });
      } else {
        // If no divs, try getting text content directly (some checkers may use plain text)
        const remarkText = remarksCell.textContent.trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ');
        if (remarkText && remarkText !== 'No remarks' && remarkText !== '') {
          remarks.add(remarkText);
        }
      }
    });
    
    // Build one line per claim: CLAIM_ID\t\t<all remarks joined with a space>
    const results = Array.from(claimRemarks.entries())
      .filter(([, remarks]) => remarks.size > 0)
      .map(([claimID, remarks]) => `${claimID}\t\t${Array.from(remarks).join(' ')}`);
    
    if (results.length === 0) {
      console.log(`[CLIPBOARD] Invalid rows found in ${checkerName} but no remarks to copy`);
      showButtonFeedback('⚠ No Remarks', '#ffc107');
      return;
    }
    
    // Join all results with newlines
    const textToCopy = results.join('\n');
    
    // Copy to clipboard
    navigator.clipboard.writeText(textToCopy).then(() => {
      console.log(`[CLIPBOARD] ✓ Copied ${results.length} invalid ${checkerName.toUpperCase()} results`);
      showButtonFeedback(`✓ Copied ${results.length}!`, '#198754');
    }).catch(err => {
      console.error(`[CLIPBOARD] Copy failed for ${checkerName}:`, err);
      // Use a safe, fixed error message instead of potentially unsafe error content
      const safeErrorMsg = err.name === 'NotAllowedError' 
        ? 'Permission denied' 
        : err.name === 'SecurityError'
        ? 'Security error'
        : 'Check console for details';
      showButtonFeedback(`❌ Copy Failed: ${safeErrorMsg}`, '#dc3545', CLIPBOARD_FEEDBACK_DURATION_MS * ERROR_FEEDBACK_DURATION_EXTENSION_FACTOR);
    });
  }
  
  // Bug #7 fix: Auto-table generation system removed (obsolete with persistent containers)
  // Bug #8 fix: Dead code in checkForExistingTable removed (lines after early return)

})();
