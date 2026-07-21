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

  const ELIGIBILITY_HEADERS = Object.freeze({
    member: 'Card Number / DHA Member ID',
    date: 'Ordered On',
    clinician: 'Clinician',
    voi: 'VOI Number'
  });

  let lastResults = [];
  let lastWorkbook = null;
  let standaloneBound = false;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalizeIdentifier(value) {
    return String(value == null ? '' : value).trim().toUpperCase();
  }

  function normalizeMemberId(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/^0+(?=\d)/, '');
  }

  function normalizeClinician(value) {
    return normalizeIdentifier(value).replace(/\s+/g, '');
  }

  function normalizeCode(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/^0+(?=\d)/, '');
  }

  function normForCompare(value) {
    return normalizeIdentifier(value).replace(/[^A-Z0-9]/g, '');
  }

  function isConsultationCode(code) {
    return /^(92|992)/.test(String(code || '').trim());
  }

  function getDirectChildren(parent, tagName) {
    if (!parent || !parent.childNodes) return [];

    return Array.from(parent.childNodes).filter((node) => {
      if (!node || node.nodeType !== 1) return false;
      return (node.localName || node.nodeName) === tagName;
    });
  }

  function getDirectChildText(parent, tagName) {
    const child = getDirectChildren(parent, tagName)[0];

    return child
      ? String(child.textContent || '').trim()
      : '';
  }

  function firstDirectChildText(parent, tagNames) {
    for (const tagName of tagNames) {
      const value = getDirectChildText(parent, tagName);

      if (value) return value;
    }

    return '';
  }

  function getModifierContainer() {
    return document.getElementById('checker-container-modifiers');
  }

  function getScopedElement(id) {
    const container = getModifierContainer();

    return (
      (container && container.querySelector(`#${id}`))
      || document.getElementById(id)
    );
  }

  function resolveInputFile(id, cacheKey, explicitFile) {
    if (explicitFile) return explicitFile;

    const input = getScopedElement(id);

    return (
      input?.files?.[0]
      || root.unifiedCheckerFiles?.[cacheKey]
      || null
    );
  }

  function updateMessage(text, isError) {
    const messageBox = getScopedElement('messageBox');

    if (!messageBox) return;

    messageBox.textContent = text || '';
    messageBox.style.color = isError ? '#b42318' : '';
  }

  function updateDownloadButton() {
    const button = getScopedElement('download-button');

    if (!button) return;

    button.disabled = lastResults.length === 0;
    button.style.display = lastResults.length ? '' : 'none';
  }

  async function readFileText(file) {
    if (!file) {
      throw new Error('XML file is missing.');
    }

    if (typeof file.text === 'function') {
      return file.text();
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        resolve(String(reader.result || ''));
      };

      reader.onerror = () => {
        reject(
          reader.error
          || new Error('Failed to read XML file.')
        );
      };

      reader.readAsText(file);
    });
  }

  async function readFileArrayBuffer(file) {
    if (!file) {
      throw new Error('Eligibility workbook is missing.');
    }

    if (typeof file.arrayBuffer === 'function') {
      return file.arrayBuffer();
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader();

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

      reader.readAsArrayBuffer(file);
    });
  }

  function parseXml(text) {
    const safeXml = String(text || '').replace(
      /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g,
      'and'
    );

    const xmlDoc = new DOMParser().parseFromString(
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
      || xmlDoc.documentElement.nodeName
        !== 'Claim.Submission'
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

    if (root.XLSX?.SSF?.parse_date_code) {
      const parsed =
        root.XLSX.SSF.parse_date_code(
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
        (serial - 25569)
        * 86400
        * 1000
      )
    );
  }

  function dateToKey(date) {
    if (
      !(date instanceof Date)
      || Number.isNaN(date.getTime())
    ) {
      return '';
    }

    const year = date.getFullYear();

    const month = String(
      date.getMonth() + 1
    ).padStart(2, '0');

    const day = String(
      date.getDate()
    ).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }

  function normalizeDate(value) {
    if (
      value == null
      || value === ''
    ) {
      return '';
    }

    if (value instanceof Date) {
      return dateToKey(value);
    }

    if (typeof value === 'number') {
      const parsed =
        excelSerialToDate(value);

      return parsed
        ? dateToKey(parsed)
        : '';
    }

    const raw =
      String(value).trim();

    if (!raw) return '';

    const dateOnly =
      raw.split(/[ T]/)[0];

    let match = dateOnly.match(
      /^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)$/
    );

    if (match) {
      return (
        `${match[1]}-`
        + `${String(Number(match[2])).padStart(2, '0')}-`
        + String(Number(match[3])).padStart(2, '0')
      );
    }

    match = dateOnly.match(
      /^([0-3]?\d)[-\/]([01]?\d)[-\/](\d{2}|\d{4})$/
    );

    if (match) {
      const year =
        match[3].length === 2
          ? 2000 + Number(match[3])
          : Number(match[3]);

      return (
        `${year}-`
        + `${String(Number(match[2])).padStart(2, '0')}-`
        + String(Number(match[1])).padStart(2, '0')
      );
    }

    const parsed = new Date(raw);

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

  function parseEligibilityWorkbook(
    workbookFile,
    arrayBuffer
  ) {
    if (
      !root.XLSX
      || typeof root.XLSX.read
        !== 'function'
    ) {
      throw new Error(
        'SheetJS (XLSX) is unavailable.'
      );
    }

    const workbook =
      root.XLSX.read(
        arrayBuffer,
        {
          type: 'array',
          cellDates: true
        }
      );

    const sheetName =
      workbook.SheetNames?.[0];

    if (!sheetName) {
      throw new Error(
        'Eligibility workbook contains no worksheet.'
      );
    }

    const worksheet =
      workbook.Sheets[sheetName];

    /*
     * Established Eligibility format:
     * row 1 contains report metadata;
     * workbook headers begin on row 2.
     */
    const sourceRows =
      root.XLSX.utils.sheet_to_json(
        worksheet,
        {
          defval: '',
          range: 1,
          raw: true,
          blankrows: false
        }
      );

    if (!sourceRows.length) {
      throw new Error(
        'Eligibility workbook contains no data rows.'
      );
    }

    const headers = Array.from(
      new Set(
        sourceRows.flatMap(
          (row) =>
            Object.keys(row || {})
        )
      )
    );

    const memberHeader =
      resolveExactHeader(
        headers,
        ELIGIBILITY_HEADERS.member
      );

    const dateHeader =
      resolveExactHeader(
        headers,
        ELIGIBILITY_HEADERS.date
      );

    const clinicianHeader =
      resolveExactHeader(
        headers,
        ELIGIBILITY_HEADERS.clinician
      );

    const voiHeader =
      resolveExactHeader(
        headers,
        ELIGIBILITY_HEADERS.voi
      );

    const missing = [];

    if (!memberHeader) {
      missing.push(
        ELIGIBILITY_HEADERS.member
      );
    }

    if (!dateHeader) {
      missing.push(
        ELIGIBILITY_HEADERS.date
      );
    }

    if (!clinicianHeader) {
      missing.push(
        ELIGIBILITY_HEADERS.clinician
      );
    }

    if (!voiHeader) {
      missing.push(
        ELIGIBILITY_HEADERS.voi
      );
    }

    if (missing.length) {
      throw new Error(
        `Eligibility workbook is missing required column${
          missing.length === 1
            ? ''
            : 's'
        }: ${missing.join(', ')}.`
      );
    }

    const rows =
      sourceRows.map(
        (sourceRow, index) => ({
          sourceRow,
          sheetName,

          /*
           * Because headers are on Excel row 2,
           * the first data row is Excel row 3.
           */
          sheetRowNumber:
            index + 3,

          memberID:
            normalizeMemberId(
              sourceRow[memberHeader]
            ),

          orderedOn:
            normalizeDate(
              sourceRow[dateHeader]
            ),

          clinician:
            normalizeClinician(
              sourceRow[
                clinicianHeader
              ]
            ),

          voiNumber:
            String(
              sourceRow[voiHeader]
              == null
                ? ''
                : sourceRow[
                    voiHeader
                  ]
            ).trim(),

          used: false
        })
      );

    return {
      workbook,
      sheetName,
      rows
    };
  }

  function buildEligibilityMatcher(
    rows
  ) {
    const index = new Map();

    for (const row of rows) {
      const key = [
        row.memberID,
        row.orderedOn,
        row.clinician
      ].join('|');

      if (!index.has(key)) {
        index.set(key, []);
      }

      index.get(key).push(row);
    }

    return {
      find(
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

        /*
         * Eligibility rows are single-use.
         * Do not reuse one eligibility row for
         * multiple modifier activities.
         */
        const match =
          candidates.find(
            (row) => !row.used
          )
          || null;

        if (match) {
          match.used = true;
        }

        return match;
      },

      index
    };
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
    const rootElement =
      xmlDoc.documentElement;

    const header =
      getDirectChildren(
        rootElement,
        'Header'
      )[0];

    /*
     * ReceiverID determines insurer routing.
     * Claim-level PayerID remains separate
     * claim metadata.
     */
    const receiverID =
      normalizeIdentifier(
        getDirectChildText(
          header,
          'ReceiverID'
        )
      );

    const receiver =
      RECEIVER_CONFIG[
        receiverID
      ]
      || null;

    const records = [];
    const claimActivities =
      new Map();

    for (
      const claim
      of getDirectChildren(
        rootElement,
        'Claim'
      )
    ) {
      const claimID =
        getDirectChildText(
          claim,
          'ID'
        )
        || 'Unknown';

      const memberID =
        normalizeMemberId(
          getDirectChildText(
            claim,
            'MemberID'
          )
        );

      const claimPayerID =
        normalizeIdentifier(
          getDirectChildText(
            claim,
            'PayerID'
          )
        );

      const encounter =
        getDirectChildren(
          claim,
          'Encounter'
        )[0]
        || getDirectChildren(
          claim,
          'Encounte'
        )[0];

      /*
       * Restore the established matching date:
       * XML Encounter date, not Activity date.
       */
      const encounterDate =
        normalizeDate(
          firstDirectChildText(
            encounter,
            [
              'Date',
              'Start',
              'EncounterDate'
            ]
          )
        );

      const activities = [];

      for (
        const activity
        of getDirectChildren(
          claim,
          'Activity'
        )
      ) {
        const activityID =
          getDirectChildText(
            activity,
            'ID'
          );

        const activityCode =
          getDirectChildText(
            activity,
            'Code'
          );

        const quantity =
          Number(
            getDirectChildText(
              activity,
              'Quantity'
            )
            || 0
          );

        const net =
          Number(
            getDirectChildText(
              activity,
              'Net'
            )
            || 0
          );

        /*
         * Restore the established clinician:
         * Eligibility is matched against the
         * XML Ordering Clinician only.
         */
        const orderingClinicianRaw =
          firstDirectChildText(
            activity,
            [
              'OrderingClnician',
              'OrderingClinician',
              'Ordering_Clinician',
              'OrderingClin'
            ]
          );

        const orderingClinician =
          normalizeClinician(
            orderingClinicianRaw
          );

        activities.push({
          claimID,
          activityID,
          activityCode,
          quantity,
          net,
          orderingClinician,
          orderingClinicianRaw
        });

        for (
          const observation
          of getDirectChildren(
            activity,
            'Observation'
          )
        ) {
          const valueType =
            getDirectChildText(
              observation,
              'ValueType'
            );

          /*
           * CRITICAL:
           *
           * Check ValueType BEFORE examining
           * the observation Value.
           *
           * LOINC observations may legitimately
           * contain values 24, 25, 50, or 52.
           * They are not modifier observations.
           */
          if (
            String(
              valueType || ''
            )
              .trim()
              .toLowerCase()
            !== 'modifiers'
          ) {
            continue;
          }

          const rawValue =
            firstDirectChildText(
              observation,
              [
                'Value',
                'ValueText'
              ]
            );

          const modifier =
            parseModifierValue(
              rawValue
            );

          if (
            !modifier
            || !MODIFIER_RULES[
              modifier
            ]
          ) {
            continue;
          }

          const observationCode =
            getDirectChildText(
              observation,
              'Code'
            );

          records.push({
            ClaimID: claimID,
            MemberID: memberID,
            ActivityID: activityID,
            Date: encounterDate,

            OrderingClinician:
              orderingClinician,

            OrderingClinicianRaw:
              orderingClinicianRaw,

            Modifier: modifier,
            ActivityCode:
              activityCode,

            Quantity: quantity,
            Net: net,

            ReceiverID:
              receiverID,

            PayerID:
              claimPayerID,

            Insurer:
              receiver?.insurer
              || 'Unknown',

            ObsCode:
              observationCode,

            ObsValueType:
              valueType,

            VOINumber:
              String(
                rawValue || ''
              ).trim()
          });
        }
      }

      claimActivities.set(
        claimID,
        activities
      );
    }

    const seen = new Set();

    const uniqueRecords =
      records.filter(
        (record) => {
          const key = [
            record.ClaimID,
            record.ActivityID,
            record.MemberID,
            record.Modifier,
            record.ObsCode
          ].join('|');

          if (seen.has(key)) {
            return false;
          }

          seen.add(key);
          return true;
        }
      );

    return {
      receiverID,
      receiver,
      records:
        uniqueRecords,
      claimActivities
    };
  }

  function buildClaimModifierContext(
    claimActivities,
    minorProcedureCodes
  ) {
    const context =
      new Map();

    for (
      const [
        claimID,
        activities
      ]
      of claimActivities.entries()
    ) {
      const claimContext = {
        hasMinorProcedure: false,
        hasPricedConsultation:
          false
      };

      for (
        const activity
        of activities
      ) {
        const normalizedActivityCode =
          normalizeCode(
            activity.activityCode
          );

        if (
          minorProcedureCodes.has(
            normalizedActivityCode
          )
        ) {
          claimContext
            .hasMinorProcedure = true;
        }

        if (
          isConsultationCode(
            activity.activityCode
          )
          && Number(
            activity.net || 0
          ) > 0
        ) {
          claimContext
            .hasPricedConsultation =
              true;
        }
      }

      context.set(
        claimID,
        claimContext
      );
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

  function analyzeRecord(
    record,
    matcher,
    receiver,
    claimContext,
    minorProcedureCodes
  ) {
    const remarks = [];
    let unknownPayer = false;

    if (!record.ReceiverID) {
      unknownPayer = true;

      remarks.push(
        'ReceiverID is missing from the XML Header; modifier payer rules could not be determined.'
      );
    } else if (!receiver) {
      unknownPayer = true;

      remarks.push(
        `Modifier rules are not configured for ReceiverID ${record.ReceiverID}.`
      );
    }

    /*
     * This check applies only after the
     * observation was confirmed to have
     * ValueType = Modifiers.
     */
    if (
      record.ObsCode
      !== 'CPT modifier'
    ) {
      remarks.push(
        'Observation Code incorrect; '
        + 'expected "CPT modifier" '
        + `but found "${
          record.ObsCode
          || '(blank)'
        }".`
      );
    }

    /*
     * Restore exact established matching:
     *
     * MemberID
     * + Encounter date
     * + Ordering Clinician
     *
     * Each eligibility row is single-use.
     */
    const eligibilityMatch =
      matcher.find(
        record.MemberID,
        record.Date,
        record.OrderingClinician
      );

    const voiNumber =
      eligibilityMatch
        ? String(
            eligibilityMatch
              .voiNumber
            || ''
          ).trim()
        : String(
            record.VOINumber
            || ''
          ).trim();

    if (!eligibilityMatch) {
      remarks.push(
        'No matching eligibility found.'
      );
    }

    const rule =
      MODIFIER_RULES[
        record.Modifier
      ];

    if (
      record.Modifier === '24'
      || record.Modifier === '52'
    ) {
      if (
        !voiMatchesModifier(
          record.Modifier,
          voiNumber
        )
      ) {
        remarks.push(
          `Modifier ${record.Modifier} `
          + 'does not match VOI '
          + `(expected ${
            rule.expectedVOI
          }).`
        );
      }
    }

    if (
      Number(record.Quantity)
      !== 1
    ) {
      remarks.push(
        'Qty must be 1 for modifiers.'
      );
    }

    if (
      rule.consultationOnly
      && !isConsultationCode(
        record.ActivityCode
      )
    ) {
      remarks.push(
        `Modifier ${record.Modifier} `
        + 'must only be on '
        + 'consultation codes.'
      );
    }

    const currentClaimContext =
      claimContext.get(
        record.ClaimID
      )
      || {
        hasMinorProcedure:
          false,

        hasPricedConsultation:
          false
      };

    if (
      record.Modifier === '25'
    ) {
      if (
        !currentClaimContext
          .hasMinorProcedure
      ) {
        remarks.push(
          'Modifier 25 requires a minor procedure in the same claim.'
        );
      }

      if (
        !currentClaimContext
          .hasPricedConsultation
      ) {
        remarks.push(
          'Modifier 25 requires a consultation code with price in the same claim.'
        );
      }
    }

    if (
      record.Modifier === '50'
      && !minorProcedureCodes.has(
        normalizeCode(
          record.ActivityCode
        )
      )
    ) {
      remarks.push(
        `Modifier 50 cannot be used on \`${
          record.ActivityCode
          || '(unknown)'
        }\`.`
      );
    }

    let status = 'Valid';

    /*
     * Unsupported/missing ReceiverID alone
     * produces Unknown. Any actual modifier,
     * eligibility, quantity, or code error
     * remains Invalid.
     */
    const substantiveRemarks =
      remarks.filter(
        (remark) =>
          !remark.startsWith(
            'ReceiverID is missing'
          )
          && !remark.startsWith(
            'Modifier rules are not configured'
          )
      );

    if (
      substantiveRemarks.length
    ) {
      status = 'Invalid';
    } else if (unknownPayer) {
      status = 'Unknown';
    }

    return {
      ...record,

      VOINumber:
        voiNumber,

      EligibilityRow:
        eligibilityMatch
          ?.sourceRow
        || null,

      EligibilitySheet:
        eligibilityMatch
          ?.sheetName
        || '',

      EligibilityRowNumber:
        eligibilityMatch
          ?.sheetRowNumber
        || '',

      Status: status,
      valid:
        status === 'Valid',

      Remarks:
        remarks.join(' ')
        || 'OK'
    };
  }

  function createResultsWrapper(
    results,
    context
  ) {
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
      `<strong>Modifier results:</strong> `
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
        (result, index) => {
          const row =
            document.createElement(
              'tr'
            );

          row.className =
            result.Status
              === 'Invalid'
              ? 'table-danger invalid-row invalid'
              : result.Status
                === 'Unknown'
                ? 'table-warning unknown-row unknown'
                : 'table-success valid-row valid';

          row.dataset.index =
            String(index);

          row.dataset.status =
            result.Status
              .toLowerCase();

          const showClaim =
            result.ClaimID
            !== previousClaim;

          const showMember =
            showClaim
            || result.MemberID
              !== previousMember;

          const showActivity =
            showClaim
            || result.ActivityID
              !== previousActivity;

          row.innerHTML = `
            <td>${
              showClaim
                ? escapeHtml(
                    result.ClaimID
                  )
                : ''
            }</td>

            <td>${
              showMember
                ? escapeHtml(
                    result.MemberID
                  )
                : ''
            }</td>

            <td>${
              showActivity
                ? escapeHtml(
                    result.ActivityID
                  )
                : ''
            }</td>

            <td>${
              escapeHtml(
                result
                  .OrderingClinicianRaw
                || result
                  .OrderingClinician
              )
            }</td>

            <td>${
              escapeHtml(
                result.ActivityCode
              )
            }</td>

            <td>${
              escapeHtml(
                result.Quantity
              )
            }</td>

            <td>${
              escapeHtml(
                result.Net
              )
            }</td>

            <td>${
              escapeHtml(
                result.ObsCode
              )
            }</td>

            <td>${
              escapeHtml(
                result.Modifier
              )
            }</td>

            <td>${
              escapeHtml(
                result.VOINumber
              )
            }</td>

            <td>${
              escapeHtml(
                result.ReceiverID
              )
            }</td>

            <td>${
              escapeHtml(
                result.PayerID
              )
            }</td>

            <td>${
              escapeHtml(
                result.Insurer
              )
            }</td>

            <td>${
              escapeHtml(
                result.Status
              )
            }</td>

            <td>${
              escapeHtml(
                result.Remarks
              )
            }</td>

            <td>${
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
            }</td>
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

    responsive.appendChild(
      table
    );

    wrapper.appendChild(
      responsive
    );

    return wrapper;
  }

  function createErrorWrapper(
    error
  ) {
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

    wrapper.appendChild(
      alert
    );

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

    wrapper.appendChild(
      table
    );

    return wrapper;
  }

  function closeModifierEligibilityModal() {
    document
      .getElementById(
        'modifierEligibilityModal'
      )
      ?.remove();
  }

  function showModifierEligibility(
    index
  ) {
    const result =
      lastResults[
        Number(index)
      ];

    if (
      !result
      ?.EligibilityRow
    ) {
      alert(
        'No eligibility data found for this modifier activity.'
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

  function makeExportRows(
    results
  ) {
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

  function buildResultsWorkbook(
    results
  ) {
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

  async function loadMinorProcedureCodes() {
    try {
      const response =
        await fetch(
          '../json/minor_procedures.json'
        );

      if (!response.ok) {
        return new Set();
      }

      const data =
        await response.json();

      return new Set(
        (
          Array.isArray(data)
            ? data
            : []
        )
          .map(
            (item) =>
              normalizeCode(
                typeof item
                  === 'string'
                  ? item
                  : item?.code
              )
          )
          .filter(Boolean)
      );
    } catch (error) {
      console.warn(
        '[MODIFIERS] Could not load minor_procedures.json:',
        error
      );

      return new Set();
    }
  }

  async function runModifiersCheck(
    options
  ) {
    const config =
      options || {};

    const xmlFile =
      resolveInputFile(
        'xml-file',
        'xml',
        config.xmlFile
      );

    const eligibilityFile =
      resolveInputFile(
        'xlsx-file',
        'eligibility',
        config.eligibilityFile
      );

    if (
      !xmlFile
      || !eligibilityFile
    ) {
      const missing = [
        !xmlFile
          ? 'XML file'
          : '',

        !eligibilityFile
          ? 'Eligibility workbook'
          : ''
      ]
        .filter(Boolean)
        .join(' and ');

      const error =
        new Error(
          `${missing} is required.`
        );

      updateMessage(
        error.message,
        true
      );

      return createErrorWrapper(
        error
      );
    }

    updateMessage(
      'Checking CPT modifiers...',
      false
    );

    try {
      const [
        xmlText,
        eligibilityBuffer,
        minorProcedureCodes
      ] = await Promise.all([
        readFileText(
          xmlFile
        ),

        readFileArrayBuffer(
          eligibilityFile
        ),

        loadMinorProcedureCodes()
      ]);

      const xmlDoc =
        parseXml(xmlText);

      const eligibility =
        parseEligibilityWorkbook(
          eligibilityFile,
          eligibilityBuffer
        );

      const matcher =
        buildEligibilityMatcher(
          eligibility.rows
        );

      const xmlData =
        collectXmlData(
          xmlDoc
        );

      const claimContext =
        buildClaimModifierContext(
          xmlData.claimActivities,
          minorProcedureCodes
        );

      const results =
        xmlData.records.map(
          (record) =>
            analyzeRecord(
              record,
              matcher,
              xmlData.receiver,
              claimContext,
              minorProcedureCodes
            )
        );

      lastResults =
        results;

      lastWorkbook =
        buildResultsWorkbook(
          results
        );

      root._lastModifierResults =
        results;

      root._lastModifierEligibilityRows =
        results.map(
          (result) =>
            result.EligibilityRow
        );

      updateDownloadButton();

      updateMessage(
        'Modifier check completed '
        + 'using Header ReceiverID '
        + `${
          xmlData.receiverID
          || '(missing)'
        }.`,
        false
      );

      return createResultsWrapper(
        results,
        xmlData
      );
    } catch (error) {
      console.error(
        '[MODIFIERS] Checker failed:',
        error
      );

      lastResults = [];
      lastWorkbook = null;

      root._lastModifierResults =
        [];

      updateDownloadButton();

      updateMessage(
        error?.message
        || String(error),
        true
      );

      return createErrorWrapper(
        error
      );
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
      collectXmlData,
      runModifiersCheck
    });

  if (
    document.readyState
    === 'loading'
  ) {
    document.addEventListener(
      'DOMContentLoaded',
      bindStandaloneListeners,
      { once: true }
    );
  } else {
    bindStandaloneListeners();
  }
})(
  typeof window
    !== 'undefined'
    ? window
    : globalThis
);
