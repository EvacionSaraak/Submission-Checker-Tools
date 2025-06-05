/**
 * Clinician validation and eligibility checker.
 * Handles loading of XML, Excel clinician lists, Open Jet eligibility,
 * and clinician license status. Validates claims and activities,
 * checking categories, privileges, eligibility windows, and license status.
 * Renders results and allows export to Excel.
 */
(function () {
  'use strict';

  // ============================================================================
  // 1. STATE VARIABLES & CONSTANTS
  // ============================================================================

  let claimCount = 0, clinicianCount = 0, openJetCount = 0;
  let clinicianMap = null, clinicianStatusMap = {};
  let excelInput, openJetInput, clinicianStatusInput, xmlInput;
  let exportCsvBtn, processBtn, resultsDiv, validationDiv;
  let openJetData = [];
  let xmlDoc = null;

  // Track which files have been loaded by the user
  const fileLoadStatus = {
    xml: false,
    clinicianExcel: false,
    openJetExcel: false,
    clinicianStatusExcel: false,
  };

  // Map of month abbreviations for Excel Open Jet parsing
  const monthMap = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
  };

  // ============================================================================
  // 2. DOM READY, UI BINDINGS, & GLOBAL ERROR HANDLER
  // ============================================================================

  /**
   * Handles initial DOM setup, binds UI, and sets up global error handler.
   */
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[Init] DOMContentLoaded');
    xmlInput = document.getElementById('xmlFileInput');
    excelInput = document.getElementById('excelFileInput');
    openJetInput = document.getElementById('openJetFileInput');
    clinicianStatusInput = document.getElementById('clinicianStatusFileInput');
    resultsDiv = document.getElementById('results');
    processBtn = document.getElementById('processBtn');
    exportCsvBtn = document.getElementById('exportCsvBtn');

    validationDiv = document.createElement('div');
    validationDiv.id = 'validation-message';
    resultsDiv.parentNode.insertBefore(validationDiv, resultsDiv);

    if (xmlInput) {
      xmlInput.addEventListener('change', handleXmlInput);
      console.log('[Bind] xmlInput change handler bound');
    }
    if (excelInput) {
      excelInput.addEventListener('change', handleClinicianExcelInput);
      console.log('[Bind] excelInput change handler bound');
    }
    if (openJetInput) {
      openJetInput.addEventListener('change', handleOpenJetExcelInput);
      console.log('[Bind] openJetInput change handler bound');
    }
    if (clinicianStatusInput) {
      clinicianStatusInput.addEventListener('change', handleClinicianStatusExcelInput);
      console.log('[Bind] clinicianStatusInput change handler bound');
    }

    if (processBtn) {
      processBtn.addEventListener('click', () => {
        console.log('[UI] Process button clicked');
        if (xmlDoc && clinicianMap && openJetData.length > 0) processClaims(xmlDoc, clinicianMap);
      });
      processBtn.disabled = true;
      console.log('[Bind] processBtn click handler bound');
    }
    if (exportCsvBtn) {
      exportCsvBtn.disabled = true;
      console.log('[Init] exportCsvBtn disabled');
    }

    updateResultsDiv();
    console.log('[Init] UI ready');
  });

  /**
   * Global error handler to display errors in the UI and log them.
   */
  window.onerror = (msg, url, line, col) => {
    if (resultsDiv) {
      resultsDiv.innerHTML = `<p class="error-message">Unexpected error: ${msg} at ${line}:${col}</p>`;
    }
    console.error('Global error:', msg, url, line, col);
  };

  // ============================================================================
  // 3. FILE INPUT HANDLERS & PARSING
  // ============================================================================

  function fileHeadersAndData(file, sheetIndex, headerRow, sheetName) {
    console.log(`[Excel] Parsing file: ${file.name}`);
    return file.arrayBuffer().then(buffer => {
      const data = new Uint8Array(buffer);
      const wb = XLSX.read(data, { type: 'array' });

      let name;
      if (sheetName) {
        name = wb.SheetNames.find(s => s.trim().toLowerCase() === sheetName.trim().toLowerCase());
        if (!name) throw new Error(`Sheet named "${sheetName}" not found`);
      } else {
        name = wb.SheetNames[sheetIndex];
        if (!name) throw new Error(`Sheet index ${sheetIndex} not found`);
      }

      const sheet = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const headerRowIndex = headerRow - 1;

      if (!rows || rows.length <= headerRowIndex)
        throw new Error(`Header row not found at position ${headerRowIndex + 1}`);

      const headers = rows[headerRowIndex].map(h => (h || '').toString().trim());
      const dataRows = rows.slice(headerRowIndex + 1).map(row => {
        const obj = {};
        headers.forEach((h, i) => {
          if (obj[h] === undefined) obj[h] = row[i] || '';
        });
        return obj;
      });
      console.log(`[Excel] Parsed ${dataRows.length} data rows from "${name}"`);
      return { headers, data: dataRows };
    });
  }

  function handleClinicianExcelInput() {
    console.log('[Input] Clinician Excel selection');
    showProcessing('Loading Clinician Excel...');
    disableButtons();
    const file = excelInput.files[0];
    if (!file) {
      fileLoadStatus.clinicianExcel = false;
      clinicianMap = null;
      clinicianCount = 0;
      resultsDiv.innerHTML = '';
      updateResultsDiv();
      toggleProcessButton();
      return;
    }
    fileHeadersAndData(file, 0, 1, 'Clinicians').then(({ headers, data }) => {
      handleClinicianExcelData(data);
      fileLoadStatus.clinicianExcel = true;
      resultsDiv.innerHTML = '';
      updateResultsDiv();
      toggleProcessButton();
      console.log(`[Input] Clinician Excel loaded: ${clinicianCount} clinicians`);
    }).catch(e => {
      fileLoadStatus.clinicianExcel = false;
      clinicianMap = null;
      clinicianCount = 0;
      resultsDiv.innerHTML = `<p class="error-message">Error loading Clinician Excel: ${e.message}</p>`;
      updateResultsDiv();
      toggleProcessButton();
      console.error('[Input] Error loading Clinician Excel:', e);
    });
  }

  function handleClinicianStatusExcelInput() {
    console.log('[Input] Clinician Status Excel selection');
    showProcessing('Loading Clinician Status Excel...');
    disableButtons();
    const file = clinicianStatusInput.files[0];
    if (!file) {
      fileLoadStatus.clinicianStatusExcel = false;
      clinicianStatusMap = {};
      resultsDiv.innerHTML = '';
      updateResultsDiv();
      toggleProcessButton();
      return;
    }
    fileHeadersAndData(file, 1, 1).then(({ headers, data }) => {
      handleClinicianStatusExcelData(data);
      fileLoadStatus.clinicianStatusExcel = true;
      resultsDiv.innerHTML = '';
      updateResultsDiv();
      toggleProcessButton();
      console.log(`[Input] Clinician Status Excel loaded: ${Object.keys(clinicianStatusMap).length} license histories`);
    }).catch(e => {
      fileLoadStatus.clinicianStatusExcel = false;
      clinicianStatusMap = {};
      resultsDiv.innerHTML = `<p class="error-message">Error loading Clinician Status Excel: ${e.message}</p>`;
      updateResultsDiv();
      toggleProcessButton();
      console.error('[Input] Error loading Clinician Status Excel:', e);
    });
  }
  
  /**
   * Handles the user selecting an Open Jet Excel file.
   * - Uses only the ordering clinician to look up Open Jet data.
   * - Card number, card status, eligibility, package, service, consultation, effective/expiry all pulled from ordering clinician's Open Jet row.
   * - All fields are mapped from Open Jet by dynamic header lookup.
   * - Includes logging for debugging.
   */
  function handleOpenJetExcelInput() {
    console.log('[Input] Open Jet Excel selection');
    showProcessing('Loading Open Jet Excel...');
    disableButtons();
    const file = openJetInput.files[0];
    if (!file) {
      fileLoadStatus.openJetExcel = false;
      openJetData = [];
      resultsDiv.innerHTML = '';
      updateResultsDiv();
      toggleProcessButton();
      return;
    }
    file.arrayBuffer().then(buffer => {
      const data = new Uint8Array(buffer);
      const wb = XLSX.read(data, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      // Robust: Header is second row, data starts after that.
      const headerRow = rows[1];
      const dataRows = rows.slice(2);

      console.log('[OpenJet] Header row:', headerRow);

      // Dynamically look up all field indices
      const getColIdx = (name) => headerRow.findIndex(h => (h || '').toString().trim().toLowerCase() === name.toLowerCase());

      const clinicianCol      = getColIdx("Clinician");
      const cardNumberCol     = getColIdx("Card Number");
      const cardStatusCol     = getColIdx("Card Status");
      const eligibilityCol    = getColIdx("Eligibility");
      const packageCol        = getColIdx("Package");
      const serviceCol        = getColIdx("Service Category");
      const consultationCol   = getColIdx("Consultation Status");
      const effectiveDateCol  = getColIdx("EffectiveDate");
      const expiryDateCol     = getColIdx("ExpiryDate");

      // Support duplicate EffectiveDate/ExpiryDate columns (use rightmost)
      const getAllColumnIndices = (targetName) => headerRow.map((h, idx) => ((h || '').toString().trim() === targetName) ? idx : -1).filter(idx => idx !== -1);
      const effectiveDateCols = getAllColumnIndices("EffectiveDate");
      const expiryDateCols = getAllColumnIndices("ExpiryDate");

      openJetData = [];
      dataRows.forEach((row, rowIdx) => {
        const clinicianId = row[clinicianCol] ? row[clinicianCol].toString().trim() : '';
        if (!clinicianId) return;
        // Use latest (right-most) non-empty value for each date field
        const getLatestValueFromColumns = (row, indices) => {
          for (let i = indices.length - 1; i >= 0; i--) {
            const val = row[indices[i]];
            if (val !== undefined && val !== null && String(val).trim() !== '') {
              return val;
            }
          }
          return '';
        };

        const effectiveDateRaw = getLatestValueFromColumns(row, effectiveDateCols);
        const expiryDateRaw = getLatestValueFromColumns(row, expiryDateCols);

        openJetData.push({
          clinicianId,
          cardNumber:      cardNumberCol     >= 0 ? (row[cardNumberCol]     || '').toString().trim() : '',
          cardStatus:      cardStatusCol     >= 0 ? (row[cardStatusCol]     || '').toString().trim() : '',
          eligibility:     eligibilityCol    >= 0 ? (row[eligibilityCol]    || '').toString().trim() : '',
          package:         packageCol        >= 0 ? (row[packageCol]        || '').toString().trim() : '',
          service:         serviceCol        >= 0 ? (row[serviceCol]        || '').toString().trim() : '',
          consultation:    consultationCol   >= 0 ? (row[consultationCol]   || '').toString().trim() : '',
          effectiveDate:   parseDate(effectiveDateRaw),
          expiryDate:      parseDate(expiryDateRaw)
        });
      });
      openJetCount = openJetData.length;
      fileLoadStatus.openJetExcel = true;
      resultsDiv.innerHTML = '';
      updateResultsDiv();
      toggleProcessButton();
      console.log(`[Input] Open Jet Excel loaded: ${openJetCount} eligibilities`);
      if (openJetCount === 0) console.warn('[OpenJet] No eligibilities loaded. Check header row and data.');
    }).catch(e => {
      fileLoadStatus.openJetExcel = false;
      openJetData = [];
      resultsDiv.innerHTML = `<p class="error-message">Error loading Open Jet Excel: ${e.message}</p>`;
      updateResultsDiv();
      toggleProcessButton();
      console.error('[Input] Error loading Open Jet Excel:', e);
    });
  }

  function getAllColumnIndices(headerRow, targetName) {
    const indices = [];
    headerRow.forEach((h, idx) => {
      if ((h || '').toString().trim() === targetName) indices.push(idx);
    });
    return indices;
  }

  function getLatestValueFromColumns(row, indices) {
    for (let i = indices.length - 1; i >= 0; i--) {
      const val = row[indices[i]];
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        return val;
      }
    }
    return '';
  }

  function handleXmlInput() {
    console.log('[Input] XML file selection');
    showProcessing('Loading XML...');
    disableButtons();
    const file = xmlInput.files[0];

    if (!file) {
      xmlDoc = null;
      claimCount = 0;
      fileLoadStatus.xml = false;
      resultsDiv.innerHTML = '';
      updateResultsDiv();
      toggleProcessButton();
      return;
    }

    file.text().then(text => {
      if (!text.trim()) throw new Error('Empty XML file');
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
      xmlDoc = doc;
      claimCount = xmlDoc.getElementsByTagName('Claim').length;
      fileLoadStatus.xml = true;
      resultsDiv.innerHTML = '';
      updateResultsDiv();
      toggleProcessButton();
      console.log(`[Input] XML loaded: ${claimCount} claims`);
    }).catch(e => {
      xmlDoc = null; claimCount = 0;
      fileLoadStatus.xml = false;
      resultsDiv.innerHTML = `<p class="error-message">Error loading XML: ${e.message}</p>`;
      updateResultsDiv();
      toggleProcessButton();
      console.error('[Input] Error loading XML:', e);
    });
  }

  // ============================================================================
  // 4. DATA PARSING
  // ============================================================================

  function handleClinicianExcelData(data) {
    console.log('[Parse] handleClinicianExcelData');
    clinicianMap = {};
    data.forEach(row => {
      const id = (row['Clinician License'] || '').toString().trim();
      if (!id) return;
      clinicianMap[id] = {
        name: (row['Clinician Name'] || row['Name'] || '').toString().trim(),
        category: (row['Clinician Category'] || row['Category'] || '').toString().trim(),
        privileges: (row['Activity Group'] || row['Privileges'] || '').toString().trim(),
        from: (row['From'] || '').toString().trim(),
        to: (row['To'] || '').toString().trim(),
        status: (row['Status'] || '').toString().trim()
      };
    });
    clinicianCount = Object.keys(clinicianMap).length;
    console.log(`[Parse] Clinicians mapped: ${clinicianCount}`);
  }

  function handleClinicianStatusExcelData(data) {
    console.log('[Parse] handleClinicianStatusExcelData');
    clinicianStatusMap = {};
    data.forEach(row => {
      const licenseNumber = (row['License Number'] || '').toString().trim().toUpperCase();
      const facilityLicenseNumber = (row['Facility License Number'] || '').toString().trim().toUpperCase();
      const effectiveDateRaw = (row['Effective Date'] || '').toString().trim();
      const effectiveDateObj = parseDate(effectiveDateRaw);
      const effectiveDate = isNaN(effectiveDateObj) ? "" : effectiveDateObj.toISOString().slice(0, 10);
      const status = (row['Status'] || '').toString().trim().toUpperCase();
      if (!licenseNumber) return;
      (clinicianStatusMap[licenseNumber] = clinicianStatusMap[licenseNumber] || []).push({
        facilityLicenseNumber,
        effectiveDate,
        status
      });
    });
    console.log('[Parse] Clinician license histories mapped');
  }

  // ============================================================================
  // 5. VALIDATION & LICENSE STATUS LOGIC
  // ============================================================================

  function parseDate(dateStr) {
    if (!dateStr) return new Date('Invalid');
    if (!isNaN(dateStr) && Number(dateStr) > 59) {
      const excelSerial = Number(dateStr);
      return new Date((excelSerial - 25567) * 86400 * 1000);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return new Date(dateStr);
    }
    if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(dateStr)) {
      const [day, mon, year] = dateStr.split('-');
      if (monthMap[mon]) return new Date(`${year}-${monthMap[mon]}-${day.padStart(2, '0')}`);
    }
    if (/^\d{1,2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}$/.test(dateStr)) {
      const [datePart] = dateStr.split(' ');
      const [day, mon, year] = datePart.split('-');
      if (monthMap[mon]) return new Date(`${year}-${monthMap[mon]}-${day.padStart(2, '0')}`);
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
      const [day, month, year] = dateStr.split('/');
      return new Date(`${year}-${month}-${day}`);
    }
    let d = new Date(dateStr);
    if (!isNaN(d)) return d;
    return new Date('Invalid');
  }

  function checkEligibility(encounterStartStr, encounterEndStr, xlsxRow, sourceLabel = "Excel") {
    const encounterStart = parseDate(encounterStartStr);
    const encounterEnd = parseDate(encounterEndStr);
    const effectiveDate = xlsxRow.effectiveDate instanceof Date ? xlsxRow.effectiveDate : parseDate(xlsxRow.effectiveDate || xlsxRow.from);
    const expiryDate = xlsxRow.expiryDate instanceof Date ? xlsxRow.expiryDate : parseDate(xlsxRow.expiryDate || xlsxRow.to);
    const remarks = [];
    let eligible = true;

    if (isNaN(encounterStart) || isNaN(encounterEnd)) {
      remarks.push("Invalid Encounter dates in XML"); eligible = false;
    } else if (!effectiveDate || !expiryDate || isNaN(effectiveDate) || isNaN(expiryDate)) {
      remarks.push(`Invalid Effective/Expiry dates in ${sourceLabel}`); eligible = false;
    } else if (!(encounterStart >= effectiveDate && encounterEnd <= expiryDate)) {
      remarks.push("Procedure is done outside of Eligibility window"); eligible = false;
    }

    return { eligible, remarks, eligibilityValue: xlsxRow.eligibility || '' };
  }

  function generateRemarks(od, pd) {
    return od.category !== pd.category ? [`Category mismatch (${od.category} vs ${pd.category})`] : [];
  }

  function getPerformingLicenseRemark(performingId, providerId, encounterStartStr) {
    const records = clinicianStatusMap[performingId];
    console.log(`[History lookup] Performing Clinician: ${performingId} | Provider: ${providerId} | Full license history:`, records);

    if (!records?.length) return `Performing Clinician (${performingId}) not found in status data`;

    const encounterDate = parseDate(encounterStartStr);
    if (isNaN(encounterDate)) return `Invalid Encounter Start Date for Performing Clinician (${performingId})`;

    const providerMatches = records.filter(rec => rec.facilityLicenseNumber === providerId);
    if (!providerMatches.length) return `No matching Facility License Number (${providerId}) for Performing Clinician (${performingId})`;

    let validRecord = null;
    for (const rec of providerMatches) {
      const effDate = parseDate(rec.effectiveDate);
      if (!isNaN(effDate) && effDate <= encounterDate) {
        if (!validRecord || effDate > parseDate(validRecord.effectiveDate)) validRecord = rec;
      }
    }

    if (!validRecord) return `No effective date record on or before encounter date for Performing Clinician (${performingId})`;

    if (validRecord.status.toLowerCase() !== 'active') {
      return `Performing Clinician (${performingId}) has ${validRecord.status.toUpperCase()} license as of ${validRecord.effectiveDate}`;
    }
    return null;
  }

  function validateClinicians(orderingId, performingId, od, pd) {
    if (!orderingId || !performingId) return false;
    if (orderingId === performingId) return true;
    return od.category === pd.category;
  }

  // ============================================================================
  // 6. MAIN PROCESSING FUNCTION
  // ============================================================================

  function processClaims(d, map) {
    console.log('[Process] processClaims called');
    showProcessing("Validating Claims...");
    disableButtons();

    setTimeout(() => {
      const claimNodes = Array.from(d.getElementsByTagName('Claim'));
      claimCount = claimNodes.length;
      const results = [];

      claimNodes.forEach(cl => {
        const cid = getText(cl, 'ID') || 'N/A';
        const encounterNode = cl.getElementsByTagName('Encounter')[0];
        const encounterStartStr = encounterNode ? getText(encounterNode, 'Start') : '';
        const encounterEndStr = encounterNode ? getText(encounterNode, 'End') : '';
        const activities = Array.from(cl.getElementsByTagName('Activity'));

        activities.forEach(act => {
          const aid = getText(act, 'ID') || 'N/A';
          const oid = getText(act, 'OrderingClinician') || '';
          const pid = getText(act, 'Clinician') || '';
          const od = map[oid] || defaultClinicianData();
          const pd = map[pid] || defaultClinicianData();
          const rowRemarks = [];

          const ordXlsxRow = openJetData.find(r => r.clinicianId === oid);
          const perfXlsxRow = openJetData.find(r => r.clinicianId === pid);
          const providerId = getText(cl, 'ProviderID');
          const encounterDate = encounterStartStr ? parseDate(encounterStartStr) : null;

          if (clinicianStatusMap && pid && providerId && encounterStartStr) {
            const licenseStatusRemark = getPerformingLicenseRemark(pid, providerId, encounterStartStr);
            if (licenseStatusRemark) rowRemarks.push(licenseStatusRemark);
          }

          if (!ordXlsxRow) rowRemarks.push(`Ordering Clinician (${oid}) not in Open Jet`);
          if (!perfXlsxRow) rowRemarks.push(`Performing Clinician (${pid}) not in Open Jet`);
          if (!validateClinicians(oid, pid, od, pd)) rowRemarks.push(...generateRemarks(od, pd));

          if (!(ordXlsxRow && typeof ordXlsxRow.status === 'string' && ordXlsxRow.status.toLowerCase() === 'eligible')) {
            rowRemarks.push(`Ordering Clinician status is ${ordXlsxRow && typeof ordXlsxRow.status === 'string' ? ordXlsxRow.status.toLowerCase() : 'unknown'} in Open Jet`);
          }
          if (!(perfXlsxRow && typeof perfXlsxRow.status === 'string' && perfXlsxRow.status.toLowerCase() === 'eligible')) {
            rowRemarks.push(`Performing Clinician status is ${perfXlsxRow && typeof perfXlsxRow.status === 'string' ? perfXlsxRow.status.toLowerCase() : 'unknown'} in Open Jet`);
          }

          if (ordXlsxRow) {
            const ordEligRes = checkEligibility(encounterStartStr, encounterEndStr, ordXlsxRow, "Open Jet Excel");
            if (!ordEligRes.eligible)
              rowRemarks.push(`Ordering: ${ordEligRes.remarks.join('; ')}`);
          }
          if (perfXlsxRow) {
            const perfEligRes = checkEligibility(encounterStartStr, encounterEndStr, perfXlsxRow, "Open Jet Excel");
            if (!perfEligRes.eligible)
              rowRemarks.push(`Performing: ${perfEligRes.remarks.join('; ')}`);
          }

          const resultRow = {
            claimId: cid,
            activityId: aid,
            activityStart: encounterStartStr,
            orderingId: oid,
            orderingName: od.name,
            orderingCategory: od.category,
            orderingPrivileges: od.privileges || '',
            orderingFrom: od.from || '',
            orderingTo: od.to || '',
            orderingEligibility: ordXlsxRow ? ordXlsxRow.eligibility : 'N/A',
            orderingStatus: ordXlsxRow?.status ?? 'N/A',
            performingId: pid,
            performingName: pd.name,
            performingCategory: pd.category,
            performingPrivileges: pd.privileges || '',
            performingFrom: pd.from || '',
            performingTo: pd.to || '',
            performingEligibility: perfXlsxRow ? perfXlsxRow.eligibility : 'N/A',
            performingStatus: perfXlsxRow?.status ?? 'N/A',
            status: perfXlsxRow?.status ?? ordXlsxRow?.status ?? 'N/A',
            packageName: perfXlsxRow?.package ?? ordXlsxRow?.package ?? '',
            serviceCategory: perfXlsxRow?.service ?? ordXlsxRow?.service ?? '',
            consultationStatus: perfXlsxRow?.consultation ?? ordXlsxRow?.consultation ?? '',
            effectiveDate: perfXlsxRow?.effectiveDate ?? ordXlsxRow?.effectiveDate ?? '',
            expiryDate: perfXlsxRow?.expiryDate ?? ordXlsxRow?.expiryDate ?? '',
            cardNumber: perfXlsxRow?.cardNumber ?? ordXlsxRow?.cardNumber ?? '',
            cardStatus: perfXlsxRow?.cardStatus ?? ordXlsxRow?.cardStatus ?? '',
            valid: rowRemarks.length === 0,
            remarks: rowRemarks
          };

          console.log('[Process] Result row:', resultRow);

          results.push(resultRow);
        });
      });

      renderResults(results);
      setupExportHandler(results);
      updateResultsDiv();
      console.log('[Process] All claims processed');
    }, 300);
  }

  // ============================================================================
  // 7. RENDERING & EXPORT
  // ============================================================================

  function appendCell(tr, content, { isHTML = false, isArray = false, verticalAlign = '' } = {}) {
    const td = document.createElement('td');
    if (verticalAlign) td.style.verticalAlign = verticalAlign;

    if (isArray) {
      td.style.whiteSpace = 'pre-line';
      td.textContent = '';
      (Array.isArray(content) ? content : [content]).forEach(text => {
        const div = document.createElement('div');
        div.textContent = text;
        td.appendChild(div);
      });
    } else if (isHTML) {
      td.style.whiteSpace = 'pre-line';
      td.innerHTML = content;
    } else {
      td.style.whiteSpace = String(content).includes('\n') ? 'pre-line' : 'nowrap';
      td.textContent = content;
    }
    tr.appendChild(td);
  }

  function formatEligibilityCell(eligibility, pkg, network, service, consultation) {
    return `
      <div>${eligibility || ''}</div>
      <div>
        <span>${pkg || ''} - ${network || ''}</span>
      </div>
      <div>
        <span>${service || ''} - ${consultation || ''}</span>
      </div>
    `;
  }

  function renderResults(results) {
    if (!results.length) {
      renderSummary(results);
      resultsDiv.innerHTML = '<p>No results found.</p>';
      return;
    }

    renderSummary(results);
    resultsDiv.innerHTML = '';
    const table = document.createElement('table');
    table.setAttribute('aria-label', 'Clinician validation results');
    table.appendChild(renderTableHeader());
    table.appendChild(renderTableBody(results));
    resultsDiv.appendChild(table);
    console.log('[Render] Results table rendered');
  }

  function renderSummary(results) {
    const validCount = results.filter(r => r.valid).length;
    const total = results.length;
    const pct = total ? Math.round((validCount / total) * 100) : 0;
    validationDiv.textContent = `Validation completed: ${validCount}/${total} valid (${pct}%)`;
    validationDiv.className = pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message';
    console.log(`[Render] Validation summary: ${validCount}/${total} valid`);
  }

  function renderTableBody(results) {
    const tbody = document.createElement('tbody');
    results.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = r.valid ? 'valid' : 'invalid';
      const encounterDate = (r.activityStart || '').split('T')[0];

      const formatClinicianCell = (id, name, category, privileges, from, to) => `
        <div><strong>${id || ''}</strong></div>
        <div>${name || ''}</div>
        <div>${category || ''}</div>
        <div><em>${privileges || ''}</em></div>
        <div style="margin-top: 4px;">
          <div style="display:inline-block; width:48%;">From: ${from || 'N/A'}</div>
          <div style="display:inline-block; width:48%;">To: ${to || 'N/A'}</div>
        </div>
      `;

      appendCell(tr, r.claimId, { verticalAlign: 'top' });
      appendCell(tr, r.activityId);
      appendCell(tr, encounterDate);
      appendCell(tr, formatClinicianCell(r.orderingId, r.orderingName, r.orderingCategory, r.orderingPrivileges, r.orderingFrom, r.orderingTo), { isHTML: true });
      appendCell(tr, formatClinicianCell(r.performingId, r.performingName, r.performingCategory, r.performingPrivileges, r.performingFrom, r.performingTo), { isHTML: true });
      appendCell(tr, r.status || 'N/A');
      appendCell(tr, formatEligibilityCell(
        r.performingEligibility || r.orderingEligibility || '',
        r.packageName || '',
        r.cardStatus || '',
        r.serviceCategory || '',
        r.consultationStatus || ''
      ), { isHTML: true });
      appendCell(tr, r.valid ? '✔︎' : '✘');
      appendCell(tr, r.remarks, { isArray: true });

      tbody.appendChild(tr);
    });
    return tbody;
  }

  function renderTableHeader() {
    const thead = document.createElement('thead');
    const row = document.createElement('tr');
    [
      'Claim ID', 'Activity ID', 'Activity Start (Encounter Date)', 'Ordering Clinician',
      'Performing Clinician', 'License Status', 'Eligibility', 'Valid', 'Remarks'
    ].forEach(text => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text;
      row.appendChild(th);
    });
    thead.appendChild(row);
    return thead;
  }

  function setupExportHandler(results) {
    if (!exportCsvBtn) return;
    exportCsvBtn.disabled = false;
    exportCsvBtn.onclick = function () {
      if (!xmlDoc) {
        alert('No XML document loaded for export.');
        return;
      }
      const senderID = (xmlDoc.querySelector('Header > SenderID')?.textContent || 'UnknownSender').trim();
      const transactionDateRaw = (xmlDoc.querySelector('Header > TransactionDate')?.textContent || '').trim();
      let transactionDateFormatted = 'UnknownDate';

      if (transactionDateRaw) {
        const dateParts = transactionDateRaw.split(' ')[0].split('/');
        if (dateParts.length === 3)
          transactionDateFormatted = `${dateParts[2]}-${dateParts[1].padStart(2, '0')}-${dateParts[0].padStart(2, '0')}`;
      }

      const headers = [
        'Claim ID', 'Activity ID', 'Activity Start',
        'Ordering Clinician ID', 'Ordering Name', 'Ordering Category', 'Ordering Privileges', 'Ordering From', 'Ordering To',
        'Performing Clinician ID', 'Performing Name', 'Performing Category', 'Performing Privileges', 'Performing From', 'Performing To',
        'License Status', 'Eligibility: Package Name',
        'Eligibility: Service Category', 'Eligibility: Consultation Status',
        'Eligibility: Effective Date', 'Eligibility: Expiry Date',
        'Eligibility: Card Number', 'Eligibility: Card Status',
        'Valid/Invalid', 'Remarks'
      ];

      const rows = results.map(r => [
        r.claimId, r.activityId, (r.activityStart || '').split('T')[0],
        r.orderingId, r.orderingName, r.orderingCategory, r.orderingPrivileges, r.orderingFrom || '', r.orderingTo || '',
        r.performingId, r.performingName, r.performingCategory, r.performingPrivileges, r.performingFrom || '', r.performingTo || '',
        r.status || 'N/A', r.packageName || '',
        r.serviceCategory || '', r.consultationStatus || '',
        r.effectiveDate || '', r.expiryDate || '',
        r.cardNumber || '', r.cardStatus || '',
        r.valid ? 'Valid' : 'Invalid',
        r.remarks.join('; ')
      ]);

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };
      ws['!cols'] = headers.map((h, i) => {
        let maxLen = h.length;
        rows.forEach(r => {
          const v = r[i];
          if (v && v.toString().length > maxLen) maxLen = v.toString().length;
        });
        return { wch: Math.min(maxLen + 5, 50) };
      });
      XLSX.utils.book_append_sheet(wb, ws, 'Validation Results');
      const filename = `ClinicianCheck_${senderID}_${transactionDateFormatted}.xlsx`;
      XLSX.writeFile(wb, filename);
      console.log(`[Export] Results exported as ${filename}`);
    };
  }

  // ============================================================================
  // 8. HELPERS & UTILITIES
  // ============================================================================

  function defaultClinicianData() {
    return { name: 'Unknown', category: 'Unknown', privileges: 'Unknown', from: '', to: '' };
  }

  function getText(parent, tag) {
    const el = parent.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : '';
  }

  function showProcessing(msg = "Processing...") {
    resultsDiv.innerHTML = `<div class="loading-spinner" aria-live="polite"></div><p>${msg}</p>`;
  }

  function toggleProcessButton() {
    const allLoaded = fileLoadStatus.xml &&
                      fileLoadStatus.clinicianExcel &&
                      fileLoadStatus.openJetExcel &&
                      fileLoadStatus.clinicianStatusExcel;
    if (processBtn) processBtn.disabled = !allLoaded;
  }

  function disableButtons() {
    if (processBtn) processBtn.disabled = true;
    if (exportCsvBtn) exportCsvBtn.disabled = true;
  }

  function updateResultsDiv() {
    const messages = [];
    if (claimCount) messages.push(`${claimCount} Claims Loaded`);
    if (clinicianCount) messages.push(`${clinicianCount} Clinicians Loaded`);
    if (openJetCount) messages.push(`${openJetCount} Eligibilities Loaded`);
    const historiesCount = Object.keys(clinicianStatusMap || {}).length;
    if (historiesCount) messages.push(`${historiesCount} License Histories Loaded`);
    const uploadStatusElem = document.getElementById('uploadStatus');
    if (uploadStatusElem) uploadStatusElem.textContent = messages.join(', ');
    toggleProcessButton();
    console.log('[UI] Status updated:', messages.join(', '));
  }

})();
