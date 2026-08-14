// checker_elig.js - Claim-to-eligibility validation
//
// Matching methodology:
//   1. Collect every eligibility row from the same encounter date that
//      matches the claim by Member ID or Emirates ID. Clinician-only rows are
//      not eligible for partial-match review.
//   2. A valid candidate must match encounter date, Member ID, the required
//      clinician license, and Emirates ID when the Eligibility Excel supplies
//      one. A blank Eligibility Excel EID is accepted only through Member ID.
//      An all-zero claim EID is treated as the supported unknown-EID marker,
//      not as a missing/invalid EID. A genuinely blank claim EID remains invalid.
//   3. Clinician matching uses every GT-prefixed license found in the claim
//      when any GT license exists; otherwise it uses OrderingClinician only.
//      Performing Clinician is not used unless it is the GT override.
//   4. A same-date candidate whose actual, nonblank Emirates ID and clinician
//      match, but whose Member ID differs, is an Unknown correction case.
//   5. Complete required-field matches outrank correction and partial
//      candidates. Provider, eligibility status, and time proximity only
//      break ties.
//   6. Different-date rows are not shown as partial matches in the modal.
//   7. When no complete or Member-ID-correction match exists, every same-date
//      partial identity match produces an explicit mismatch remark.
//
// The View All modal uses delegated document-level handling and a per-run
// detail store, so it works in both the individual checker and cloned Check All
// results. It displays a Claim Match tab followed by one tab for every matched
// eligibility candidate. Each eligibility tab shows the eligibility status and
// groups the row into compact request, member, clinician, provider, card, and
// additional-information panels that wrap without horizontal scrolling.

