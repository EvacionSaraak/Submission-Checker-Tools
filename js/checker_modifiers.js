(function (root) {
  'use strict';

  const RECEIVER_CONFIG = Object.freeze({
    D001: Object.freeze({ insurer: 'Thiqa' }),
    A001: Object.freeze({ insurer: 'Daman Enhanced' }),
    D004: Object.freeze({ insurer: 'Daman Basic' })
  });

  const MODIFIER_RULES = Object.freeze({
    '24': Object.freeze({ expectedVOI: 'VOI_D' }),
    '52': Object.freeze({ expectedVOI: 'VOI_EF1' })
  });

  const HEADER_ALIASES = Object.freeze({
    memberID: Object.freeze([
      'cardnumber', 'cardno', 'memberid', 'membernumber', 'memberno',
      'patientcardnumber', 'dhamemberid', 'member'
    ]),
    orderedOn: Object.freeze([
      'orderedon', 'eligibilitydate', 'servicedate', 'encounterdate',
      'visitdate', 'transactiondate', 'date', 'admregdate', 'admissiondate'
    ]),
    clinician: Object.freeze([
      'clinician', 'clinicianlicense', 'doctorlicense', 'physicianlicense',
      'performingclinician', 'orderingclinician', 'providerlicense',
      'practitionerlicense', 'license'
    ]),
    voi: Object.freeze([
      'voi', 'voinumber', 'verificationofinsurance', 'verificationinsurance',
      'volumeofinsurance', 'volume', 'vol', 'benefitvoi'
    ])
  });

  let lastResults = [];
  let listenersBound = false;

  function normalizeHeader(value) {
    return String(value == null ? '' : value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function normalizeIdentifier(value) {
    return String(value == null ? '' : value).trim().toUpperCase();
  }

  function normalizeMemberID(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';

    const compact = raw.replace(/\s+/g, '');
    if (/^\d+$/.test(compact)) {
      return compact.replace(/^0+(?=\d)/, '');
    }

    return compact.toUpperCase();
  }

  function normalizeClinician(value) {
    return normalizeIdentifier(value).replace(/\s+/g, '');
  }

  function normalizeObservationCode(value) {
    return normalizeHeader(value);
  }

  function normalizeVoi(value) {
    return normalizeIdentifier(value)
      .replace(/[\s\-\/]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
    return child && child.textContent ? child.textContent.trim() : '';
  }

  function getVisibleModifierContainer() {
    const container = document.getElementById('checker-container-modifiers');
    if (container) return container;
    return null;
  }

  function getScopedElement(id) {
    const container = getVisibleModifierContainer();
    return (container && container.querySelector(`#${id}`)) || document.getElementById(id);
  }

  function resolveInputFile(id, cacheKey, explicitFile) {
    if (explicitFile) return explicitFile;
    const input = getScopedElement(id);
    return input?.files?.[0] || root.unifiedCheckerFiles?.[cacheKey] || null;
  }

  async function readFileText(file) {
    if (!file) throw new Error('XML file is missing.');
    if (typeof file.text === 'function') return file.text();

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Unable to read XML file.'));
      reader.readAsText(file);
    });
  }

  async function readFileArrayBuffer(file) {
    if (!file) throw new Error('Eligibility workbook is missing.');
    if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Unable to read eligibility workbook.'));
      reader.readAsArrayBuffer(file);
    });
  }

  function parseXml(xmlText) {
    const safeXml = String(xmlText || '').replace(
      /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g,
      'and'
    );
    const xmlDoc = new DOMParser().parseFromString(safeXml, 'application/xml');
    const parserError = xmlDoc.getElementsByTagName('parsererror')[0];

    if (parserError) {
      throw new Error('XML Parsing Error: The file is not well-formed.');
    }

    if (!xmlDoc.documentElement || xmlDoc.documentElement.nodeName !== 'Claim.Submission') {
      throw new Error('Modifier checker requires a Claim.Submission XML file.');
    }

    return xmlDoc;
  }

  function excelSerialToDate(serial) {
    if (!Number.isFinite(serial)) return null;

    if (root.XLSX?.SSF?.parse_date_code) {
      const parsed = root.XLSX.SSF.parse_date_code(serial);
      if (parsed) {
        return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
      }
    }

    const utcDays = Math.floor(serial - 25569);
    return new Date(utcDays * 86400 * 1000);
  }

  function toDateKey(value) {
    if (value == null || value === '') return '';

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const year = value.getUTCFullYear();
      const month = String(value.getUTCMonth() + 1).padStart(2, '0');
      const day = String(value.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    if (typeof value === 'number') {
      const date = excelSerialToDate(value);
      return date ? toDateKey(date) : '';
    }

    const raw = String(value).trim();
    if (!raw) return '';

    let match = raw.match(/^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)/);
    if (match) {
      return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
    }

    match = raw.match(/^([0-3]?\d)[-\/]([01]?\d)[-\/](\d{4})/);
    if (match) {
      return `${match[3]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
    }

    const parsedDate = new Date(raw);
    if (!Number.isNaN(parsedDate.getTime())) {
      return toDateKey(parsedDate);
    }

    return '';
  }

  function findActualHeader(headers, aliases) {
    const normalizedAliases = new Set(aliases);
    return headers.find((header) => normalizedAliases.has(normalizeHeader(header))) || null;
  }

  function extractVoiTokens(value) {
    const raw = String(value == null ? '' : value);
    const tokens = new Set();

    raw.match(/VOI[\s_\-\/]*[A-Z0-9]+/gi)?.forEach((token) => tokens.add(normalizeVoi(token)));

    const normalizedWholeValue = normalizeVoi(raw);
    if (normalizedWholeValue) tokens.add(normalizedWholeValue);

    return Array.from(tokens);
  }

  function parseEligibilityWorkbook(workbookFile, arrayBuffer) {
    if (!root.XLSX || typeof root.XLSX.read !== 'function') {
      throw new Error('SheetJS (XLSX) is unavailable.');
    }

    const workbook = root.XLSX.read(arrayBuffer, {
      type: 'array',
      cellDates: true
    });

    if (!workbook.SheetNames?.length) {
      throw new Error('Eligibility workbook contains no worksheets.');
    }

    const rows = [];
    const warnings = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const sheetRows = root.XLSX.utils.sheet_to_json(sheet, {
        defval: '',
        raw: true,
        blankrows: false
      });

      if (sheetRows.length === 0) continue;

      const headers = Array.from(
        new Set(sheetRows.flatMap((row) => Object.keys(row || {})))
      );
      const memberHeader = findActualHeader(headers, HEADER_ALIASES.memberID);
      const dateHeader = findActualHeader(headers, HEADER_ALIASES.orderedOn);
      const clinicianHeader = findActualHeader(headers, HEADER_ALIASES.clinician);
      const voiHeader = findActualHeader(headers, HEADER_ALIASES.voi);

      if (!memberHeader || !dateHeader || !clinicianHeader) {
        warnings.push(
          `${sheetName}: could not identify all matching columns ` +
          `(Member/Card Number, Ordered On, Clinician).`
        );
      }

      sheetRows.forEach((sourceRow, rowIndex) => {
        const values = Object.values(sourceRow || {});
        let voiValue = voiHeader ? sourceRow[voiHeader] : '';

        if (!String(voiValue || '').trim()) {
          const discovered = values
            .flatMap(extractVoiTokens)
            .find((token) => token.startsWith('VOI_'));
          voiValue = discovered || '';
        }

        rows.push({
          workbookName: workbookFile?.name || '',
          sheetName,
          sheetRowNumber: rowIndex + 2,
          memberID: normalizeMemberID(memberHeader ? sourceRow[memberHeader] : ''),
          orderedOn: toDateKey(dateHeader ? sourceRow[dateHeader] : ''),
          clinician: normalizeClinician(clinicianHeader ? sourceRow[clinicianHeader] : ''),
          voiRaw: String(voiValue == null ? '' : voiValue).trim(),
          voiTokens: extractVoiTokens(voiValue),
          sourceRow
        });
      });
    }

    if (rows.length === 0) {
      throw new Error('Eligibility workbook contains no data rows.');
    }

    return { rows, warnings };
  }

  function collectModifierRecords(xmlDoc) {
    const header = getDirectChildren(xmlDoc.documentElement, 'Header')[0];
    const receiverID = normalizeIdentifier(getDirectChildText(header, 'ReceiverID'));
    const receiver = RECEIVER_CONFIG[receiverID] || null;
    const records = [];

    for (const claim of getDirectChildren(xmlDoc.documentElement, 'Claim')) {
      const claimID = getDirectChildText(claim, 'ID') || 'Unknown';
      const memberIDRaw = getDirectChildText(claim, 'MemberID');
      const claimPayerID = normalizeIdentifier(getDirectChildText(claim, 'PayerID'));
      const encounter = getDirectChildren(claim, 'Encounter')[0];
      const encounterDate = toDateKey(getDirectChildText(encounter, 'Start'));

      for (const activity of getDirectChildren(claim, 'Activity')) {
        const activityID = getDirectChildText(activity, 'ID');
        const activityDate = toDateKey(getDirectChildText(activity, 'Start')) || encounterDate;
        const code = getDirectChildText(activity, 'Code');
        const performingClinicianRaw = getDirectChildText(activity, 'Clinician');
        const orderingClinicianRaw = getDirectChildText(activity, 'OrderingClinician');
        const performingClinician = normalizeClinician(performingClinicianRaw);
        const orderingClinician = normalizeClinician(orderingClinicianRaw);

        for (const observation of getDirectChildren(activity, 'Observation')) {
          const observationValue = String(getDirectChildText(observation, 'Value')).trim();
          if (!MODIFIER_RULES[observationValue]) continue;

          const observationCode = getDirectChildText(observation, 'Code');

          records.push({
            claimID,
            receiverID,
            claimPayerID,
            insurer: receiver?.insurer || 'Unknown',
            memberIDRaw,
            memberID: normalizeMemberID(memberIDRaw),
            activityID,
            activityDate,
            code,
            performingClinicianRaw,
            orderingClinicianRaw,
            performingClinician,
            orderingClinician,
            modifier: observationValue,
            observationCode,
            observationCodeIsValid: normalizeObservationCode(observationCode) === 'cptmodifier',
            expectedVOI: MODIFIER_RULES[observationValue].expectedVOI
          });
        }
      }
    }

    return {
      receiverID,
      receiver,
      records
    };
  }

  function scoreEligibilityRow(record, row) {
    if (!record.memberID || !row.memberID || record.memberID !== row.memberID) {
      return -1;
    }

    let score = 10;

    if (record.activityDate && row.orderedOn) {
      if (record.activityDate !== row.orderedOn) return -1;
      score += 5;
    }

    const clinicianCandidates = new Set([
      record.performingClinician,
      record.orderingClinician
    ].filter(Boolean));

    if (row.clinician && clinicianCandidates.size > 0) {
      if (!clinicianCandidates.has(row.clinician)) return -1;
      score += row.clinician === record.performingClinician ? 4 : 3;
    }

    if (row.voiTokens.includes(record.expectedVOI)) score += 2;
    return score;
  }

  function findBestEligibilityMatch(record, eligibilityRows) {
    let best = null;
    let bestScore = -1;

    for (const row of eligibilityRows) {
      const score = scoreEligibilityRow(record, row);
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }

    return bestScore >= 0 ? best : null;
  }

  function analyzeModifierRecord(record, eligibilityRows, receiver) {
    const findings = [];

    if (!record.receiverID) {
      findings.push({
        status: 'Unknown',
        remark: 'ReceiverID is missing from the XML Header; modifier payer rules could not be determined.'
      });
    } else if (!receiver) {
      findings.push({
        status: 'Unknown',
        remark: `Modifier rules are not configured for ReceiverID ${record.receiverID}.`
      });
    }

    if (!record.observationCodeIsValid) {
      findings.push({
        status: 'Invalid',
        remark:
          `Modifier ${record.modifier} has Observation Code ` +
          `\`${record.observationCode || '(blank)'}\`; it must be \`CPT modifier\`.`
      });
    }

    const match = findBestEligibilityMatch(record, eligibilityRows);

    if (!match) {
      findings.push({
        status: 'Invalid',
        remark:
          `No eligibility match was found for Member ${record.memberIDRaw || '(blank)'}, ` +
          `date ${record.activityDate || '(unknown)'}, and Clinician ` +
          `${record.performingClinicianRaw || record.orderingClinicianRaw || '(blank)'}.`
      });
    } else if (!match.voiTokens.includes(record.expectedVOI)) {
      findings.push({
        status: 'Invalid',
        remark:
          `Modifier ${record.modifier} requires ${record.expectedVOI}, ` +
          `but eligibility shows ${match.voiRaw || '(blank)'}.`
      });
    }

    let status = 'Valid';
    if (findings.some((finding) => finding.status === 'Invalid')) status = 'Invalid';
    else if (findings.some((finding) => finding.status === 'Unknown')) status = 'Unknown';

    return {
      ...record,
      eligibilityMatch: match,
      actualVOI: match?.voiRaw || '',
      status,
      valid: status === 'Valid',
      findings,
      remark: findings.map((finding) => finding.remark).join('\n') || 'OK'
    };
  }

  function makeWrapper() {
    const wrapper = document.createElement('div');
    wrapper.className = 'modifier-checker-results';
    return wrapper;
  }

  function renderResults(results, context) {
    const wrapper = makeWrapper();
    const total = results.length;
    const valid = results.filter((row) => row.status === 'Valid').length;
    const invalid = results.filter((row) => row.status === 'Invalid').length;
    const unknown = results.filter((row) => row.status === 'Unknown').length;
    const percentage = total ? ((valid / total) * 100).toFixed(1) : '100.0';

    const summary = document.createElement('div');
    summary.className = 'alert alert-info modifier-summary';
    summary.innerHTML =
      `<strong>Modifier results:</strong> ${valid} valid / ${total} total (${percentage}%). ` +
      `${invalid} invalid, ${unknown} unknown. ` +
      `ReceiverID: ${escapeHtml(context.receiverID || '(missing)')} ` +
      `(${escapeHtml(context.receiver?.insurer || 'Unknown')}).`;
    wrapper.appendChild(summary);

    if (context.warnings?.length) {
      const warning = document.createElement('div');
      warning.className = 'alert alert-warning';
      warning.textContent = context.warnings.join(' ');
      wrapper.appendChild(warning);
    }

    const tableContainer = document.createElement('div');
    tableContainer.className = 'table-responsive';
    const table = document.createElement('table');
    table.className = 'table table-bordered table-striped checker-table result-table modifier-results-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Receiver ID</th>
          <th>Payer ID</th>
          <th>Insurer</th>
          <th>Member ID</th>
          <th>Ordered On</th>
          <th>Clinician</th>
          <th>CPT Code</th>
          <th>Modifier</th>
          <th>Expected VOI</th>
          <th>Actual VOI</th>
          <th>Status</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');

    if (results.length === 0) {
      const row = document.createElement('tr');
      row.className = 'valid-row table-success';
      row.innerHTML = '<td colspan="13">No modifier 24 or 52 activities were found.</td>';
      tbody.appendChild(row);
    } else {
      results.forEach((result, index) => {
        const row = document.createElement('tr');
        row.dataset.index = String(index);
        row.dataset.status = result.status.toLowerCase();
        row.className = result.status === 'Invalid'
          ? 'invalid-row table-danger'
          : result.status === 'Unknown'
            ? 'unknown-row table-warning'
            : 'valid-row table-success';

        row.innerHTML = `
          <td>${escapeHtml(result.claimID)}</td>
          <td>${escapeHtml(result.receiverID)}</td>
          <td>${escapeHtml(result.claimPayerID)}</td>
          <td>${escapeHtml(result.insurer)}</td>
          <td>${escapeHtml(result.memberIDRaw)}</td>
          <td>${escapeHtml(result.activityDate)}</td>
          <td>${escapeHtml(result.performingClinicianRaw || result.orderingClinicianRaw)}</td>
          <td>${escapeHtml(result.code)}</td>
          <td>${escapeHtml(result.modifier)}</td>
          <td>${escapeHtml(result.expectedVOI)}</td>
          <td>${escapeHtml(result.actualVOI)}</td>
          <td class="status-cell">${escapeHtml(result.status)}</td>
          <td style="white-space:pre-line">${escapeHtml(result.remark)}</td>
        `;
        tbody.appendChild(row);
      });
    }

    tableContainer.appendChild(table);
    wrapper.appendChild(tableContainer);
    return wrapper;
  }

  function renderError(error) {
    const wrapper = makeWrapper();
    const alert = document.createElement('div');
    alert.className = 'alert alert-danger';
    alert.setAttribute('role', 'alert');
    alert.textContent = `Modifier Checker failed: ${error?.message || String(error)}`;
    wrapper.appendChild(alert);

    const table = document.createElement('table');
    table.className = 'table checker-table';
    table.innerHTML = '<tbody><tr class="invalid-row"><td>Modifier checker did not complete.</td></tr></tbody>';
    wrapper.appendChild(table);
    return wrapper;
  }

  function updateMessage(message, isError) {
    const messageBox = getScopedElement('messageBox');
    if (!messageBox) return;
    messageBox.textContent = message || '';
    messageBox.classList.toggle('error', Boolean(isError));
  }

  function updateDownloadButton() {
    const button = getScopedElement('download-button');
    if (!button) return;
    button.style.display = lastResults.length ? '' : 'none';
    button.disabled = lastResults.length === 0;
  }

  async function runModifiersCheck(options) {
    const config = options || {};
    const xmlFile = resolveInputFile('xml-file', 'xml', config.xmlFile);
    const eligibilityFile = resolveInputFile('xlsx-file', 'eligibility', config.eligibilityFile);

    if (!xmlFile || !eligibilityFile) {
      const missing = [
        !xmlFile ? 'XML' : null,
        !eligibilityFile ? 'Eligibility workbook' : null
      ].filter(Boolean).join(' and ');
      const error = new Error(`${missing} is required.`);
      updateMessage(error.message, true);
      return renderError(error);
    }

    updateMessage('Checking CPT modifiers...', false);

    try {
      const [xmlText, eligibilityBuffer] = await Promise.all([
        readFileText(xmlFile),
        readFileArrayBuffer(eligibilityFile)
      ]);
      const xmlDoc = parseXml(xmlText);
      const eligibility = parseEligibilityWorkbook(eligibilityFile, eligibilityBuffer);
      const modifierContext = collectModifierRecords(xmlDoc);
      const results = modifierContext.records.map((record) =>
        analyzeModifierRecord(record, eligibility.rows, modifierContext.receiver)
      );

      lastResults = results;
      root._lastModifierResults = results;
      updateDownloadButton();
      updateMessage(
        `Modifier check completed using Header ReceiverID ${modifierContext.receiverID || '(missing)'}.`,
        false
      );

      return renderResults(results, {
        ...modifierContext,
        warnings: eligibility.warnings
      });
    } catch (error) {
      console.error('[MODIFIERS] Checker failed:', error);
      lastResults = [];
      root._lastModifierResults = [];
      updateDownloadButton();
      updateMessage(error?.message || String(error), true);
      return renderError(error);
    }
  }

  function downloadModifierResults() {
    if (!lastResults.length) return;

    if (!root.XLSX?.utils) {
      updateMessage('SheetJS (XLSX) is unavailable; results cannot be downloaded.', true);
      return;
    }

    const exportRows = lastResults.map((row) => ({
      'Claim ID': row.claimID,
      'Receiver ID': row.receiverID,
      'Payer ID': row.claimPayerID,
      Insurer: row.insurer,
      'Member ID': row.memberIDRaw,
      'Ordered On': row.activityDate,
      'Performing Clinician': row.performingClinicianRaw,
      'Ordering Clinician': row.orderingClinicianRaw,
      'Activity ID': row.activityID,
      'CPT Code': row.code,
      Modifier: row.modifier,
      'Observation Code': row.observationCode,
      'Expected VOI': row.expectedVOI,
      'Actual VOI': row.actualVOI,
      Status: row.status,
      Remarks: row.remark,
      'Eligibility Sheet': row.eligibilityMatch?.sheetName || '',
      'Eligibility Row': row.eligibilityMatch?.sheetRowNumber || ''
    }));

    const workbook = root.XLSX.utils.book_new();
    const sheet = root.XLSX.utils.json_to_sheet(exportRows);
    root.XLSX.utils.book_append_sheet(workbook, sheet, 'Modifier Results');
    root.XLSX.writeFile(workbook, 'modifier_checker_results.xlsx');
  }

  function bindStandaloneListeners() {
    if (listenersBound || typeof document === 'undefined') return;
    listenersBound = true;

    document.addEventListener('click', async (event) => {
      const runButton = event.target.closest('#run-button');
      if (runButton) {
        const container = getVisibleModifierContainer();
        if (!container || container.contains(runButton) || !document.getElementById('checker-container-modifiers')) {
          event.preventDefault();
          const result = await runModifiersCheck();
          const output = getScopedElement('outputTableContainer') || getScopedElement('results');
          if (output) {
            output.innerHTML = '';
            output.appendChild(result);
          }
        }
      }

      const downloadButton = event.target.closest('#download-button');
      if (downloadButton) {
        const container = getVisibleModifierContainer();
        if (!container || container.contains(downloadButton) || !document.getElementById('checker-container-modifiers')) {
          event.preventDefault();
          downloadModifierResults();
        }
      }
    });
  }

  root.runModifiersCheck = runModifiersCheck;
  root.downloadModifierResults = downloadModifierResults;
  root.ModifierChecker = Object.freeze({
    RECEIVER_CONFIG,
    MODIFIER_RULES,
    normalizeMemberID,
    normalizeClinician,
    normalizeVoi,
    toDateKey,
    parseEligibilityWorkbook,
    collectModifierRecords,
    analyzeModifierRecord,
    runModifiersCheck,
    downloadModifierResults
  });

  bindStandaloneListeners();
})(typeof window !== 'undefined' ? window : globalThis);
