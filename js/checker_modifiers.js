(function (root) {
  'use strict';

  const RECEIVER_CONFIG = Object.freeze({
    D001: Object.freeze({ insurer: 'Thiqa' }),
    A001: Object.freeze({ insurer: 'Daman Enhanced' }),
    D004: Object.freeze({ insurer: 'Daman Basic' })
  });

  const MODIFIER_RULES = Object.freeze({
    '24': Object.freeze({ expectedVOI: 'VOI_D', consultationOnly: true }),
    '25': Object.freeze({ expectedVOI: '', consultationOnly: true }),
    '50': Object.freeze({ expectedVOI: '', consultationOnly: false }),
    '52': Object.freeze({ expectedVOI: 'VOI_EF1', consultationOnly: true })
  });

  // Keep modifier price validation aligned with checker_pricing medical factors.
  const KHABISI_FACTOR_13_CODES = new Set([
    '92504',
    '92567',
    '94640',
    '96360',
    '96361',
    '96365',
    '96367',
    '96372',
    '96374',
    '96375',
    '69210'
  ]);
  const KHABISI_AUTH_FACTOR_13_CODES = new Set(['97802', '97803']);

  const ELIGIBILITY_HEADERS = Object.freeze({
    member: 'Card Number / DHA Member ID',
    date: 'Ordered On',
    clinician: 'Clinician',
    voi: 'VOI Number',
    age: ['Age', 'Member Age', 'Patient Age'],
    dob: ['Date of Birth', 'DOB', 'Birth Date', 'Member DOB']
  });

  let lastResults = [];
  let lastWorkbook = null;
  let standaloneBound = false;
  let claimIdObserver = null;
  let claimIdStyleInjected = false;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalizeIdentifier(value) {
    return String(value == null ? '' : value)
      .trim()
      .toUpperCase();
  }

  function normalizeMemberId(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/^0+(?=\d)/, '');
  }

  function normalizeClinician(value) {
    return normalizeIdentifier(value)
      .replace(/\s+/g, '');
  }

  function normalizeCode(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/^0+(?=\d)/, '');
  }

  function normForCompare(value) {
    return normalizeIdentifier(value)
      .replace(/[^A-Z0-9]/g, '');
  }

  function isConsultationCode(code) {
    const normalized = String(code || '').trim();

    // E/M consultation codes:
    // - Standard E/M family: 992xx
    // - Ophthalmology examination/visit codes: 92002, 92004, 92012, 92014
    //
    // Do not use a broad /^92/ prefix: procedure codes such as 92504,
    // 92511, 92132, 92250, and 92285 are not E/M consultations.
    return /^992\d{2}$/.test(normalized)
      || /^(92002|92004|92012|92014)$/.test(normalized);
  }

  function moneyEqual(a, b) {
    const left = Number(a);
    const right = Number(b);
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.01;
  }

  function getDirectChildren(parent, tagName) {
    if (
      !parent
      || !parent.childNodes
    ) {
      return [];
    }

    return Array.from(
      parent.childNodes
    ).filter((node) => {
      if (
        !node
        || node.nodeType !== 1
      ) {
        return false;
      }

      return (
        node.localName
        || node.nodeName
      ) === tagName;
    });
  }

  function getDirectChildText(parent, tagName) {
    const child =
      getDirectChildren(
        parent,
        tagName
      )[0];

    return child
      ? String(
          child.textContent || ''
        ).trim()
      : '';
  }

  function firstDirectChildText(
    parent,
    tagNames
  ) {
    for (
      const tagName
      of tagNames
    ) {
      const value =
        getDirectChildText(
          parent,
          tagName
        );

      if (value) {
        return value;
      }
    }

    return '';
  }

  function getModifierContainer() {
    return document.getElementById(
      'checker-container-modifiers'
    );
  }

  function getScopedElement(id) {
    const container =
      getModifierContainer();

    return (
      (
        container
        && container.querySelector(
          `#${id}`
        )
      )
      || document.getElementById(id)
    );
  }

  function resolveInputFile(
    id,
    cacheKey,
    explicitFile
  ) {
    if (explicitFile) {
      return explicitFile;
    }

    const input =
      getScopedElement(id);

    return (
      input?.files?.[0]
      || root.unifiedCheckerFiles?.[
        cacheKey
      ]
      || null
    );
  }

  function updateMessage(
    text,
    isError
  ) {
    const messageBox =
      getScopedElement(
        'messageBox'
      );

    if (!messageBox) {
      return;
    }

    messageBox.textContent =
      text || '';

    messageBox.style.color =
      isError
        ? '#b42318'
        : '';
  }

  function updateDownloadButton() {
    const button =
      getScopedElement(
        'download-button'
      );

    if (!button) {
      return;
    }

    button.disabled =
      lastResults.length === 0;

    button.style.display =
      lastResults.length
        ? ''
        : 'none';
  }

  async function readFileText(file) {
    if (!file) {
      throw new Error(
        'XML file is missing.'
      );
    }

    if (
      typeof file.text
      === 'function'
    ) {
      return file.text();
    }

    return new Promise(
      (resolve, reject) => {
        const reader =
          new FileReader();

        reader.onload = () => {
          resolve(
            String(
              reader.result || ''
            )
          );
        };

        reader.onerror = () => {
          reject(
            reader.error
            || new Error(
              'Failed to read XML file.'
            )
          );
        };

        reader.readAsText(file);
      }
    );
  }

  async function readFileArrayBuffer(file) {
    if (!file) {
      throw new Error(
        'Eligibility workbook is missing.'
      );
    }

    if (
      typeof file.arrayBuffer
      === 'function'
    ) {
      return file.arrayBuffer();
    }

    return new Promise(
      (resolve, reject) => {
        const reader =
          new FileReader();

        reader.onload = () => {
          resolve(reader.result);
        };

        reader.onerror = () => {
          reject(
            reader.error
            || new Error(
              'Failed to read eligibility workbook.'
            )
          );
        };

        reader.readAsArrayBuffer(
          file
        );
      }
    );
  }

  function parseXml(text) {
    const safeXml =
      String(text || '').replace(
        /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g,
        'and'
      );

    const xmlDoc =
      new DOMParser()
        .parseFromString(
          safeXml,
          'application/xml'
        );

    const parserError =
      xmlDoc.getElementsByTagName(
        'parsererror'
      )[0];

    if (parserError) {
      throw new Error(
        `Invalid XML: ${
          String(
            parserError.textContent
            || 'parse error'
          ).trim()
        }`
      );
    }

    if (
      !xmlDoc.documentElement
      || xmlDoc.documentElement
        .nodeName !==
        'Claim.Submission'
    ) {
      throw new Error(
        'Modifier checker requires a Claim.Submission XML file.'
      );
    }

    return xmlDoc;
  }

  function excelSerialToDate(serial) {
    if (!Number.isFinite(serial)) {
      return null;
    }

    if (
      root.XLSX
        ?.SSF
        ?.parse_date_code
    ) {
      const parsed =
        root.XLSX.SSF
          .parse_date_code(
            serial
          );

      if (parsed) {
        return new Date(
          Date.UTC(
            parsed.y,
            parsed.m - 1,
            parsed.d
          )
        );
      }
    }

    return new Date(
      Math.round(
        (
          serial
          - 25569
        )
        * 86400
        * 1000
      )
    );
  }

  function dateToKey(date) {
    if (
      !(date instanceof Date)
      || Number.isNaN(
        date.getTime()
      )
    ) {
      return '';
    }

    const year =
      date.getUTCFullYear();

    const month =
      String(
        date.getUTCMonth() + 1
      ).padStart(2, '0');

    const day =
      String(
        date.getUTCDate()
      ).padStart(2, '0');

    return (
      `${year}-`
      + `${month}-`
      + day
    );
  }

  function normalizeDate(value) {
    if (
      value == null
      || value === ''
    ) {
      return '';
    }

    if (
      value instanceof Date
    ) {
      return dateToKey(value);
    }

    if (
      typeof value
      === 'number'
    ) {
      const parsed =
        excelSerialToDate(
          value
        );

      return parsed
        ? dateToKey(parsed)
        : '';
    }

    const raw =
      String(value).trim();

    if (!raw) {
      return '';
    }

    const dateOnly =
      raw.split(/[ T]/)[0];

    let match =
      dateOnly.match(
        /^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)$/
      );

    if (match) {
      return (
        `${match[1]}-`
        + `${String(
          Number(match[2])
        ).padStart(2, '0')}-`
        + String(
          Number(match[3])
        ).padStart(2, '0')
      );
    }

    match =
      dateOnly.match(
        /^([0-3]?\d)[-\/]([01]?\d)[-\/](\d{2}|\d{4})$/
      );

    if (match) {
      const year =
        match[3].length === 2
          ? (
              2000
              + Number(match[3])
            )
          : Number(match[3]);

      return (
        `${year}-`
        + `${String(
          Number(match[2])
        ).padStart(2, '0')}-`
        + String(
          Number(match[1])
        ).padStart(2, '0')
      );
    }

    const parsed =
      new Date(raw);

    return Number.isNaN(
      parsed.getTime()
    )
      ? ''
      : dateToKey(parsed);
  }

  function resolveExactHeader(
    headers,
    requiredName
  ) {
    const expected =
      String(requiredName)
        .trim()
        .toLowerCase();

    return (
      headers.find(
        (header) =>
          String(header)
            .trim()
            .toLowerCase()
          === expected
      )
      || null
    );
  }

  function resolveOptionalHeader(headers, aliases) {
    const expected = new Set((Array.isArray(aliases) ? aliases : [aliases]).map(value => String(value || '').trim().toLowerCase()));
    return headers.find(header => expected.has(String(header || '').trim().toLowerCase())) || null;
  }

  function ageOnDate(ageValue, dobValue, encounterDate) {
    const numericAge = Number(String(ageValue == null ? '' : ageValue).trim());
    if (Number.isFinite(numericAge) && numericAge >= 0 && numericAge < 130) return numericAge;
    if (!dobValue || !encounterDate) return null;
    const dob = dobValue instanceof Date ? dobValue : new Date(dobValue);
    const encounter = new Date(`${encounterDate}T00:00:00`);
    if (Number.isNaN(dob.getTime()) || Number.isNaN(encounter.getTime())) return null;
    let age = encounter.getFullYear() - dob.getFullYear();
    const month = encounter.getMonth() - dob.getMonth();
    if (month < 0 || (month === 0 && encounter.getDate() < dob.getDate())) age -= 1;
    return age >= 0 && age < 130 ? age : null;
  }

  function parseEligibilityWorkbook(workbookFile, arrayBuffer) {
    if (!root.XLSX || typeof root.XLSX.read !== 'function') {
      throw new Error('SheetJS (XLSX) is unavailable.');
    }

    const workbook = root.XLSX.read(arrayBuffer, {
      type: 'array',
      cellDates: true
    });

    const sheetName = workbook.SheetNames?.[0];
    if (!sheetName) throw new Error('Eligibility workbook contains no worksheet.');

    const worksheet = workbook.Sheets[sheetName];

    // Established eligibility layout: headers are on workbook row 2.
    const sourceRows = root.XLSX.utils.sheet_to_json(worksheet, {
      defval: '',
      range: 1,
      raw: true,
      blankrows: false
    });

    if (!sourceRows.length) {
      throw new Error('Eligibility workbook contains no data rows.');
    }

    const headers = Array.from(new Set(sourceRows.flatMap((row) => Object.keys(row || {}))));
    const memberHeader = resolveExactHeader(headers, ELIGIBILITY_HEADERS.member);
    const dateHeader = resolveExactHeader(headers, ELIGIBILITY_HEADERS.date);
    const clinicianHeader = resolveExactHeader(headers, ELIGIBILITY_HEADERS.clinician);
    const voiHeader = resolveExactHeader(headers, ELIGIBILITY_HEADERS.voi);
    const ageHeader = resolveOptionalHeader(headers, ELIGIBILITY_HEADERS.age);
    const dobHeader = resolveOptionalHeader(headers, ELIGIBILITY_HEADERS.dob);

    const missing = [];
    if (!memberHeader) missing.push(ELIGIBILITY_HEADERS.member);
    if (!dateHeader) missing.push(ELIGIBILITY_HEADERS.date);
    if (!clinicianHeader) missing.push(ELIGIBILITY_HEADERS.clinician);
    if (!voiHeader) missing.push(ELIGIBILITY_HEADERS.voi);

    if (missing.length) {
      throw new Error(`Eligibility workbook is missing required column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);
    }

    const rows = sourceRows.map((sourceRow, index) => ({
      sourceRow,
      sheetName,
      sheetRowNumber: index + 3,
      memberID: normalizeMemberId(sourceRow[memberHeader]),
      orderedOn: normalizeDate(sourceRow[dateHeader]),
      clinician: normalizeClinician(sourceRow[clinicianHeader]),
      voiNumber: String(sourceRow[voiHeader] == null ? '' : sourceRow[voiHeader]).trim(),
      ageRaw: ageHeader ? sourceRow[ageHeader] : '',
      dobRaw: dobHeader ? sourceRow[dobHeader] : '',
      used: false
    }));

    return { workbook, sheetName, rows };
  }

  function buildEligibilityMatcher(rows) {
    const index =
      new Map();

    const claimCache =
      new Map();

    for (const row of rows) {
      const key = [
        row.memberID,
        row.orderedOn,
        row.clinician
      ].join('|');

      if (!index.has(key)) {
        index.set(
          key,
          []
        );
      }

      index.get(key).push(row);
    }

    function findUnusedExact(
      memberID,
      orderedOn,
      orderingClinician
    ) {
      const key = [
        normalizeMemberId(
          memberID
        ),

        normalizeDate(
          orderedOn
        ),

        normalizeClinician(
          orderingClinician
        )
      ].join('|');

      const candidates =
        index.get(key) || [];

      return (
        candidates.find(
          (row) =>
            !row.used
        )
        || null
      );
    }

    return {
      /*
       * One eligibility row is assigned to
       * one Claim ID.
       *
       * Every modifier activity inside that
       * claim reuses the same matched row.
       */
      findForClaim(
        claimID,
        memberID,
        orderedOn,
        orderingClinicians
      ) {
        const normalizedClaimID =
          String(
            claimID || ''
          ).trim();

        if (
          claimCache.has(
            normalizedClaimID
          )
        ) {
          return claimCache.get(
            normalizedClaimID
          );
        }

        const clinicians =
          Array.from(
            new Set(
              (
                Array.isArray(
                  orderingClinicians
                )
                  ? orderingClinicians
                  : [
                      orderingClinicians
                    ]
              )
                .map(
                  normalizeClinician
                )
                .filter(Boolean)
            )
          );

        let match = null;

        for (
          const clinician
          of clinicians
        ) {
          match =
            findUnusedExact(
              memberID,
              orderedOn,
              clinician
            );

          if (match) {
            break;
          }
        }

        /*
         * Consume the eligibility row once
         * for the entire claim.
         */
        if (match) {
          match.used = true;
        }

        /*
         * Cache null as well. This prevents
         * contradictory rows where one
         * activity says no eligibility but
         * another activity in the same claim
         * finds one later.
         */
        claimCache.set(
          normalizedClaimID,
          match
        );

        return match;
      },

      getClaimMatch(claimID) {
        const normalizedClaimID =
          String(
            claimID || ''
          ).trim();

        return claimCache.has(
          normalizedClaimID
        )
          ? claimCache.get(
              normalizedClaimID
            )
          : undefined;
      },

      index,
      claimCache
    };
  }

  function resolveClaimEligibilityMatches(
    records,
    claimActivities,
    matcher
  ) {
    const recordsByClaim =
      new Map();

    for (const record of records) {
      if (
        !recordsByClaim.has(
          record.ClaimID
        )
      ) {
        recordsByClaim.set(
          record.ClaimID,
          []
        );
      }

      recordsByClaim
        .get(record.ClaimID)
        .push(record);
    }

    const matches =
      new Map();

    for (
      const [
        claimID,
        claimRecords
      ]
      of recordsByClaim.entries()
    ) {
      const firstRecord =
        claimRecords[0];

      /*
       * Match using the exact established:
       *
       * Member ID
       * + Encounter date
       * + Ordering Clinician
       *
       * Try all Ordering Clinicians appearing
       * in the claim before declaring that the
       * claim has no eligibility.
       */
      const orderingClinicians = [
        ...claimRecords.map(
          (record) =>
            record.OrderingClinician
        ),

        ...(
          claimActivities.get(
            claimID
          )
          || []
        ).map(
          (activity) =>
            activity.orderingClinician
        )
      ];

      const match =
        matcher.findForClaim(
          claimID,
          firstRecord.MemberID,
          firstRecord.Date,
          orderingClinicians
        );

      matches.set(
        claimID,
        match
      );
    }

    return matches;
  }

  function parseModifierValue(
    rawValue
  ) {
    const normalized =
      normForCompare(rawValue);

    if (
      normalized === '24'
      || normalized === 'VOID'
      || normalized === 'VOLD'
    ) {
      return '24';
    }

    if (normalized === '25') {
      return '25';
    }

    if (normalized === '50') {
      return '50';
    }

    if (
      normalized === '52'
      || normalized === 'VOIEF1'
    ) {
      return '52';
    }

    return '';
  }

  function collectXmlData(xmlDoc) {
    const rootElement = xmlDoc.documentElement;
    const header = getDirectChildren(rootElement, 'Header')[0];
    const receiverID = normalizeIdentifier(getDirectChildText(header, 'ReceiverID'));
    const receiver = RECEIVER_CONFIG[receiverID] || null;
    const records = [];
    const claimActivities = new Map();
    const claimDiagnoses = new Map();

    for (const claim of getDirectChildren(rootElement, 'Claim')) {
      const claimID = getDirectChildText(claim, 'ID') || 'Unknown';
      const memberID = normalizeMemberId(getDirectChildText(claim, 'MemberID'));
      const claimPayerID = normalizeIdentifier(getDirectChildText(claim, 'PayerID'));
      const encounter = getDirectChildren(claim, 'Encounter')[0] || getDirectChildren(claim, 'Encounte')[0];
      const facilityID = normalizeIdentifier(getDirectChildText(encounter, 'FacilityID'));
      const encounterDate = normalizeDate(firstDirectChildText(encounter, ['Date', 'Start', 'EncounterDate']));
      const diagnoses = getDirectChildren(claim, 'Diagnosis').map(diagnosis => ({
        type: getDirectChildText(diagnosis, 'Type'),
        code: normalizeIdentifier(getDirectChildText(diagnosis, 'Code'))
      }));
      claimDiagnoses.set(claimID, diagnoses);
      const activities = [];

      for (const activity of getDirectChildren(claim, 'Activity')) {
        const activityID = getDirectChildText(activity, 'ID');
        const activityCode = getDirectChildText(activity, 'Code');
        const quantity = Number(getDirectChildText(activity, 'Quantity') || 0);
        const net = Number(getDirectChildText(activity, 'Net') || 0);
        const orderingClinicianRaw = firstDirectChildText(activity, [
          'OrderingClnician',
          'OrderingClinician',
          'Ordering_Clinician',
          'OrderingClin'
        ]);
        const orderingClinician = normalizeClinician(orderingClinicianRaw);
        const performingClinicianRaw = firstDirectChildText(activity, ['Clinician', 'PerformingClinician']);
        const performingClinician = normalizeClinician(performingClinicianRaw);
        const priorAuthorizationID = firstDirectChildText(activity, ['PriorAuthorizationID', 'PriorAuthorization']);

        activities.push({
          claimID,
          memberID,
          date: encounterDate,
          receiverID,
          payerID: claimPayerID,
          facilityID,
          priorAuthorizationID,
          activityID,
          activityCode,
          quantity,
          net,
          orderingClinician,
          orderingClinicianRaw,
          performingClinician,
          performingClinicianRaw
        });

        for (const observation of getDirectChildren(activity, 'Observation')) {
          const valueType = getDirectChildText(observation, 'ValueType');

          // This check must happen before looking at Value. LOINC observations can
          // legitimately have values 24, 25, 50 or 52 and are not modifiers.
          if (String(valueType || '').trim().toLowerCase() !== 'modifiers') continue;

          const rawValue = firstDirectChildText(observation, ['Value', 'ValueText']);
          const modifier = parseModifierValue(rawValue);
          if (!modifier || !MODIFIER_RULES[modifier]) continue;

          const observationCode = getDirectChildText(observation, 'Code');

          records.push({
            ClaimID: claimID,
            MemberID: memberID,
            ActivityID: activityID,
            Date: encounterDate,
            OrderingClinician: orderingClinician,
            OrderingClinicianRaw: orderingClinicianRaw,
            PerformingClinician: performingClinician,
            PerformingClinicianRaw: performingClinicianRaw,
            Modifier: modifier,
            ActivityCode: activityCode,
            Quantity: quantity,
            Net: net,
            ReceiverID: receiverID,
            PayerID: claimPayerID,
            FacilityID: facilityID,
            PriorAuthorizationID: priorAuthorizationID,
            Insurer: receiver?.insurer || 'Unknown',
            ObsCode: observationCode,
            ObsValueType: valueType,
            VOINumber: String(rawValue || '').trim()
          });
        }
      }

      claimActivities.set(claimID, activities);
    }

    const seen = new Set();
    const uniqueRecords = records.filter((record) => {
      const key = [
        record.ClaimID,
        record.ActivityID,
        record.MemberID,
        record.Modifier,
        record.ObsCode
      ].join('|');

      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      receiverID,
      receiver,
      records: uniqueRecords,
      claimActivities,
      claimDiagnoses
    };
  }

  function buildClaimModifierContext(claimActivities, minorProcedureCodes, claimDiagnoses = new Map()) {
    const context = new Map();

    for (const [claimID, activities] of claimActivities.entries()) {
      const diagnoses = claimDiagnoses.get(claimID) || [];
      const claimContext = {
        hasMinorProcedure: false,
        hasPricedConsultation: false,
        hasPregnancyDiagnosis: diagnoses.some(diagnosis => String(diagnosis.code || '').startsWith('O')),
        diagnoses
      };

      for (const activity of activities) {
        const normalizedActivityCode = normalizeCode(activity.activityCode);
        if (minorProcedureCodes.has(normalizedActivityCode)) {
          claimContext.hasMinorProcedure = true;
        }

        if (isConsultationCode(activity.activityCode) && Number(activity.net || 0) > 0) {
          claimContext.hasPricedConsultation = true;
        }
      }

      context.set(claimID, claimContext);
    }

    return context;
  }

  function voiMatchesModifier(
    modifier,
    voiNumber
  ) {
    const normalized =
      normForCompare(
        voiNumber
      );

    if (modifier === '24') {
      return (
        normalized === '24'
        || normalized.includes(
          'VOID'
        )
        || normalized.includes(
          'VOLD'
        )
      );
    }

    if (modifier === '52') {
      return (
        normalized === '52'
        || normalized.includes(
          'VOIEF1'
        )
      );
    }

    return true;
  }

  function analyzeRecord(record, eligibilityMatch, receiver, claimContext, minorProcedureCodes, minorProcedureRules, clinicianSpecialtyMap, medicalPricingMap, modifierFactorRules) {
    const remarks = [];
    const manualReviewRemarks = [];
    let unknownPayer = false;

    if (!record.ReceiverID) {
      unknownPayer = true;
      remarks.push('ReceiverID is missing from the XML Header; modifier payer rules could not be determined.');
    } else if (!receiver) {
      unknownPayer = true;
      remarks.push(`Modifier rules are not configured for ReceiverID ${record.ReceiverID}.`);
    }

    if (record.MissingModifier) {
      remarks.push(record.MissingRemark || `Modifier ${record.Modifier} is required but missing.`);
    } else if (record.ObsCode !== 'CPT modifier') {
      remarks.push(`Observation Code incorrect; expected "CPT modifier" but found "${record.ObsCode || '(blank)'}".`);
    }

    const voiNumber = eligibilityMatch
      ? String(eligibilityMatch.voiNumber || '').trim()
      : String(record.VOINumber || '').trim();

    if (!eligibilityMatch && (record.Modifier === '24' || record.Modifier === '52')) {
      remarks.push('No matching eligibility found.');
    }

    const rule = MODIFIER_RULES[record.Modifier];

    if (record.Modifier === '24' || record.Modifier === '52') {
      if (!voiMatchesModifier(record.Modifier, voiNumber)) {
        remarks.push(`Modifier ${record.Modifier} does not match VOI (expected ${rule.expectedVOI}).`);
      }
    }

    if (Number(record.Quantity) !== 1) {
      remarks.push('Qty must be 1 for modifiers.');
    }

    if (rule.consultationOnly && !isConsultationCode(record.ActivityCode)) {
      remarks.push(`Modifier ${record.Modifier} must only be on consultation codes.`);
    }

    const currentClaimContext = claimContext.get(record.ClaimID) || {
      hasMinorProcedure: false,
      hasPricedConsultation: false,
      hasPregnancyDiagnosis: false,
      diagnoses: []
    };

    if (record.Modifier === '25') {
      if (!currentClaimContext.hasMinorProcedure) {
        remarks.push('Modifier 25 requires a minor procedure in the same claim.');
      }
      if (!currentClaimContext.hasPricedConsultation) {
        remarks.push('Modifier 25 requires a consultation code with price in the same claim.');
      }
    }

    if (record.Modifier === '50' && !minorProcedureCodes.has(normalizeCode(record.ActivityCode))) {
      remarks.push(`Modifier 50 cannot be used on \`${record.ActivityCode || '(unknown)'}\`.`);
    }

    if (record.Modifier === '50' && !record.MissingModifier) {
      const procedureRule = minorProcedureRules.get(normalizeCode(record.ActivityCode)) || null;
      const baseModifierPrice = Number(procedureRule?.claimed_amount_1_5);

      if (Number.isFinite(baseModifierPrice)) {
        const factor = findModifierFactor(
          modifierFactorRules,
          record.FacilityID,
          record.ActivityCode,
          record.ReceiverID,
          record.PriorAuthorizationID
        );
        const expected = Math.round((baseModifierPrice * factor + Number.EPSILON) * 100) / 100;

        if (!moneyEqual(record.Net, expected)) {
          remarks.push(
            `Modifier 50 on ${record.ActivityCode} must use the factored 1.5 quantity price of ${expected} ` +
            `(1.5 quantity price ${baseModifierPrice} × factor ${factor}); claimed Net is ${record.Net}.`
          );
        }
      }
    }

    if (record.Modifier === '52') {
      if (currentClaimContext.hasPregnancyDiagnosis) remarks.push('Modifier 52 cannot be used for pregnancy claims.');

      const orderingSpecialty = String(clinicianSpecialtyMap.get(normalizeClinician(record.OrderingClinicianRaw)) || '').toUpperCase();
      const performingSpecialty = String(clinicianSpecialtyMap.get(normalizeClinician(record.PerformingClinicianRaw)) || '').toUpperCase();
      if (orderingSpecialty.includes('PSYCHIATR') || performingSpecialty.includes('PSYCHIATR')) remarks.push('Modifier 52 cannot be used for Psychiatry.');
      else if (!orderingSpecialty && !performingSpecialty) manualReviewRemarks.push('Modifier 52 Psychiatry restriction could not be verified because clinician specialty is unavailable.');

      const basePrice = Number(
        medicalPricingMap instanceof Map
          ? medicalPricingMap.get(normalizeCode(record.ActivityCode))
          : NaN
      );
      if (Number.isFinite(basePrice)) {
        const factor = findModifierFactor(
          modifierFactorRules,
          record.FacilityID,
          record.ActivityCode,
          record.ReceiverID,
          record.PriorAuthorizationID
        );
        const factoredBasePrice = Math.round((basePrice * factor + Number.EPSILON) * 100) / 100;
        const expectedDiscountedPrice = Math.round((factoredBasePrice * 0.5 + Number.EPSILON) * 100) / 100;
        if (!moneyEqual(record.Net, expectedDiscountedPrice)) {
          remarks.push(
            `Modifier 52 on ${record.ActivityCode} must use the 50% E/M price ` +
            `${expectedDiscountedPrice} (standard ${basePrice} × factor ${factor}); claimed Net is ${record.Net}.`
          );
        }
      } else {
        manualReviewRemarks.push(
          `Modifier 52 price could not be verified because standard Medical pricing for ${record.ActivityCode} is unavailable.`
        );
      }
    }

    let status = 'Valid';
    const substantiveRemarks = remarks.filter((remark) =>
      !remark.startsWith('ReceiverID is missing') &&
      !remark.startsWith('Modifier rules are not configured')
    );

    if (substantiveRemarks.length) status = 'Invalid';
    else if (unknownPayer || manualReviewRemarks.length) status = 'Unknown';

    return {
      ...record,
      VOINumber: voiNumber,
      EligibilityRow: eligibilityMatch?.sourceRow || null,
      EligibilitySheet: eligibilityMatch?.sheetName || '',
      EligibilityRowNumber: eligibilityMatch?.sheetRowNumber || '',
      Status: status,
      valid: status === 'Valid',
      Remarks: [...remarks, ...manualReviewRemarks].join(' ') || 'OK'
    };
  }

  function ensureClaimIdFormattingStyle() {
    if (claimIdStyleInjected) {
      return;
    }

    const style =
      document.createElement(
        'style'
      );

    style.id =
      'modifier-claim-id-formatting-style';

    style.textContent = `
      .modifier-results-table
      .claim-id-cell.restored-claim-id {
        color: #666;
        font-style: italic;
      }
    `;

    document.head.appendChild(
      style
    );

    claimIdStyleInjected = true;
  }

  function isRowVisible(row) {
    if (!row) {
      return false;
    }

    if (row.hidden) {
      return false;
    }

    if (
      row.style.display
      === 'none'
    ) {
      return false;
    }

    return (
      getComputedStyle(row)
        .display
      !== 'none'
    );
  }

  function refreshModifierClaimIds(scope) {
    const rootScope =
      scope || document;

    const tables =
      rootScope.matches
        ?.(
          '.modifier-results-table'
        )
        ? [rootScope]
        : Array.from(
            rootScope.querySelectorAll
              ?.(
                '.modifier-results-table'
              )
            || []
          );

    for (const table of tables) {
      let lastVisibleClaimID =
        null;

      const rows =
        Array.from(
          table.querySelectorAll(
            'tbody tr[data-claim-id]'
          )
        );

      for (const row of rows) {
        const claimID =
          row.dataset.claimId
          || '';

        const cell =
          row.querySelector(
            '.claim-id-cell'
          );

        if (!cell) {
          continue;
        }

        if (!isRowVisible(row)) {
          continue;
        }

        /*
         * Show the Claim ID on the first
         * currently visible row of each claim.
         */
        const shouldShow =
          claimID
          && claimID
            !== lastVisibleClaimID;

        cell.textContent =
          shouldShow
            ? claimID
            : '';

        const wasOriginallyShown =
          row.dataset
            .originalClaimVisible
          === 'true';

        /*
         * Match Auth checker formatting:
         * restored IDs are gray and italic.
         */
        cell.classList.toggle(
          'restored-claim-id',
          Boolean(
            shouldShow
            && !wasOriginallyShown
          )
        );

        if (claimID) {
          lastVisibleClaimID =
            claimID;
        }
      }
    }
  }

  function installModifierClaimIdObserver() {
    ensureClaimIdFormattingStyle();

    if (claimIdObserver) {
      return;
    }

    let refreshQueued = false;

    const queueRefresh = () => {
      if (refreshQueued) {
        return;
      }

      refreshQueued = true;

      requestAnimationFrame(() => {
        refreshQueued = false;

        refreshModifierClaimIds(
          document
        );
      });
    };

    claimIdObserver =
      new MutationObserver(
        (mutations) => {
          const relevant =
            mutations.some(
              (mutation) => {
                if (
                  mutation.type
                  === 'childList'
                ) {
                  return Array.from(
                    mutation.addedNodes
                    || []
                  ).some(
                    (node) =>
                      node.nodeType === 1
                      && (
                        node.matches
                          ?.(
                            '.modifier-results-table, .modifier-results-table *'
                          )
                        || node.querySelector
                          ?.(
                            '.modifier-results-table'
                          )
                      )
                  );
                }

                if (
                  mutation.type
                  === 'attributes'
                ) {
                  const element =
                    mutation.target;

                  return (
                    element?.nodeType
                    === 1
                    && (
                      element.matches
                        ?.(
                          '.modifier-results-table tbody tr'
                        )
                      || element.closest
                        ?.(
                          '.modifier-results-table'
                        )
                    )
                  );
                }

                return false;
              }
            );

          if (relevant) {
            queueRefresh();
          }
        }
      );

    claimIdObserver.observe(
      document.body,
      {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          'style',
          'hidden'
        ]
      }
    );
  }

  function createResultsWrapper(
    results,
    context
  ) {
    installModifierClaimIdObserver();

    const wrapper =
      document.createElement(
        'div'
      );

    wrapper.className =
      'modifier-checker-results';

    const total =
      results.length;

    const valid =
      results.filter(
        (result) =>
          result.Status
          === 'Valid'
      ).length;

    const invalid =
      results.filter(
        (result) =>
          result.Status
          === 'Invalid'
      ).length;

    const unknown =
      results.filter(
        (result) =>
          result.Status
          === 'Unknown'
      ).length;

    const summary =
      document.createElement(
        'div'
      );

    summary.className =
      'alert alert-info';

    summary.innerHTML =
      '<strong>Modifier results:</strong> '
      + `${valid} valid / ${total} total. `
      + `${invalid} invalid, `
      + `${unknown} unknown. `
      + `ReceiverID: ${
        escapeHtml(
          context.receiverID
          || '(missing)'
        )
      } (${
        escapeHtml(
          context.receiver
            ?.insurer
          || 'Unknown'
        )
      }).`;

    wrapper.appendChild(
      summary
    );

    const responsive =
      document.createElement(
        'div'
      );

    responsive.className =
      'table-responsive';

    const table =
      document.createElement(
        'table'
      );

    table.className =
      'table table-bordered '
      + 'table-striped '
      + 'checker-table '
      + 'result-table '
      + 'modifier-results-table';

    table.innerHTML = `
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Member ID</th>
          <th>Activity ID</th>
          <th>Ordering Clinician</th>
          <th>CPT Code</th>
          <th>Quantity</th>
          <th>Net</th>
          <th>Observation Code</th>
          <th>Modifier</th>
          <th>VOI Number</th>
          <th>Receiver ID</th>
          <th>Payer ID</th>
          <th>Insurer</th>
          <th>Status</th>
          <th>Remarks</th>
          <th>Eligibility Details</th>
        </tr>
      </thead>

      <tbody></tbody>
    `;

    const tbody =
      table.querySelector(
        'tbody'
      );

    if (!results.length) {
      const row =
        document.createElement(
          'tr'
        );

      row.className =
        'table-success valid-row';

      row.innerHTML =
        '<td colspan="16">'
        + 'No modifier 24, 25, 50, '
        + 'or 52 activities were found.'
        + '</td>';

      tbody.appendChild(row);
    } else {
      let previousClaim = null;
      let previousMember = null;
      let previousActivity = null;

      results.forEach(
        (
          result,
          index
        ) => {
          const row =
            document.createElement(
              'tr'
            );

          row.className =
            result.Status
              === 'Invalid'
              ? (
                  'table-danger '
                  + 'invalid-row invalid'
                )
              : result.Status
                === 'Unknown'
                ? (
                    'table-warning '
                    + 'unknown-row unknown'
                  )
                : (
                    'table-success '
                    + 'valid-row valid'
                  );

          row.dataset.index =
            String(index);

          row.dataset.status =
            result.Status
              .toLowerCase();

          /*
           * The complete Claim ID is stored on
           * every row so it can be restored after
           * invalid-only filtering.
           */
          row.dataset.claimId =
            result.ClaimID
            || '';

          const showClaim =
            result.ClaimID
            !== previousClaim;

          row.dataset
            .originalClaimVisible =
              showClaim
                ? 'true'
                : 'false';

          const showMember =
            showClaim
            || result.MemberID
              !== previousMember;

          const showActivity =
            showClaim
            || result.ActivityID
              !== previousActivity;

          row.innerHTML = `
            <td class="nowrap-col claim-id-cell">
              ${
                showClaim
                  ? escapeHtml(
                      result.ClaimID
                    )
                  : ''
              }
            </td>

            <td>
              ${
                showMember
                  ? escapeHtml(
                      result.MemberID
                    )
                  : ''
              }
            </td>

            <td>
              ${
                showActivity
                  ? escapeHtml(
                      result.ActivityID
                    )
                  : ''
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result
                    .OrderingClinicianRaw
                  || result
                    .OrderingClinician
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.ActivityCode
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.Quantity
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.Net
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.ObsCode
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.Modifier
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.VOINumber
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.ReceiverID
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.PayerID
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.Insurer
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.Status
                )
              }
            </td>

            <td>
              ${
                escapeHtml(
                  result.Remarks
                )
              }
            </td>

            <td>
              ${
                result.EligibilityRow
                  ? (
                      '<button '
                      + 'type="button" '
                      + 'class="details-btn eligibility-details" '
                      + `data-index="${index}" `
                      + `onclick="showModifierEligibility(${index})">`
                      + 'View'
                      + '</button>'
                    )
                  : ''
              }
            </td>
          `;

          tbody.appendChild(row);

          previousClaim =
            result.ClaimID;

          previousMember =
            result.MemberID;

          previousActivity =
            result.ActivityID;
        }
      );
    }

    responsive.appendChild(table);
    wrapper.appendChild(responsive);

    /*
     * The invalid-only filter may already be
     * active when the result is inserted.
     */
    requestAnimationFrame(() => {
      refreshModifierClaimIds(
        wrapper
      );
    });

    return wrapper;
  }

  function createErrorWrapper(error) {
    const wrapper =
      document.createElement(
        'div'
      );

    wrapper.className =
      'modifier-checker-results';

    const alert =
      document.createElement(
        'div'
      );

    alert.className =
      'alert alert-danger';

    alert.textContent =
      `Modifier Checker failed: ${
        error?.message
        || String(error)
      }`;

    wrapper.appendChild(alert);

    const table =
      document.createElement(
        'table'
      );

    table.className =
      'table checker-table';

    table.innerHTML =
      '<tbody>'
      + '<tr class="table-danger invalid-row">'
      + '<td>Modifier checker did not complete.</td>'
      + '</tr>'
      + '</tbody>';

    wrapper.appendChild(table);

    return wrapper;
  }

  function closeModifierEligibilityModal() {
    document
      .getElementById(
        'modifierEligibilityModal'
      )
      ?.remove();
  }

  function showModifierEligibility(index) {
    const result =
      lastResults[
        Number(index)
      ];

    if (
      !result
      ?.EligibilityRow
    ) {
      alert(
        'No eligibility data found for this claim.'
      );

      return;
    }

    closeModifierEligibilityModal();

    const rows =
      Object.entries(
        result.EligibilityRow
      )
        .map(
          ([key, value]) =>
            '<tr>'
            + `<th>${escapeHtml(key)}</th>`
            + `<td>${escapeHtml(value)}</td>`
            + '</tr>'
        )
        .join('');

    const modal =
      document.createElement(
        'div'
      );

    modal.id =
      'modifierEligibilityModal';

    modal.className =
      'modal';

    modal.style.display =
      'flex';

    modal.innerHTML = `
      <div class="modal-content eligibility-modal modal-scrollable">
        <span
          class="close"
          role="button"
          aria-label="Close"
          onclick="closeModifierEligibilityModal()"
        >&times;</span>

        <h3>Eligibility Details</h3>

        <table class="eligibility-details">
          ${rows}
        </table>

        <div style="text-align:right;margin-top:10px;">
          <button
            type="button"
            class="details-btn"
            onclick="closeModifierEligibilityModal()"
          >
            Close
          </button>
        </div>
      </div>
    `;

    modal.addEventListener(
      'click',
      (event) => {
        if (
          event.target
          === modal
        ) {
          closeModifierEligibilityModal();
        }
      }
    );

    document.body.appendChild(
      modal
    );
  }

  function makeExportRows(results) {
    return results.map(
      (result) => ({
        'Claim ID':
          result.ClaimID,

        'Member ID':
          result.MemberID,

        'Activity ID':
          result.ActivityID,

        'Ordering Clinician':
          result
            .OrderingClinicianRaw
          || result
            .OrderingClinician,

        'CPT Code':
          result.ActivityCode,

        Quantity:
          result.Quantity,

        Net:
          result.Net,

        'Observation Code':
          result.ObsCode,

        Modifier:
          result.Modifier,

        'VOI Number':
          result.VOINumber,

        'Receiver ID':
          result.ReceiverID,

        'Payer ID':
          result.PayerID,

        Insurer:
          result.Insurer,

        Status:
          result.Status,

        Remarks:
          result.Remarks,

        'Eligibility Sheet':
          result.EligibilitySheet,

        'Eligibility Row':
          result
            .EligibilityRowNumber
      })
    );
  }

  function buildResultsWorkbook(results) {
    const workbook =
      root.XLSX.utils
        .book_new();

    const worksheet =
      root.XLSX.utils
        .json_to_sheet(
          makeExportRows(
            results
          )
        );

    root.XLSX.utils
      .book_append_sheet(
        workbook,
        worksheet,
        'Modifier Results'
      );

    return workbook;
  }

  function downloadModifierResults() {
    if (!lastResults.length) {
      return;
    }

    if (
      !root.XLSX
      || typeof root.XLSX.writeFile
        !== 'function'
    ) {
      throw new Error(
        'SheetJS (XLSX) is unavailable.'
      );
    }

    const workbook =
      lastWorkbook
      || buildResultsWorkbook(
        lastResults
      );

    root.XLSX.writeFile(
      workbook,
      'checker_modifiers_results.xlsx'
    );
  }
  async function loadMinorProcedureData() {
    try {
      const response = await fetch('../json/minor_procedures.json');
      if (!response.ok) return { codes: new Set(), rules: new Map() };
      const data = await response.json();
      const rules = new Map();
      (Array.isArray(data) ? data : []).forEach(item => {
        const code = normalizeCode(typeof item === 'string' ? item : item?.code);
        if (code) rules.set(code, typeof item === 'string' ? { code } : item);
      });
      return { codes: new Set(rules.keys()), rules };
    } catch (error) {
      console.warn('[MODIFIERS] Could not load minor_procedures.json:', error);
      return { codes: new Set(), rules: new Map() };
    }
  }

  async function loadMedicalPricingMap() {
    const map = new Map();
    try {
      const response = await fetch('../json/medical_pricing.json');
      if (!response.ok) return map;
      const data = await response.json();
      (Array.isArray(data) ? data : []).forEach(row => {
        const code = normalizeCode(row?.code);
        const type = String(row?.type || '').trim().toUpperCase();
        const price = Number(row?.price);
        if (code && (!type || type === 'CPT') && Number.isFinite(price)) {
          map.set(code, price);
        }
      });
    } catch (error) {
      console.warn('[MODIFIERS] Could not load medical_pricing.json for Modifier 52 price validation:', error);
    }
    return map;
  }

  async function loadModifierFactorRules() {
    try {
      const response = await fetch('../resources/Factors.xlsx');
      if (!response.ok || !root.XLSX?.read) return [];
      const workbook = root.XLSX.read(await response.arrayBuffer(), { type: 'array' });
      const worksheet = workbook.Sheets[workbook.SheetNames?.[0]];
      if (!worksheet) return [];
      const rows = root.XLSX.utils.sheet_to_json(worksheet, { defval: '' });
      const payerColumns = [];
      if (rows.length) {
        Object.keys(rows[0]).forEach(key => {
          const match = key.match(/\(([^)]+)\)/);
          const payer = match ? String(match[1] || '').trim().toUpperCase() : '';
          if (/^[A-Z]\d{3,4}$/.test(payer)) payerColumns.push({ key, payer });
        });
      }
      return rows.map(row => {
        const facilityID = String(row['Facility ID'] || '').trim().toUpperCase();
        const matchType = String(row['Code Match Type'] || '').trim();
        const rawValue = String(row['Code Match Value'] || '').trim();
        if (!facilityID || !matchType || !rawValue) return null;
        const matchValues = matchType === 'Exact List'
          ? rawValue.split(',').map(value => normalizeCode(value)).filter(Boolean)
          : rawValue.split(/[\s,]+/).map(value => value.replace(/^or$/i, '').trim()).filter(value => /^\d+$/.test(value));
        const factors = {};
        payerColumns.forEach(({ key, payer }) => {
          const rawValue = row[key];
          const value = Number(rawValue);
          if (rawValue !== '' && rawValue != null && Number.isFinite(value)) factors[payer] = value;
        });
        return matchValues.length ? { facilityID, matchType, matchValues, factors } : null;
      }).filter(Boolean);
    } catch (error) {
      console.warn('[MODIFIERS] Could not load Factors.xlsx for modifier price validation:', error);
      return [];
    }
  }

  function findModifierFactor(rules, facilityID, code, receiverID, priorAuthorizationID = '') {
    const facility = String(facilityID || '').trim().toUpperCase();
    const normalizedCode = normalizeCode(code);
    const receiver = String(receiverID || '').trim().toUpperCase();
    const priorAuthorization = String(priorAuthorizationID || '').trim();

    // Explicit medical pricing overrides shared with checker_pricing.
    if (facility === 'MF5020' && KHABISI_FACTOR_13_CODES.has(normalizedCode)) {
      return 1.3;
    }

    if (facility === 'MF5020' && KHABISI_AUTH_FACTOR_13_CODES.has(normalizedCode)) {
      return priorAuthorization ? 1.3 : 1;
    }

    // C001 uses Mandatory Tariff directly unless a more specific override above applies.
    if (receiver === 'C001') return 1;

    // True Life (MF7003), Thiqa (D001), CPT 90792 explicit pricing override.
    if (facility === 'MF7003' && receiver === 'D001' && normalizedCode === '90792') {
      return 1.3;
    }

    const facilityRules = (Array.isArray(rules) ? rules : []).filter(rule => rule.facilityID === facility);

    // Exact List has priority over Starts With, matching checker_pricing.
    let matched = facilityRules.find(rule =>
      rule.matchType === 'Exact List' &&
      rule.matchValues.includes(normalizedCode)
    );

    if (!matched) {
      matched = facilityRules.find(rule =>
        rule.matchType === 'Starts With' &&
        rule.matchValues.some(prefix => normalizedCode.startsWith(prefix))
      );
    }

    const factor = matched ? Number(matched.factors?.[receiver]) : 1;
    return Number.isFinite(factor) ? factor : 1;
  }

  async function loadClinicianSpecialtyMap() {
    const map = new Map();
    try {
      const response = await fetch('../resources/ClinicianLicenses.xlsx');
      if (response.ok && root.XLSX?.read) {
        const workbook = root.XLSX.read(await response.arrayBuffer(), { type: 'array', cellDates: true });
        for (const sheetName of workbook.SheetNames || []) {
          const matrix = root.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false, blankrows: false });
          for (let rowIndex = 0; rowIndex < Math.min(matrix.length, 30); rowIndex += 1) {
            const headers = (matrix[rowIndex] || []).map(value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
            const licenseIndex = headers.findIndex(header => ['phylic', 'clinicianlicense', 'licensenumber', 'license'].includes(header));
            const specialtyIndex = headers.findIndex(header => header.includes('specialty') || header.includes('speciality'));
            if (licenseIndex < 0 || specialtyIndex < 0) continue;
            for (let dataIndex = rowIndex + 1; dataIndex < matrix.length; dataIndex += 1) {
              const row = matrix[dataIndex] || [];
              const license = normalizeClinician(row[licenseIndex]);
              const specialty = String(row[specialtyIndex] || '').trim();
              if (license && specialty && !map.has(license)) map.set(license, specialty);
            }
            if (map.size) return map;
          }
        }
      }
    } catch (error) {
      console.warn('[MODIFIERS] Could not load ClinicianLicenses.xlsx:', error);
    }
    try {
      const response = await fetch('../json/clinician_licenses.json');
      if (!response.ok) return map;
      const data = await response.json();
      (Array.isArray(data) ? data : []).forEach(row => {
        const license = normalizeClinician(row?.['Phy Lic'] || row?.['Clinician License'] || row?.License);
        const specialty = String(row?.Specialty || row?.Speciality || '').trim();
        if (license && specialty && !map.has(license)) map.set(license, specialty);
      });
    } catch (error) {
      console.warn('[MODIFIERS] Could not load clinician specialty JSON:', error);
    }
    return map;
  }

  function buildMissingMandatoryModifierRecords(xmlData, minorProcedureRules, modifierFactorRules) {
    const existing = new Set(xmlData.records.map(record => `${record.ClaimID}|${record.ActivityID}|${record.Modifier}`));
    const synthetic = [];
    for (const [claimID, activities] of xmlData.claimActivities.entries()) {
      const hasPricedConsultation = activities.some(activity => isConsultationCode(activity.activityCode) && Number(activity.net || 0) > 0);
      const requires25 = activities.some(activity => {
        const rule = minorProcedureRules.get(normalizeCode(activity.activityCode));
        return /25/.test(String(rule?.modifiers || ''));
      });
      if (requires25 && hasPricedConsultation) {
        const consultation = activities.find(activity => isConsultationCode(activity.activityCode) && Number(activity.net || 0) > 0);
        if (consultation && !existing.has(`${claimID}|${consultation.activityID}|25`)) {
          synthetic.push({
            ClaimID: claimID, MemberID: consultation.memberID, ActivityID: consultation.activityID, Date: consultation.date,
            OrderingClinician: consultation.orderingClinician, OrderingClinicianRaw: consultation.orderingClinicianRaw,
            PerformingClinician: consultation.performingClinician, PerformingClinicianRaw: consultation.performingClinicianRaw,
            Modifier: '25', ActivityCode: consultation.activityCode, Quantity: consultation.quantity, Net: consultation.net,
            ReceiverID: consultation.receiverID, PayerID: consultation.payerID,
            FacilityID: consultation.facilityID, PriorAuthorizationID: consultation.priorAuthorizationID,
            Insurer: xmlData.receiver?.insurer || 'Unknown',
            ObsCode: '', ObsValueType: '', VOINumber: '', MissingModifier: true,
            MissingRemark: `Modifier 25 is required on E/M ${consultation.activityCode} because a minor procedure is present.`
          });
        }
      }
      activities.forEach(activity => {
        const rule = minorProcedureRules.get(normalizeCode(activity.activityCode));
        if (!/50/.test(String(rule?.modifiers || ''))) return;

        const baseModifierPrice = Number(rule?.claimed_amount_1_5);
        if (!Number.isFinite(baseModifierPrice)) return;

        const factor = findModifierFactor(
          modifierFactorRules,
          activity.facilityID,
          activity.activityCode,
          activity.receiverID,
          activity.priorAuthorizationID
        );
        const expected = Math.round((baseModifierPrice * factor + Number.EPSILON) * 100) / 100;

        if (!moneyEqual(activity.net, expected) || existing.has(`${claimID}|${activity.activityID}|50`)) return;

        synthetic.push({
          ClaimID: claimID, MemberID: activity.memberID, ActivityID: activity.activityID, Date: activity.date,
          OrderingClinician: activity.orderingClinician, OrderingClinicianRaw: activity.orderingClinicianRaw,
          PerformingClinician: activity.performingClinician, PerformingClinicianRaw: activity.performingClinicianRaw,
          Modifier: '50', ActivityCode: activity.activityCode, Quantity: activity.quantity, Net: activity.net,
          ReceiverID: activity.receiverID, PayerID: activity.payerID,
          FacilityID: activity.facilityID, PriorAuthorizationID: activity.priorAuthorizationID,
          Insurer: xmlData.receiver?.insurer || 'Unknown',
          ObsCode: '', ObsValueType: '', VOINumber: '', MissingModifier: true,
          MissingRemark:
            `Modifier 50 is required on ${activity.activityCode} because the factored 1.5 quantity price ` +
            `${expected} is being claimed (base ${baseModifierPrice} × factor ${factor}).`
        });
      });
    }
    return synthetic;
  }

  async function runModifiersCheck(options) {
    const config = options || {};
    const xmlFile = resolveInputFile('xml-file', 'xml', config.xmlFile);
    const eligibilityFile = resolveInputFile('xlsx-file', 'eligibility', config.eligibilityFile);

    if (!xmlFile || !eligibilityFile) {
      const missing = [
        !xmlFile ? 'XML file' : '',
        !eligibilityFile ? 'Eligibility workbook' : ''
      ].filter(Boolean).join(' and ');

      const error = new Error(`${missing} is required.`);
      updateMessage(error.message, true);
      return createErrorWrapper(error);
    }

    updateMessage('Checking CPT modifiers...', false);

    try {
      const [xmlText, eligibilityBuffer, minorProcedureData, clinicianSpecialtyMap, medicalPricingMap, modifierFactorRules] = await Promise.all([
        readFileText(xmlFile),
        readFileArrayBuffer(eligibilityFile),
        loadMinorProcedureData(),
        loadClinicianSpecialtyMap(),
        loadMedicalPricingMap(),
        loadModifierFactorRules()
      ]);

      const { codes: minorProcedureCodes, rules: minorProcedureRules } = minorProcedureData;
      const xmlDoc = parseXml(xmlText);
      const eligibility = parseEligibilityWorkbook(eligibilityFile, eligibilityBuffer);
      const matcher = buildEligibilityMatcher(eligibility.rows);
      const xmlData = collectXmlData(xmlDoc);
      xmlData.records.push(...buildMissingMandatoryModifierRecords(
        xmlData,
        minorProcedureRules,
        modifierFactorRules
      ));
      const claimContext = buildClaimModifierContext(xmlData.claimActivities, minorProcedureCodes, xmlData.claimDiagnoses);
      const claimEligibilityMatches = resolveClaimEligibilityMatches(
        xmlData.records,
        xmlData.claimActivities,
        matcher
      );

      const results = xmlData.records.map((record) =>
        analyzeRecord(
          record,
          claimEligibilityMatches.get(record.ClaimID) || null,
          xmlData.receiver,
          claimContext,
          minorProcedureCodes,
          minorProcedureRules,
          clinicianSpecialtyMap,
          medicalPricingMap,
          modifierFactorRules
        )
      );

      lastResults = results;
      lastWorkbook = buildResultsWorkbook(results);
      root._lastModifierResults = results;
      root._lastModifierEligibilityRows = results.map((result) => result.EligibilityRow);
      updateDownloadButton();
      updateMessage(
        `Modifier check completed using Header ReceiverID ${xmlData.receiverID || '(missing)'}.`,
        false
      );

      return createResultsWrapper(results, xmlData);
    } catch (error) {
      console.error('[MODIFIERS] Checker failed:', error);
      lastResults = [];
      lastWorkbook = null;
      root._lastModifierResults = [];
      updateDownloadButton();
      updateMessage(error?.message || String(error), true);
      return createErrorWrapper(error);
    }
  }

  async function handleStandaloneRun() {
    const wrapper =
      await runModifiersCheck();

    const output =
      getScopedElement(
        'outputTableContainer'
      )
      || getScopedElement(
        'results'
      );

    if (output) {
      output.innerHTML = '';

      output.appendChild(
        wrapper
      );
    }
  }

  function bindStandaloneListeners() {
    if (standaloneBound) {
      return;
    }

    const runButton =
      getScopedElement(
        'run-button'
      );

    const downloadButton =
      getScopedElement(
        'download-button'
      );

    if (
      runButton
      && !runButton.dataset
        .modifierBound
    ) {
      runButton.dataset
        .modifierBound = '1';

      runButton.addEventListener(
        'click',
        handleStandaloneRun
      );
    }

    if (
      downloadButton
      && !downloadButton.dataset
        .modifierBound
    ) {
      downloadButton.dataset
        .modifierBound = '1';

      downloadButton.addEventListener(
        'click',
        () => {
          try {
            downloadModifierResults();
          } catch (error) {
            updateMessage(
              error?.message
              || String(error),
              true
            );
          }
        }
      );
    }

    standaloneBound =
      Boolean(
        runButton
        || downloadButton
      );
  }

  root.runModifiersCheck =
    runModifiersCheck;

  root.downloadModifierResults =
    downloadModifierResults;

  root.showModifierEligibility =
    showModifierEligibility;

  root.closeModifierEligibilityModal =
    closeModifierEligibilityModal;

  root.refreshModifierClaimIds =
    refreshModifierClaimIds;

  root.ModifierChecker =
    Object.freeze({
      RECEIVER_CONFIG,
      MODIFIER_RULES,
      ELIGIBILITY_HEADERS,
      normalizeMemberId,
      normalizeDate,
      normalizeClinician,
      parseEligibilityWorkbook,
      buildEligibilityMatcher,
      resolveClaimEligibilityMatches,
      collectXmlData,
      refreshModifierClaimIds,
      runModifiersCheck
    });

  if (
    document.readyState
    === 'loading'
  ) {
    document.addEventListener(
      'DOMContentLoaded',
      bindStandaloneListeners,
      {
        once: true
      }
    );
  } else {
    bindStandaloneListeners();
  }
})(
  typeof window !== 'undefined'
    ? window
    : globalThis
);