(function eligibilityCheckerModule(root) {
  'use strict';

  const MODULE_NAME = 'Eligibility Checker';
  const ELIGIBLE_STATUS_PATTERN = /^eligible$/i;
  const DENTAL_CATEGORY_PATTERN = /dental/i;
  const PLACEHOLDER_EID_PATTERN = /^(0+|1+|2+|9+)$/;
  const UNKNOWN_EID_PATTERN = /^0+$/;

  const CHECKPOINT_PAYER_RULES = Object.freeze({
    D001: Object.freeze({ name: 'Thiqa', expectedClaimPayerIDs: ['E001'], payerNamePattern: /THIQA/i }),
    A001: Object.freeze({ name: 'Daman Enhanced', expectedClaimPayerIDs: ['A001'], payerNamePattern: /DAMAN/i }),
    D004: Object.freeze({ name: 'Daman Basic', expectedClaimPayerIDs: ['A001'], payerNamePattern: /DAMAN/i }),
    A025: Object.freeze({ name: 'NGI', expectedClaimPayerIDs: [], payerNamePattern: /(NGI|NATIONAL\s+GENERAL)/i }),
    C002: Object.freeze({ name: 'Nextcare', expectedClaimPayerIDs: [], payerNamePattern: /NEXTCARE/i })
  });
  const CHECKPOINT_OCCUPATIONAL_THERAPY_CODES = new Set(['97166', '97168', '97530', '97533', '97535', '97129']);
  const CHECKPOINT_PHYSIOTHERAPY_CODES = new Set(['97161', '97164', '97110', '97140', '97032', '97530', '97112', '97116']);
  const CHECKPOINT_SPEECH_THERAPY_CODES = new Set(['92523', '92507']);
  const CHECKPOINT_DIETICIAN_CODES = new Set(['97802', '97803']);

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

  function normalizePackageNameForComparison(value) {
    const normalized = normalizeHeader(value);

    // Thiqa eligibility exports may represent the same plan tier as either
    // "Thiqa 1" or "Thiqa C1" (likewise for other numeric tiers).
    // Treat the optional C as an export-format marker, not a package mismatch.
    const thiqaTier = normalized.match(/^thiqac?(\d+)$/);
    if (thiqaTier) return `thiqa${thiqaTier[1]}`;

    return normalized;
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

  function isUnknownEid(value) {
    const eid = normalizeEid(value);
    return eid.length >= 12 && UNKNOWN_EID_PATTERN.test(eid);
  }

  function hasAcceptableClaimEid(value) {
    return isUsableEid(value) || isUnknownEid(value);
  }

  function normalizeClinician(value) {
    return normalizeUpper(value).replace(/\s+/g, '');
  }

  function isGtClinician(value) {
    return normalizeClinician(value).startsWith('GT');
  }

  function isEligibilityEidBlank(row) {
    return normalizeText(row?.eidRaw) === '';
  }

  function getRequiredClinicians(performingClinicians, orderingClinicians) {
    const performing = performingClinicians instanceof Set
      ? performingClinicians
      : new Set(performingClinicians || []);
    const ordering = orderingClinicians instanceof Set
      ? orderingClinicians
      : new Set(orderingClinicians || []);

    const gtClinicians = new Set(
      [...performing, ...ordering].filter(isGtClinician)
    );

    return {
      gtClinicians,
      requiredClinicians: gtClinicians.size
        ? gtClinicians
        : new Set(ordering),
      clinicianMatchRule: gtClinicians.size
        ? 'GT override'
        : 'Ordering Clinician'
    };
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

  function getXmlParserError(xmlDocument) {
    const parserError = xmlDocument?.getElementsByTagName?.('parsererror')?.[0];
    return parserError ? normalizeText(parserError.textContent) : '';
  }

  function repairMalformedXmlText(xmlText) {
    const source = String(xmlText == null ? '' : xmlText)
      .replace(/^\uFEFF/, '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

    // A raw ampersand is illegal in XML text and attributes. Preserve the five
    // built-in XML entities and numeric entities. Comments and CDATA sections
    // are left untouched because ampersands are valid inside them.
    return source.replace(
      /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[0-9A-Fa-f]+);)/g,
      token => token.startsWith('<') ? token : '&amp;'
    );
  }

  function parseXmlDocument(xmlText) {
    const source = String(xmlText == null ? '' : xmlText);
    let xmlDocument = new DOMParser().parseFromString(source, 'application/xml');
    const originalError = getXmlParserError(xmlDocument);

    if (!originalError) return xmlDocument;

    const repairedSource = repairMalformedXmlText(source);
    if (repairedSource !== source) {
      xmlDocument = new DOMParser().parseFromString(repairedSource, 'application/xml');
      const repairedError = getXmlParserError(xmlDocument);

      if (!repairedError) {
        console.warn(
          '[Eligibility Checker] The XML contained an unescaped ampersand or invalid control character. ' +
          'It was repaired in memory before parsing.',
          originalError
        );
        return xmlDocument;
      }

      throw new Error(`XML parsing failed after automatic repair: ${repairedError}`);
    }

    throw new Error(`XML parsing failed: ${originalError}`);
  }

  function getSubmissionReceiverID(xmlText) {
    const xmlDocument = parseXmlDocument(xmlText);
    const header = xmlDocument.getElementsByTagName('Header')[0] || null;
    return normalizeUpper(
      getDirectText(header, 'ReceiverID') || getNestedText(header, 'ReceiverID')
    );
  }

  function parseXMLClaims(xmlText) {
    const xmlDocument = parseXmlDocument(xmlText);
    const header = xmlDocument.getElementsByTagName('Header')[0] || null;
    const receiverID = normalizeUpper(getDirectText(header, 'ReceiverID') || getNestedText(header, 'ReceiverID'));

    const claims = Array.from(xmlDocument.getElementsByTagName('Claim'));
    if (!claims.length) throw new Error('The XML contains no Claim entries.');

    return claims.map((claim, claimIndex) => {
      const encounter = claim.getElementsByTagName('Encounter')[0] || null;
      const encounterStartRaw = getNestedText(encounter, 'Start');
      const encounterStart = parseDateTime(encounterStartRaw);
      const activities = Array.from(claim.getElementsByTagName('Activity'));
      const activityCodes = new Set(
        activities.map(activity => normalizeUpper(getNestedText(activity, 'Code'))).filter(Boolean)
      );
      const contract = claim.getElementsByTagName('Contract')[0] || null;
      const packageName = getNestedText(contract, 'PackageName');
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

      const {
        gtClinicians,
        requiredClinicians,
        clinicianMatchRule
      } = getRequiredClinicians(performingClinicians, orderingClinicians);

      const activityTypes = new Set(
        activities.map(activity => normalizeText(getNestedText(activity, 'Type'))).filter(Boolean)
      );
      const isDental = activityTypes.has('6');

      return {
        claimIndex,
        claimID: getDirectText(claim, 'ID') || `Claim ${claimIndex + 1}`,
        receiverID,
        payerIDRaw: getDirectText(claim, 'PayerID'),
        payerID: normalizeUpper(getDirectText(claim, 'PayerID')),
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
        gtClinicians,
        requiredClinicians,
        clinicianMatchRule,
        isDental,
        activityCodes,
        packageName,
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
    const date = new Map();
    const eid = new Map();
    const member = new Map();
    const eidDate = new Map();
    const memberDate = new Map();

    rows.forEach(row => {
      if (row.orderedDate) addToIndex(date, row.orderedDate, row);
      if (row.eid) addToIndex(eid, row.eid, row);
      if (row.memberID) addToIndex(member, row.memberID, row);
      if (row.eid && row.orderedDate) addToIndex(eidDate, `${row.eid}|${row.orderedDate}`, row);
      if (row.memberID && row.orderedDate) {
        addToIndex(memberDate, `${row.memberID}|${row.orderedDate}`, row);
      }
    });

    return { date, eid, member, eidDate, memberDate };
  }

  function scoreCandidate(claim, row, basis) {
    const comparison = buildCandidateComparison(claim, row);
    const matchedFieldCount = [
      comparison.orderedOn,
      comparison.memberId,
      comparison.eid,
      comparison.clinician
    ].filter(Boolean).length;
    const completeMatch = matchedFieldCount === 4;

    // Complete required-field matches must always outrank partial candidates.
    // The remaining score only determines which complete match is selected
    // when more than one eligibility satisfies every required condition.
    let score = completeMatch ? 1000000 : 0;

    if (comparison.orderedOn) score += 10000;
    if (comparison.memberId) score += 10000;
    if (comparison.eid) score += 10000;
    if (comparison.clinician) score += 10000;

    if (basis === 'EID') score += 1000;
    if (claim.providerID && row.providerLicense === claim.providerID) score += 300;
    if (ELIGIBLE_STATUS_PATTERN.test(row.status)) score += 150;

    let minutesDifference = null;
    if (claim.encounterTimestamp != null && row.orderedTimestamp != null) {
      minutesDifference = Math.abs(claim.encounterTimestamp - row.orderedTimestamp) / 60000;
      score += Math.max(0, 90 - Math.min(90, minutesDifference));
    }

    return {
      score,
      minutesDifference,
      comparison,
      matchedFieldCount,
      completeMatch
    };
  }

  function isMemberIdCorrectionCandidate(claim, candidate) {
    const row = candidate?.row;
    const comparison = candidate?.comparison || buildCandidateComparison(claim, row);
    const hasActualMatchingEid = Boolean(
      !isEligibilityEidBlank(row) &&
      isUsableEid(claim?.eid) &&
      isUsableEid(row?.eid) &&
      claim.eid === row.eid
    );

    return Boolean(
      comparison.orderedOn &&
      hasActualMatchingEid &&
      comparison.clinician &&
      !comparison.memberId &&
      row?.memberID
    );
  }

  function buildWrongMemberIdRemark(candidate) {
    const expectedMemberID =
      candidate?.row?.memberIDRaw ||
      candidate?.row?.memberID ||
      '(blank)';

    return `Wrong Member ID (should be ${expectedMemberID}).`;
  }

  function findBestEligibilityMatch(claim, indexes) {
    const candidateMap = new Map();

    function registerCandidate(row, bases) {
      if (!row) return;

      const normalizedBases = Array.from(new Set((bases || []).filter(Boolean)));
      if (!normalizedBases.length) return;

      let entry = candidateMap.get(row);
      if (!entry) {
        entry = { row, bases: new Set() };
        candidateMap.set(row, entry);
      }

      normalizedBases.forEach(basis => entry.bases.add(basis));
    }

    /*
     * A partial eligibility candidate is only useful for this modal when it is
     * from the claim's encounter date and matches at least one patient identity
     * field: Member ID or an actual nonblank Emirates ID. A blank Eligibility
     * Excel EID can satisfy the final EID condition only after Member ID locates
     * the row; it cannot qualify a row by itself. Clinician-only matches remain
     * excluded because they may belong to another patient seen on the same date.
     */
    const sameDateRows = claim.encounterDate
      ? (indexes.date?.get(claim.encounterDate) || [])
      : [];

    sameDateRows.forEach(row => {
      const bases = [];

      if (
        claim.memberID &&
        row.memberID &&
        row.memberID === claim.memberID
      ) {
        bases.push('Member ID');
      }

      if (
        isUsableEid(claim.eid) &&
        isUsableEid(row.eid) &&
        row.eid === claim.eid
      ) {
        bases.push('EID');
      }

      // Clinician is still compared and highlighted inside the modal, but it
      // cannot qualify a row as a partial candidate by itself. At least the
      // Member ID or Emirates ID must match before the row is registered.
      registerCandidate(row, bases);
    });

    if (!candidateMap.size) {
      return {
        row: null,
        basis: '',
        candidateCount: 0,
        minutesDifference: null,
        candidates: [],
        selectedComparison: null,
        completeMatch: false,
        selectedRow: null
      };
    }

    // Keep candidates in workbook order for sequential modal tabs. Selection
    // is calculated separately, so a valid candidate can remain Eligibility 2,
    // Eligibility 3, etc. instead of being moved into the first tab.
    const candidates = Array.from(candidateMap.values()).map(entry => {
      const bases = Array.from(entry.bases);
      const basis = bases.includes('EID') ? 'EID' : 'Member ID';

      return {
        row: entry.row,
        basis,
        bases,
        selected: false,
        ...scoreCandidate(claim, entry.row, basis)
      };
    });

    const rankedForReview = candidates
      .slice()
      .sort((a, b) => {
        if (a.completeMatch !== b.completeMatch) return a.completeMatch ? -1 : 1;
        if (b.matchedFieldCount !== a.matchedFieldCount) {
          return b.matchedFieldCount - a.matchedFieldCount;
        }
        if (b.score !== a.score) return b.score - a.score;
        const aTime = a.minutesDifference == null
          ? Number.POSITIVE_INFINITY
          : a.minutesDifference;
        const bTime = b.minutesDifference == null
          ? Number.POSITIVE_INFINITY
          : b.minutesDifference;
        if (aTime !== bTime) return aTime - bTime;
        return b.row.sheetRowNumber - a.row.sheetRowNumber;
      });

    const selectedEntry = rankedForReview.find(candidate => candidate.completeMatch) || null;
    const memberIdCorrectionEntry = selectedEntry
      ? null
      : rankedForReview.find(candidate => isMemberIdCorrectionCandidate(claim, candidate)) || null;
    const reviewEntry = selectedEntry || memberIdCorrectionEntry || rankedForReview[0];

    // Only a complete required-field match receives the Selected badge. A
    // Member ID correction candidate remains unselected and produces Unknown.
    if (selectedEntry) selectedEntry.selected = true;
    if (memberIdCorrectionEntry) memberIdCorrectionEntry.memberIdCorrection = true;

    return {
      row: reviewEntry.row,
      selectedRow: selectedEntry?.row || null,
      memberIdCorrectionRow: memberIdCorrectionEntry?.row || null,
      memberIdCorrectionCandidate: memberIdCorrectionEntry || null,
      basis: reviewEntry.basis,
      candidateCount: candidates.length,
      minutesDifference: reviewEntry.minutesDifference,
      candidates,
      selectedComparison: reviewEntry.comparison,
      completeMatch: Boolean(selectedEntry),
      memberIdCorrection: Boolean(memberIdCorrectionEntry)
    };
  }

  function buildEligibilityNotFoundRemark(claim) {
    const memberID = claim?.memberIDRaw || claim?.memberID || '(blank)';
    const claimDate = claim?.encounterDate || claim?.encounterStartRaw || '(unknown date)';
    const clinicians = Array.from(claim?.requiredClinicians || []);
    const clinicianID = clinicians.length ? clinicians.join(', ') : '(blank)';

    return `Eligibility for ${memberID} cannot be found on ${claimDate} for ${clinicianID}.`;
  }

  function validateCheckpointPayerPlanAndTherapy(claim, validationRow, invalidRemarks, unknownRemarks) {
    const receiverID = normalizeUpper(claim?.receiverID);
    const payerRule = CHECKPOINT_PAYER_RULES[receiverID] || null;

    if (payerRule) {
      const expectedPayers = Array.isArray(payerRule.expectedClaimPayerIDs)
        ? payerRule.expectedClaimPayerIDs.map(normalizeUpper)
        : [];
      if (expectedPayers.length && !expectedPayers.includes(normalizeUpper(claim?.payerID))) {
        invalidRemarks.push(
          `Claim PayerID ${claim?.payerIDRaw || '(blank)'} does not match ReceiverID ${receiverID}; ` +
          `expected ${expectedPayers.join(' or ')}.`
        );
      }

      if (validationRow) {
        const eligibilityPayerName = normalizeText(validationRow.payerName);
        if (!eligibilityPayerName) {
          unknownRemarks.push(`Eligibility Payer Name is blank, so ${payerRule.name} payer consistency could not be verified.`);
        } else if (payerRule.payerNamePattern && !payerRule.payerNamePattern.test(eligibilityPayerName)) {
          invalidRemarks.push(
            `Eligibility Payer Name \`${eligibilityPayerName}\` does not match ReceiverID ${receiverID} (${payerRule.name}).`
          );
        }
      }
    }

    if (validationRow && claim?.packageName) {
      const eligibilityPackage = normalizeText(validationRow.packageName);
      if (!eligibilityPackage) {
        unknownRemarks.push(
          `Claim Contract PackageName \`${claim.packageName}\` is present but Eligibility Package Name is blank.`
        );
      } else if (normalizePackageNameForComparison(claim.packageName) !== normalizePackageNameForComparison(eligibilityPackage)) {
        invalidRemarks.push(
          `Claim Contract PackageName \`${claim.packageName}\` does not match Eligibility Package Name \`${eligibilityPackage}\`.`
        );
      }
    }

    if (!validationRow) return;

    const codes = claim?.activityCodes instanceof Set ? claim.activityCodes : new Set();
    const serviceCategory = normalizeText(validationRow.serviceCategory);
    const categoryChecks = [];

    if ([...codes].some(code => CHECKPOINT_SPEECH_THERAPY_CODES.has(code))) {
      categoryChecks.push({ label: 'Speech Therapy', pattern: /speech/i });
    }
    if ([...codes].some(code => CHECKPOINT_DIETICIAN_CODES.has(code))) {
      categoryChecks.push({ label: 'Dietician/Nutrition', pattern: /(diet|nutrition)/i });
    }
    if ([...codes].some(code => CHECKPOINT_OCCUPATIONAL_THERAPY_CODES.has(code) && code !== '97530')) {
      categoryChecks.push({ label: 'Occupational Therapy', pattern: /occupational/i });
    }
    if ([...codes].some(code => CHECKPOINT_PHYSIOTHERAPY_CODES.has(code) && code !== '97530')) {
      categoryChecks.push({ label: 'Physiotherapy', pattern: /(physio|physical)/i });
    }
    if (codes.has('97530')) {
      categoryChecks.push({ label: 'Therapy (97530)', pattern: /(physio|physical|occupational)/i });
    }

    if (categoryChecks.length) {
      if (!serviceCategory) {
        unknownRemarks.push(
          `Eligibility Service Category is blank, so ${categoryChecks.map(check => check.label).join(', ')} coverage could not be verified.`
        );
      } else {
        categoryChecks.forEach(check => {
          if (!check.pattern.test(serviceCategory)) {
            invalidRemarks.push(
              `${check.label} activity matched Eligibility Service Category \`${serviceCategory}\`, which does not match the required therapy category.`
            );
          }
        });
      }
    }
  }

  function analyzeClaim(claim, match) {
    const matchedRow = match.row;
    const selectedRow = match.selectedRow || null;
    const memberIdCorrectionCandidate = match.memberIdCorrectionCandidate || null;
    const memberIdCorrectionRow = match.memberIdCorrectionRow || null;
    const validationRow = selectedRow || memberIdCorrectionRow || null;
    const invalidRemarks = [];
    const unknownRemarks = [];
    const notes = [];

    if (!claim.encounterDate) {
      invalidRemarks.push('Encounter Start is missing or has an invalid date.');
    }

    if (!hasAcceptableClaimEid(claim.eid)) {
      invalidRemarks.push('Emirates ID is missing or invalid.');
    }

    if (!matchedRow) {
      invalidRemarks.push(buildEligibilityNotFoundRemark(claim));
    } else if (!match.completeMatch && memberIdCorrectionCandidate) {
      unknownRemarks.push(buildWrongMemberIdRemark(memberIdCorrectionCandidate));
      notes.push(
        `Eligibility ${memberIdCorrectionRow?.requestNumber || '(unknown)'} matched ` +
        'encounter date, a nonblank Emirates ID, and the required clinician. ' +
        'It was not selected because the Member ID differs.'
      );

      if (match.candidateCount > 1) {
        notes.push(
          `${match.candidateCount} same-date eligibility candidates were found. ` +
          'Review every candidate in View All.'
        );
      }
    } else if (!match.completeMatch) {
      // Keep every same-date identity partial visible in View All, but emit only
      // one compact claim-level error instead of repeating every candidate and
      // every mismatched field in the results table and clipboard export.
      invalidRemarks.push(buildEligibilityNotFoundRemark(claim));

      notes.push(
        `${match.candidateCount} same-date partial eligibility ` +
        `candidate${match.candidateCount === 1 ? '' : 's'} found. ` +
        `No eligibility was selected; review every candidate in View All.`
      );
    }

    /*
     * Eligibility status and service-category checks apply to either the full
     * selected match or the three-field Member ID correction candidate. The
     * latter is Unknown only when Member ID is the sole remaining problem.
     */
    if (validationRow) {
      if (!ELIGIBLE_STATUS_PATTERN.test(validationRow.status)) {
        invalidRemarks.push(
          `Eligibility status is ${validationRow.status || '(blank)'} instead of Eligible.`
        );
      }

      validateCheckpointPayerPlanAndTherapy(claim, validationRow, invalidRemarks, unknownRemarks);

      if (
        claim.isDental &&
        validationRow.serviceCategory &&
        !DENTAL_CATEGORY_PATTERN.test(validationRow.serviceCategory)
      ) {
        invalidRemarks.push(
          `Dental claim matched eligibility Service Category ` +
          `\`${validationRow.serviceCategory}\` instead of Dental Services.`
        );
      }

      if (
        claim.providerID &&
        validationRow.providerLicense &&
        claim.providerID !== validationRow.providerLicense
      ) {
        notes.push(
          `Provider differs: claim ${claim.providerIDRaw}, ` +
          `eligibility ${validationRow.providerLicenseRaw}.`
        );
      }

      if (selectedRow && match.candidateCount > 1) {
        notes.push(
          `${match.candidateCount} eligibility candidates were found; ` +
          `the candidate matching date, Member ID, the EID rule, and the required clinician was selected.`
        );
      }
    }

    if (!validationRow) {
      validateCheckpointPayerPlanAndTherapy(claim, null, invalidRemarks, unknownRemarks);
    }

    const status = invalidRemarks.length
      ? 'Invalid'
      : unknownRemarks.length
        ? 'Unknown'
        : 'Valid';

    return {
      ClaimID: claim.claimID,
      PayerID: claim.payerIDRaw,
      ReceiverID: claim.receiverID,
      ClaimPackageName: claim.packageName || '',
      EligibilityPayerName: matchedRow?.payerName || '',
      EligibilityPackageName: matchedRow?.packageName || '',
      MemberID: claim.memberIDRaw,
      EmiratesID: claim.eidRaw,
      EncounterStart: claim.encounterStartRaw,
      EncounterDate: claim.encounterDate,
      ClaimClinicians: Array.from(claim.requiredClinicians || []).join(', '),
      ProviderID: claim.providerIDRaw,
      MatchBasis: match.basis || '',
      RequiredMatchComplete: match.completeMatch === true,
      MemberIdCorrection: match.memberIdCorrection === true,
      Status: status,
      Remarks: [...invalidRemarks, ...unknownRemarks].join('\n') || 'OK',
      Notes: notes.join('\n'),
      EligibilityRequestNumber: matchedRow?.requestNumber || '',
      SelectedEligibilityRequestNumber: selectedRow?.requestNumber || '',
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
      EligibilityCandidates: Array.isArray(match.candidates) ? match.candidates : [],
      ClaimContext: claim,
      Valid: status === 'Valid'
    };
  }

  function clearDetailStoreForRun() {
    detailRunCounter += 1;
    detailStore.clear();
    return `elig-${Date.now()}-${detailRunCounter}`;
  }

  function buildCandidateComparison(claim, row) {
    const requiredClinicians = claim?.requiredClinicians instanceof Set
      ? claim.requiredClinicians
      : new Set();
    const eligibilityEidBlank = isEligibilityEidBlank(row);
    const actualEidMatch = Boolean(
      isUsableEid(claim?.eid) &&
      isUsableEid(row?.eid) &&
      claim.eid === row.eid
    );
    const blankEligibilityEidAccepted = Boolean(
      eligibilityEidBlank &&
      hasAcceptableClaimEid(claim?.eid)
    );

    return {
      orderedOn: Boolean(
        claim?.encounterDate &&
        row?.orderedDate &&
        claim.encounterDate === row.orderedDate
      ),
      memberId: Boolean(
        claim?.memberID &&
        row?.memberID &&
        claim.memberID === row.memberID
      ),
      eid: Boolean(
        blankEligibilityEidAccepted || actualEidMatch
      ),
      clinician: Boolean(
        row?.clinician &&
        requiredClinicians.size &&
        requiredClinicians.has(row.clinician)
      ),
      eidBlankAccepted: blankEligibilityEidAccepted,
      unknownClaimEidAccepted: Boolean(
        blankEligibilityEidAccepted &&
        isUnknownEid(claim?.eid)
      )
    };
  }

  function registerDetail(runId, result, index) {
    const detailId = `${runId}-${index}`;
    const claimContext = result.ClaimContext;

    const candidates = (result.EligibilityCandidates || []).map((candidate, candidateIndex) => ({
      index: candidateIndex,
      selected: candidate.selected === true,
      memberIdCorrection: candidate.memberIdCorrection === true,
      completeMatch: candidate.completeMatch === true,
      basis: candidate.basis || '',
      bases: Array.isArray(candidate.bases) ? candidate.bases.slice() : [],
      score: candidate.score,
      minutesDifference: candidate.minutesDifference,
      sheetName: candidate.row?.sheetName || '',
      sheetRowNumber: candidate.row?.sheetRowNumber || '',
      requestNumber: candidate.row?.requestNumber || '',
      status: candidate.row?.status || '',
      orderedOnDisplay: candidate.row?.orderedOnDisplay || '',
      memberName: candidate.row?.memberName || '',
      clinicianRaw: candidate.row?.clinicianRaw || '',
      clinicianName: candidate.row?.clinicianName || '',
      row: candidate.row?.sourceRow || null,
      comparison: candidate.comparison || buildCandidateComparison(claimContext, candidate.row)
    }));

    detailStore.set(detailId, {
      claim: {
        'Claim ID': result.ClaimID,
        'Payer ID': result.PayerID,
        'Member ID': result.MemberID,
        'Emirates ID': result.EmiratesID,
        'Encounter Start': result.EncounterStart,
        'Performing Clinicians': Array.from(claimContext?.performingClinicians || []).join(', '),
        'Ordering Clinicians': Array.from(claimContext?.orderingClinicians || []).join(', '),
        'GT Clinicians': Array.from(claimContext?.gtClinicians || []).join(', '),
        'Required Eligibility Clinicians': Array.from(claimContext?.requiredClinicians || []).join(', '),
        'Clinician Match Rule': claimContext?.clinicianMatchRule || '',
        'Provider ID': result.ProviderID,
        'Selected Match Basis': result.MatchBasis,
        'Selected Eligibility Request': result.RequiredMatchComplete
          ? result.EligibilityRequestNumber
          : '(none - no complete four-field match)',
        'Member ID Correction Candidate': result.MemberIdCorrection
          ? result.EligibilityRequestNumber
          : '',
        'Closest Review Candidate': result.RequiredMatchComplete || result.MemberIdCorrection
          ? ''
          : result.EligibilityRequestNumber,
        'Four Required Fields Match': result.RequiredMatchComplete ? 'Yes' : 'No',
        Status: result.Status,
        Remarks: result.Remarks,
        Notes: result.Notes
      },
      claimContext,
      candidates
    });
    return detailId;
  }

  function createResultsWrapper(results, context) {
    const wrapper = document.createElement('div');
    wrapper.className = 'elig-checker-results';

    const total = results.length;
    const valid = results.filter(result => result.Status === 'Valid').length;
    const unknown = results.filter(result => result.Status === 'Unknown').length;
    const invalid = results.filter(result => result.Status === 'Invalid').length;
    const percentage = total ? ((valid / total) * 100).toFixed(1) : '100.0';

    const summary = document.createElement('div');
    summary.className = 'alert alert-info';
    summary.innerHTML =
      `<strong>Eligibility results:</strong> ${valid} valid / ${total} total ` +
      `(${percentage}%). ${unknown} unknown, ${invalid} invalid.`;
    wrapper.appendChild(summary);

    if (context.warnings?.length) {
      const warning = document.createElement('div');
      warning.className = 'alert alert-warning';
      warning.textContent = context.warnings.join(' ');
      wrapper.appendChild(warning);
    }

    const tableStyle = document.createElement('style');
    tableStyle.textContent = `
      .elig-checker-results .eligibility-results-container {
        width: 100%;
        max-width: 100%;
        overflow-x: hidden;
      }
      .elig-checker-results .eligibility-results-table {
        width: 100% !important;
        max-width: 100% !important;
        min-width: 0 !important;
        table-layout: fixed !important;
        font-size: clamp(9px, 0.72vw, 12px);
        margin-bottom: 0;
      }
      .elig-checker-results .eligibility-results-table th,
      .elig-checker-results .eligibility-results-table td {
        min-width: 0 !important;
        max-width: none !important;
        padding: 5px 4px !important;
        white-space: normal !important;
        overflow-wrap: anywhere;
        word-break: break-word;
        vertical-align: top;
        line-height: 1.25;
      }
      .elig-checker-results .eligibility-results-table th {
        text-align: center;
        vertical-align: middle;
      }
      .elig-checker-results .eligibility-results-table .claim-id-cell {
        white-space: normal !important;
      }
      .elig-checker-results .eligibility-results-table .eligibility-action-cell {
        text-align: center;
        vertical-align: middle;
      }
      .elig-checker-results .eligibility-results-table .eligibility-details {
        display: inline-block;
        width: 100%;
        max-width: 88px;
        padding: 4px 3px;
        font-size: inherit;
        line-height: 1.2;
        white-space: normal;
      }
      @media (max-width: 1000px) {
        .elig-checker-results .eligibility-results-table {
          font-size: 9px;
        }
        .elig-checker-results .eligibility-results-table th,
        .elig-checker-results .eligibility-results-table td {
          padding: 4px 2px !important;
        }
      }
    `;
    wrapper.appendChild(tableStyle);

    const responsive = document.createElement('div');
    responsive.className = 'eligibility-results-container';

    const table = document.createElement('table');
    table.className =
      'table table-bordered table-striped checker-table result-table eligibility-results-table';
    table.innerHTML = `
      <colgroup>
        <col style="width:8%">
        <col style="width:4%">
        <col style="width:7%">
        <col style="width:9%">
        <col style="width:8%">
        <col style="width:7%">
        <col style="width:10%">
        <col style="width:8%">
        <col style="width:7%">
        <col style="width:7%">
        <col style="width:5%">
        <col style="width:13%">
        <col style="width:7%">
      </colgroup>
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Payer</th>
          <th>Member ID</th>
          <th>EID</th>
          <th>Encounter</th>
          <th>Claim Clinician</th>
          <th>Eligibility Matches</th>
          <th>Ordered On</th>
          <th>Elig Clinician</th>
          <th>Service</th>
          <th>Status</th>
          <th>Remarks</th>
          <th>Eligibility</th>
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
        : result.Status === 'Unknown'
          ? 'table-warning unknown-row unknown'
          : 'table-danger invalid-row invalid';
      row.dataset.claimId = result.ClaimID || '';
      row.dataset.status = result.Status.toLowerCase();

      const detailId = result.EligibilityRow ? registerDetail(runId, result, index) : '';
      const eligibilityCount = Array.isArray(result.EligibilityCandidates) && result.EligibilityCandidates.length
        ? result.EligibilityCandidates.length
        : result.EligibilityRow
          ? 1
          : 0;
      const detailButtonLabel = eligibilityCount === 1
        ? 'View Elig'
        : `View All (${eligibilityCount})`;
      const detailButton = detailId
        ? `<button type="button" class="details-btn eligibility-details" ` +
          `data-eligibility-detail-id="${escapeHtml(detailId)}">${escapeHtml(detailButtonLabel)}</button>`
        : '';

      row.innerHTML = `
        <td class="nowrap-col claim-id-cell">${escapeHtml(result.ClaimID)}</td>
        <td>${escapeHtml(result.PayerID)}</td>
        <td>${escapeHtml(result.MemberID)}</td>
        <td>${escapeHtml(result.EmiratesID)}</td>
        <td>${escapeHtml(result.EncounterStart)}</td>
        <td>${escapeHtml(result.ClaimClinicians)}</td>
        <td style="white-space:pre-line">${escapeHtml(
          result.SelectedEligibilityRequestNumber || '(none)'
        )}</td>
        <td>${escapeHtml(result.EligibilityOrderedOn)}</td>
        <td>${escapeHtml(result.EligibilityClinician)}</td>
        <td>${escapeHtml(result.ServiceCategory)}</td>
        <td>${escapeHtml(result.Status)}</td>
        <td style="white-space:pre-line">${escapeHtml(result.Remarks)}</td>
        <td class="eligibility-action-cell">${detailButton}</td>
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

  function createSkippedWrapper(receiverID) {
    const wrapper = document.createElement('div');
    wrapper.className = 'elig-checker-results elig-checker-skipped';
    wrapper.dataset.checkerSkipped = 'true';
    wrapper.dataset.receiverId = receiverID || '';

    const alert = document.createElement('div');
    alert.className = 'alert alert-info';
    alert.textContent =
      `Eligibility Checker skipped: ReceiverID ${receiverID || 'HAAD'} is excluded from eligibility validation.`;
    wrapper.appendChild(alert);

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

  function resolveEligibilityComparisonField(header) {
    const baseHeader = String(header || '').replace(/\s*\(\d+\)\s*$/, '');
    const normalized = normalizeHeader(baseHeader);

    const comparisonFields = [
      ['orderedOn', HEADER_ALIASES.orderedOn],
      ['memberId', HEADER_ALIASES.memberId],
      ['eid', HEADER_ALIASES.eid],
      ['clinician', HEADER_ALIASES.clinician]
    ];

    for (const [field, aliases] of comparisonFields) {
      if (aliases.some(alias => normalizeHeader(alias) === normalized)) {
        return field;
      }
    }

    return '';
  }

  function comparisonLabel(field) {
    return {
      orderedOn: 'Encounter date',
      memberId: 'Member ID',
      eid: 'Emirates ID',
      clinician: 'Clinician license'
    }[field] || 'Value';
  }

  function comparisonClaimValue(field, claim) {
    if (!claim) return '';

    return {
      orderedOn: claim.encounterStartRaw || claim.encounterDate || '',
      memberId: claim.memberIDRaw || '',
      eid: claim.eidRaw || '',
      clinician: Array.from(claim.requiredClinicians || []).join(', ')
    }[field] || '';
  }

  function splitNumberedEligibilityHeader(header) {
    const raw = normalizeText(header);
    const match = raw.match(/^(.*?)(?:\s*\((\d+)\))?$/);
    return {
      original: raw,
      base: normalizeText(match?.[1] || raw),
      groupNumber: Number(match?.[2] || 1)
    };
  }

  function normalizedHeaderMatches(baseHeader, aliases) {
    const normalized = normalizeHeader(baseHeader);
    return aliases.some(alias => normalizeHeader(alias) === normalized);
  }

  const MEMBER_MODAL_HEADERS = Object.freeze([
    'Payer Name',
    'Payer',
    'Member Name',
    'Patient Name',
    'Card Number / DHA Member ID',
    'DHA Member ID',
    'Member ID',
    'MemberID',
    'EID',
    'Emirates ID',
    'EmiratesID',
    'Emirates ID Number',
    'EmiratesIDNumber',
    'Mobile Number',
    'Submitted via Emirates Id',
    'Submitted via Emirates ID',
    'Read By Card Reader',
    'Has Multiple Policy'
  ]);

  const CLINICIAN_MODAL_HEADERS = Object.freeze([
    ...HEADER_ALIASES.clinician,
    ...HEADER_ALIASES.clinicianName,
    'Reffering Clinician',
    'Referring Clinician',
    'Refferal Clinician',
    'Referral Clinician',
    'Refferal Letter Reference No',
    'Referral Letter Reference No',
    'User Name'
  ]);

  const PROVIDER_MODAL_HEADERS = Object.freeze([
    ...HEADER_ALIASES.providerLicense,
    ...HEADER_ALIASES.providerName,
    ...HEADER_ALIASES.serviceCategory,
    ...HEADER_ALIASES.consultationStatus
  ]);

  const REQUEST_MODAL_HEADERS = Object.freeze([
    ...HEADER_ALIASES.transactionId,
    ...HEADER_ALIASES.requestNumber,
    ...HEADER_ALIASES.orderedOn,
    ...HEADER_ALIASES.answeredOn,
    ...HEADER_ALIASES.authorizationNumber,
    ...HEADER_ALIASES.status,
    ...HEADER_ALIASES.denialCode,
    ...HEADER_ALIASES.denialDescription,
    ...HEADER_ALIASES.voiNumber,
    ...HEADER_ALIASES.voiMessage,
    'Rule Ansswered',
    'Rule Answered',
    'Question',
    'Answer'
  ]);

  const CARD_MODAL_HEADERS = Object.freeze([
    'Card Number',
    'PolicyId',
    'Policy ID',
    'PolicyName',
    'Policy Name',
    'EffectiveDate',
    'Effective Date',
    'ExpiryDate',
    'Expiry Date',
    ...HEADER_ALIASES.packageName,
    ...HEADER_ALIASES.cardNetwork,
    'Network Billing Reference'
  ]);

  function eligibilityStatusStyle(status) {
    const normalized = normalizeUpper(status);

    if (ELIGIBLE_STATUS_PATTERN.test(normalized)) {
      return { background: '#198754', color: '#fff', classification: 'usable' };
    }

    if (
      /CANCEL|INELIGIBLE|DENIED|REJECT|EXPIRED|TERMINAT|INVALID|NOT\s*ELIGIBLE/.test(normalized)
    ) {
      return { background: '#dc3545', color: '#fff', classification: 'unusable' };
    }

    if (/PENDING|PROCESS|REVIEW|UNKNOWN|PARTIAL|WAIT/.test(normalized)) {
      return { background: '#ffc107', color: '#212529', classification: 'review' };
    }

    return { background: '#6c757d', color: '#fff', classification: 'unknown' };
  }

  function eligibilityStatusBadge(status, compact = false) {
    const display = normalizeText(status) || 'Status unavailable';
    const style = eligibilityStatusStyle(display);
    const verticalPadding = compact ? '1px' : '2px';
    const horizontalPadding = compact ? '7px' : '9px';
    const fontSize = compact ? '10px' : '11px';

    return `
      <span
        title="Eligibility status: ${escapeHtml(display)}"
        data-eligibility-status-classification="${escapeHtml(style.classification)}"
        style="display:inline-block;background:${style.background};color:${style.color};border-radius:999px;padding:${verticalPadding} ${horizontalPadding};font-size:${fontSize};font-weight:700;white-space:nowrap;"
      >
        ${escapeHtml(display)}
      </span>
    `;
  }

  function buildEligibilityFieldEntry(key, value) {
    const header = splitNumberedEligibilityHeader(key);
    let displayValue = value;
    if (value instanceof Date) displayValue = formatDateTime(value);
    else if (value && typeof value === 'object') displayValue = JSON.stringify(value);

    return {
      key: header.original,
      baseKey: header.base,
      groupNumber: header.groupNumber,
      value,
      displayValue
    };
  }

  function classifyEligibilityFields(candidate) {
    const source = candidate?.row;
    const groups = {
      request: [],
      member: [],
      clinician: [],
      provider: [],
      cards: new Map(),
      additional: []
    };

    if (!source || typeof source !== 'object') return groups;

    Object.entries(source).forEach(([key, value]) => {
      const entry = buildEligibilityFieldEntry(key, value);
      const base = entry.baseKey;

      if (normalizedHeaderMatches(base, CARD_MODAL_HEADERS)) {
        if (!groups.cards.has(entry.groupNumber)) groups.cards.set(entry.groupNumber, []);
        groups.cards.get(entry.groupNumber).push(entry);
        return;
      }

      if (normalizedHeaderMatches(base, REQUEST_MODAL_HEADERS)) {
        groups.request.push(entry);
        return;
      }

      if (normalizedHeaderMatches(base, MEMBER_MODAL_HEADERS)) {
        groups.member.push(entry);
        return;
      }

      if (normalizedHeaderMatches(base, CLINICIAN_MODAL_HEADERS)) {
        groups.clinician.push(entry);
        return;
      }

      if (normalizedHeaderMatches(base, PROVIDER_MODAL_HEADERS)) {
        groups.provider.push(entry);
        return;
      }

      groups.additional.push(entry);
    });

    return groups;
  }

  function eligibilityFieldCard(entry, candidate, claim) {
    const field = resolveEligibilityComparisonField(entry.key);
    const displayValue = normalizeText(entry.displayValue) || '(blank)';

    if (!field) {
      return `
        <div class="eligibility-field-card" style="
          min-width:0;border:1px solid #e3e6e8;border-radius:7px;padding:9px 10px;
          background:#fff;overflow-wrap:anywhere;word-break:break-word;
        ">
          <div style="font-size:10px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#6c757d;margin-bottom:4px;">
            ${escapeHtml(entry.baseKey)}
          </div>
          <div style="font-size:13px;line-height:1.35;white-space:normal;overflow-wrap:anywhere;">
            ${escapeHtml(displayValue)}
          </div>
        </div>
      `;
    }

    const matched = candidate.comparison?.[field] === true;
    const eidBlankAccepted =
      field === 'eid' &&
      candidate.comparison?.eidBlankAccepted === true;
    const background = matched ? '#f0faf4' : '#fff3f4';
    const border = matched ? '#75b798' : '#ea868f';
    const badgeBackground = matched ? '#198754' : '#dc3545';
    const badgeText = eidBlankAccepted
      ? 'Blank accepted'
      : matched
        ? 'Match'
        : 'Mismatch';
    const claimValue = comparisonClaimValue(field, claim) || '(blank)';

    return `
      <div class="eligibility-field-card eligibility-comparison-card" style="
        grid-column:1 / -1;min-width:0;border:1px solid ${border};border-left:5px solid ${badgeBackground};
        border-radius:7px;padding:10px 11px;background:${background};overflow-wrap:anywhere;
      ">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <div style="min-width:0;">
            <div style="font-size:11px;font-weight:700;color:#495057;">
              ${escapeHtml(entry.baseKey)}
            </div>
            <div style="font-size:10px;color:#6c757d;margin-top:1px;">
              Compared with ${escapeHtml(comparisonLabel(field))}
            </div>
          </div>
          <span style="background:${badgeBackground};color:#fff;border-radius:999px;padding:2px 8px;font-size:10px;font-weight:700;white-space:nowrap;">
            ${badgeText}
          </span>
        </div>
        <div style="font-size:14px;font-weight:600;line-height:1.35;margin-top:7px;white-space:normal;overflow-wrap:anywhere;word-break:break-word;">
          ${escapeHtml(displayValue)}
        </div>
        <div style="font-size:11px;color:#6c757d;margin-top:5px;white-space:normal;overflow-wrap:anywhere;">
          Claim: ${escapeHtml(claimValue)}
        </div>
      </div>
    `;
  }

  function renderEligibilitySection(title, entries, candidate, claim, options = {}) {
    const visibleEntries = entries.filter(entry => {
      if (!options.hideEmpty) return true;
      if (resolveEligibilityComparisonField(entry.key)) return true;
      return normalizeText(entry.displayValue) !== '';
    });

    if (!visibleEntries.length) return '';

    const subtitle = options.subtitle
      ? `<div style="font-size:11px;color:#6c757d;margin-top:2px;">${escapeHtml(options.subtitle)}</div>`
      : '';

    return `
      <section class="eligibility-detail-section" style="
        min-width:0;border:1px solid #dee2e6;border-radius:9px;padding:11px;background:#f8f9fa;
      ">
        <div style="margin-bottom:8px;">
          <h5 style="margin:0;font-size:14px;">${escapeHtml(title)}</h5>
          ${subtitle}
        </div>
        <div class="eligibility-field-grid" style="
          display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:8px;min-width:0;
        ">
          ${visibleEntries.map(entry => eligibilityFieldCard(entry, candidate, claim)).join('')}
        </div>
      </section>
    `;
  }

  function cardGroupHasValue(entries) {
    return entries.some(entry => normalizeText(entry.displayValue) !== '');
  }

  function renderGroupedEligibilityDetails(candidate, claim) {
    const grouped = classifyEligibilityFields(candidate);
    const cards = Array.from(grouped.cards.entries())
      .sort(([a], [b]) => a - b)
      .filter(([, entries]) => cardGroupHasValue(entries));

    const topSections = [
      renderEligibilitySection('Request & Status', grouped.request, candidate, claim, { hideEmpty: true }),
      renderEligibilitySection('Member', grouped.member, candidate, claim, { hideEmpty: true }),
      renderEligibilitySection('Clinician', grouped.clinician, candidate, claim, { hideEmpty: true }),
      renderEligibilitySection('Provider', grouped.provider, candidate, claim, { hideEmpty: true })
    ].filter(Boolean);

    const cardSections = cards.map(([groupNumber, entries]) =>
      renderEligibilitySection(
        `Card ${groupNumber}`,
        entries,
        candidate,
        claim,
        {
          hideEmpty: true,
          subtitle: groupNumber === 1
            ? 'Primary card record'
            : `Workbook card group ${groupNumber}`
        }
      )
    );

    const additionalSection = renderEligibilitySection(
      'Additional Information',
      grouped.additional,
      candidate,
      claim,
      { hideEmpty: true }
    );

    const noCardsMessage = cardSections.length
      ? ''
      : '<div class="alert alert-secondary" style="margin:0;">No populated card records were found in this eligibility row.</div>';

    return `
      <div class="eligibility-section-grid" style="
        display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:11px;align-items:start;min-width:0;
      ">
        ${topSections.join('')}
      </div>

      <div style="margin-top:14px;">
        <h4 style="margin:0 0 8px;font-size:15px;">Cards</h4>
        ${noCardsMessage || `
          <div class="eligibility-section-grid" style="
            display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:11px;align-items:start;min-width:0;
          ">
            ${cardSections.join('')}
          </div>
        `}
      </div>

      ${additionalSection ? `
        <details style="margin-top:14px;border:1px solid #dee2e6;border-radius:9px;padding:9px 10px;background:#fff;">
          <summary style="cursor:pointer;font-weight:700;font-size:13px;">Additional Information</summary>
          <div style="margin-top:9px;">${additionalSection}</div>
        </details>
      ` : ''}
    `;
  }

  function eligibilityRowToRows(candidate, claim) {
    const object = candidate?.row;
    if (!object || typeof object !== 'object') {
      return '<div class="alert alert-secondary">No eligibility row data available.</div>';
    }

    return `
      <div class="eligibility-field-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:8px;">
        ${Object.entries(object)
          .map(([key, value]) => eligibilityFieldCard(
            buildEligibilityFieldEntry(key, value),
            candidate,
            claim
          ))
          .join('')}
      </div>
    `;
  }

  function comparisonBadge(matched, acceptedBlank = false) {
    const background = matched ? '#198754' : '#dc3545';
    const text = acceptedBlank
      ? 'Blank accepted'
      : matched
        ? 'Match'
        : 'Mismatch';

    return `
      <span style="display:inline-block;background:${background};color:#fff;border-radius:999px;padding:2px 7px;font-size:10px;font-weight:700;white-space:nowrap;">
        ${text}
      </span>
    `;
  }

  function claimFieldCard(key, value) {
    const displayValue = normalizeText(value) || '(blank)';
    const wide = /remarks|notes|required eligibility clinicians|performing clinicians|ordering clinicians|gt clinicians/i.test(key);

    return `
      <div style="
        ${wide ? 'grid-column:1 / -1;' : ''}min-width:0;border:1px solid #e3e6e8;border-radius:7px;
        padding:9px 10px;background:#fff;overflow-wrap:anywhere;word-break:break-word;
      ">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6c757d;margin-bottom:4px;">
          ${escapeHtml(key)}
        </div>
        <div style="font-size:13px;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;">
          ${escapeHtml(displayValue)}
        </div>
      </div>
    `;
  }

  function renderClaimOverview(claim) {
    if (!claim || typeof claim !== 'object') {
      return '<div class="alert alert-secondary">No claim details are available.</div>';
    }

    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;min-width:0;">
        ${Object.entries(claim).map(([key, value]) => claimFieldCard(key, value)).join('')}
      </div>
    `;
  }

  function renderCandidateSummary(candidates) {
    if (!candidates.length) {
      return '<div class="alert alert-warning">No same-date partial eligibility candidates were matched.</div>';
    }

    return `
      <div
        class="eligibility-candidate-comparison-grid"
        style="
          display:grid;
          grid-template-columns:repeat(auto-fit,minmax(min(100%,615px),1fr));
          gap:10px;
          margin-top:10px;
          min-width:0;
        "
      >
        ${candidates.map((candidate, index) => `
          <article style="min-width:0;border:1px solid ${candidate.completeMatch ? '#75b798' : '#ea868f'};border-radius:9px;padding:11px;background:#fff;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <div style="min-width:0;">
                <strong style="font-size:13px;overflow-wrap:anywhere;">${escapeHtml(candidate.requestNumber || `Eligibility ${index + 1}`)}</strong>
                <div style="font-size:10px;color:#6c757d;margin-top:2px;">
                  ${escapeHtml(candidate.sheetName)} row ${escapeHtml(candidate.sheetRowNumber)}
                </div>
              </div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">
                ${eligibilityStatusBadge(candidate.status, true)}
                ${candidate.selected ? `
                  <span style="background:#0d6efd;color:#fff;border-radius:999px;padding:2px 7px;font-size:10px;font-weight:700;white-space:nowrap;">Selected</span>
                ` : candidate.memberIdCorrection ? `
                  <span style="background:#ffc107;color:#212529;border-radius:999px;padding:2px 7px;font-size:10px;font-weight:700;white-space:nowrap;">Member ID Correction</span>
                ` : ''}
              </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:10px;">
              <div style="min-width:0;">
                <div style="font-size:9px;text-transform:uppercase;color:#6c757d;font-weight:700;">Member Name</div>
                <div style="font-size:12px;overflow-wrap:anywhere;">${escapeHtml(candidate.memberName || '(blank)')}</div>
              </div>
              <div style="min-width:0;">
                <div style="font-size:9px;text-transform:uppercase;color:#6c757d;font-weight:700;">Clinician Name</div>
                <div style="font-size:12px;overflow-wrap:anywhere;">${escapeHtml(candidate.clinicianName || '(blank)')}</div>
              </div>
              <div style="min-width:0;">
                <div style="font-size:9px;text-transform:uppercase;color:#6c757d;font-weight:700;">Basis</div>
                <div style="font-size:12px;overflow-wrap:anywhere;">${escapeHtml(candidate.bases?.join(' + ') || candidate.basis)}</div>
              </div>
              <div style="min-width:0;">
                <div style="font-size:9px;text-transform:uppercase;color:#6c757d;font-weight:700;">Ordered On</div>
                <div style="font-size:12px;overflow-wrap:anywhere;">${escapeHtml(candidate.orderedOnDisplay)}</div>
              </div>
            </div>

            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:10px;align-items:center;">
              <span style="font-size:10px;color:#6c757d;font-weight:700;">Date</span>${comparisonBadge(candidate.comparison?.orderedOn === true)}
              <span style="font-size:10px;color:#6c757d;font-weight:700;">Member</span>${comparisonBadge(candidate.comparison?.memberId === true)}
              <span style="font-size:10px;color:#6c757d;font-weight:700;">EID</span>${comparisonBadge(
                candidate.comparison?.eid === true,
                candidate.comparison?.eidBlankAccepted === true
              )}
              <span style="font-size:10px;color:#6c757d;font-weight:700;">Clinician</span>${comparisonBadge(candidate.comparison?.clinician === true)}
            </div>

            <div style="margin-top:9px;padding-top:8px;border-top:1px solid #e9ecef;display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <span style="font-size:11px;font-weight:700;">Overall</span>
              ${comparisonBadge(candidate.completeMatch === true)}
            </div>
          </article>
        `).join('')}
      </div>
    `;
  }

  function buildModalTabs(detail) {
    const claimTab = `
      <button
        type="button"
        class="details-btn eligibility-modal-tab active"
        data-eligibility-tab-target="eligibility-claim-tab"
        aria-selected="true"
        style="border-bottom-left-radius:0;border-bottom-right-radius:0;max-width:100%;white-space:normal;"
      >
        Claim Match
      </button>
    `;

    const eligibilityTabs = detail.candidates.map((candidate, index) => `
      <button
        type="button"
        class="details-btn eligibility-modal-tab"
        data-eligibility-tab-target="eligibility-candidate-tab-${index}"
        aria-selected="false"
        style="border-bottom-left-radius:0;border-bottom-right-radius:0;max-width:100%;white-space:normal;"
      >
        <span>Eligibility ${index + 1}</span>
        <span style="display:inline-flex;gap:4px;flex-wrap:wrap;margin-left:5px;vertical-align:middle;">
          ${eligibilityStatusBadge(candidate.status, true)}
          ${candidate.selected ? `
            <span style="background:#0d6efd;color:#fff;border-radius:999px;padding:1px 7px;font-size:10px;">Selected</span>
          ` : candidate.memberIdCorrection ? `
            <span style="background:#ffc107;color:#212529;border-radius:999px;padding:1px 7px;font-size:10px;">Member ID Correction</span>
          ` : ''}
          <span style="background:${candidate.completeMatch ? '#198754' : '#dc3545'};color:#fff;border-radius:999px;padding:1px 7px;font-size:10px;">
            ${candidate.completeMatch ? 'Complete Match' : 'Mismatch'}
          </span>
        </span>
      </button>
    `).join('');

    return claimTab + eligibilityTabs;
  }

  function buildModalPanes(detail) {
    const claimPane = `
      <section
        id="eligibility-claim-tab"
        class="eligibility-modal-pane"
        data-eligibility-tab-pane
      >
        <h4 style="margin:0 0 9px;">Claim Match</h4>
        ${renderClaimOverview(detail.claim)}
        <h4 style="margin:16px 0 0;">Matched Eligibility Comparison</h4>
        ${renderCandidateSummary(detail.candidates)}
      </section>
    `;

    const candidatePanes = detail.candidates.map((candidate, index) => `
      <section
        id="eligibility-candidate-tab-${index}"
        class="eligibility-modal-pane"
        data-eligibility-tab-pane
        hidden
      >
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <h4 style="margin:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;">
            <span style="overflow-wrap:anywhere;">${escapeHtml(candidate.requestNumber || `Eligibility ${index + 1}`)}</span>
            ${eligibilityStatusBadge(candidate.status)}
            ${candidate.selected ? `
              <span style="background:#0d6efd;color:#fff;border-radius:999px;padding:2px 8px;font-size:11px;">Selected</span>
            ` : candidate.memberIdCorrection ? `
              <span style="background:#ffc107;color:#212529;border-radius:999px;padding:2px 8px;font-size:11px;">Member ID Correction</span>
            ` : ''}
          </h4>
          <div style="font-size:11px;color:#6c757d;white-space:normal;">
            Sheet <strong>${escapeHtml(candidate.sheetName)}</strong>, row
            <strong>${escapeHtml(candidate.sheetRowNumber)}</strong>
          </div>
        </div>
        <div style="margin:6px 0 11px;font-size:11px;color:#495057;display:flex;gap:10px;flex-wrap:wrap;">
          <span>Match basis: <strong>${escapeHtml(candidate.bases?.join(' + ') || candidate.basis)}</strong></span>
          ${candidate.minutesDifference == null ? '' :
            `<span>Time difference: <strong>${escapeHtml(candidate.minutesDifference.toFixed(2))} minute(s)</strong></span>`}
        </div>
        ${renderGroupedEligibilityDetails(candidate, detail.claimContext)}
      </section>
    `).join('');

    return claimPane + candidatePanes;
  }

  function activateEligibilityModalTab(modal, targetId) {
    modal.querySelectorAll('.eligibility-modal-tab').forEach(button => {
      const active = button.dataset.eligibilityTabTarget === targetId;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.style.fontWeight = active ? '700' : '';
      button.style.background = active ? '#fff' : '';
    });

    modal.querySelectorAll('[data-eligibility-tab-pane]').forEach(pane => {
      pane.hidden = pane.id !== targetId;
    });
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
        width:97vw;max-width:none;max-height:94vh;overflow-y:auto;overflow-x:hidden;background:#fff;
        border-radius:8px;padding:15px;box-shadow:0 10px 30px rgba(0,0,0,.3);box-sizing:border-box;">
        <style>
          #eligibilityDetailsModal, #eligibilityDetailsModal * { box-sizing:border-box; }
          #eligibilityDetailsModal .eligibility-modal-pane { min-width:0; overflow-x:hidden; }
          #eligibilityDetailsModal .eligibility-modal-tab { line-height:1.25; }
          #eligibilityDetailsModal .eligibility-field-card { max-width:100%; }
          @media (max-width:700px) {
            #eligibilityDetailsModal { padding:7px !important; }
            #eligibilityDetailsModal .eligibility-modal { width:100% !important; padding:11px !important; }
            #eligibilityDetailsModal .eligibility-section-grid,
            #eligibilityDetailsModal .eligibility-field-grid,
            #eligibilityDetailsModal .eligibility-candidate-comparison-grid {
              grid-template-columns:minmax(0,1fr) !important;
            }
            #eligibilityDetailsModal .eligibility-modal-tabs { gap:3px !important; }
          }
        </style>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
          <h3 style="margin:0;">Eligibility Details</h3>
          <button type="button" class="details-btn eligibility-modal-close" aria-label="Close">&times;</button>
        </div>

        <div
          class="eligibility-modal-tabs"
          role="tablist"
          style="display:flex;gap:5px;flex-wrap:wrap;border-bottom:1px solid #dee2e6;margin:15px 0 16px;"
        >
          ${buildModalTabs(detail)}
        </div>

        <div class="eligibility-modal-tab-content">
          ${buildModalPanes(detail)}
        </div>

        <div style="text-align:right;margin-top:12px;">
          <button type="button" class="details-btn eligibility-modal-close">Close</button>
        </div>
      </div>
    `;

    modal.addEventListener('click', event => {
      const closeButton = event.target.closest?.('.eligibility-modal-close');
      if (event.target === modal || closeButton) {
        closeEligibilityModal();
        return;
      }

      const tabButton = event.target.closest?.('.eligibility-modal-tab[data-eligibility-tab-target]');
      if (tabButton) {
        event.preventDefault();
        activateEligibilityModalTab(modal, tabButton.dataset.eligibilityTabTarget);
      }
    });

    document.body.appendChild(modal);
    activateEligibilityModalTab(modal, 'eligibility-claim-tab');
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
      'Payer ID': result.PayerID,
      'Member ID': result.MemberID,
      'Emirates ID': result.EmiratesID,
      'Encounter Start': result.EncounterStart,
      'Claim Clinician': result.ClaimClinicians,
      'Provider ID': result.ProviderID,
      'Match Basis': result.MatchBasis,
      'Selected Eligibility Request': result.SelectedEligibilityRequestNumber,
      'Closest/Displayed Eligibility Candidate': result.EligibilityRequestNumber,
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
      alert(onlyInvalid ? 'No non-valid eligibility results.' : 'No eligibility results to export.');
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

    if (!xmlFile) {
      return createErrorWrapper(new Error('Missing XML file.'));
    }

    try {
      const xmlText = typeof root.getUnifiedXmlText === 'function'
        ? await root.getUnifiedXmlText()
        : await xmlFile.text();

      const receiverID = getSubmissionReceiverID(xmlText);

      if (receiverID === 'HAAD') {
        lastResults = [];
        lastWorkbookContext = null;
        detailStore.clear();
        root._lastEligibilityResults = [];
        root._lastEligibilityWorkbookContext = null;
        root._lastEligibilitySkipReason = {
          receiverID,
          reason: 'ReceiverID HAAD is excluded from eligibility validation.'
        };
        wireOptionalExportButton();

        console.log('[ELIG] Skipped eligibility matching for HAAD submission.', {
          receiverID
        });

        return createSkippedWrapper(receiverID);
      }

      root._lastEligibilitySkipReason = null;

      if (!eligibilityFile) {
        return createErrorWrapper(new Error('Missing eligibility workbook.'));
      }

      const eligibilityBuffer = await eligibilityFile.arrayBuffer();
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
        receiverID,
        claims: claims.length,
        eligibilityRows: workbookContext.rows.length,
        valid: results.filter(result => result.Status === 'Valid').length,
        unknown: results.filter(result => result.Status === 'Unknown').length,
        invalid: results.filter(result => result.Status === 'Invalid').length
      });

      return createResultsWrapper(results, workbookContext);
    } catch (error) {
      console.error('[ELIG] Checker failed:', error);
      lastResults = [];
      lastWorkbookContext = null;
      root._lastEligibilityResults = [];
      root._lastEligibilityWorkbookContext = null;
      root._lastEligibilitySkipReason = null;
      wireOptionalExportButton();
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
    isUsableEid,
    isUnknownEid,
    hasAcceptableClaimEid,
    normalizeClinician,
    isGtClinician,
    isEligibilityEidBlank,
    getRequiredClinicians,
    parseDateTime,
    getSubmissionReceiverID,
    parseXMLClaims,
    parseEligibilityWorkbook,
    buildEligibilityIndexes,
    findBestEligibilityMatch,
    analyzeClaim,
    buildCandidateComparison,
    isMemberIdCorrectionCandidate,
    buildWrongMemberIdRemark,
    eligibilityStatusStyle,
    eligibilityStatusBadge,
    classifyEligibilityFields,
    renderGroupedEligibilityDetails,
    eligibilityRowToRows,
    buildModalTabs,
    buildModalPanes
  };

  console.log('[ELIG] checker_elig.js loaded successfully.');
})(window);
