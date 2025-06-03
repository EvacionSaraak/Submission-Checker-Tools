(function () {
  'use strict';

  // === GLOBAL STATE ===
  let openJetData = [];
  let xmlDoc = null;
  let clinicianMap = null;
  let xmlInput, excelInput, openJetInput, clinicianStatusInput, resultsDiv, validationDiv, processBtn, exportCsvBtn;
  let clinicianCount = 0, openJetCount = 0, claimCount = 0;
  let clinicianStatusMap = {};

  // === INITIALIZE ===
  document.addEventListener('DOMContentLoaded', initEventListeners);

  // Global error handler
  window.onerror = function (msg, url, line, col, error) {
    if (resultsDiv) resultsDiv.innerHTML = `<p class="error-message">Unexpected error: ${msg} at ${line}:${col}</p>`;
    console.error('Global error:', { msg, url, line, col, error });
  };

  // Initializes UI elements and event listeners.
  function initEventListeners() {
    xmlInput = document.getElementById('xmlFileInput');
    excelInput = document.getElementById('excelFileInput');
    openJetInput = document.getElementById('openJetFileInput');
    // New listener for the “Clinician Status” XLSX upload:
    const historyInput = document.getElementById('clinicianStatusFileInput');
  
    resultsDiv = document.getElementById('results');
    validationDiv = document.createElement('div');
    validationDiv.id = 'validation-message';
    resultsDiv.parentNode.insertBefore(validationDiv, resultsDiv);
    processBtn = document.getElementById('processBtn');
    exportCsvBtn = document.getElementById('exportCsvBtn');
  
    resultsDiv.setAttribute('role', 'region');
    validationDiv.setAttribute('role', 'status');
  
    xmlInput.addEventListener('change', handleXmlInput);
    excelInput.addEventListener('change', handleUnifiedExcelInput);
    openJetInput.addEventListener('change', handleUnifiedExcelInput);
    // Attach the new listener here:
    historyInput.addEventListener('change', () => {
      const file = historyInput.files[0];
      if (file) {
        handleClinicianStatusExcelInput(file).then(() => {
          updateLoaderMessages();    // Refresh counts after loading histories
          toggleProcessButton();     // Re-enable Process button if applicable
        });
      }
    });
  
    processBtn.addEventListener('click', () => {
      if (xmlDoc && clinicianMap && openJetData.length > 0) {
        processClaims(xmlDoc, clinicianMap);
      }
    });
  }

  // Handles XML file input changes.
  function handleXmlInput() {
    showProcessing('Loading XML...');
    processBtn.disabled = true;
    exportCsvBtn.disabled = true;
    const file = xmlInput.files[0];
    if (!file) { xmlDoc = null; claimCount = 0; updateResultsDiv(); toggleProcessButton(); return; }
    file.text().then(text => {
      if (!text.trim()) throw new Error('Empty XML file');
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
      xmlDoc = doc;
      claimCount = xmlDoc.getElementsByTagName('Claim').length;
      updateResultsDiv();
      toggleProcessButton();
    }).catch(e => {
      xmlDoc = null;
      claimCount = 0;
      resultsDiv.innerHTML = `<p class="error-message">Error loading XML: ${e.message}</p>`;
      console.error('XML loading error:', e);
      toggleProcessButton();
    });
  }

  // Loads and parses both Shafafiya and OpenJet Excel files.
  function handleUnifiedExcelInput() {
    showProcessing('Loading Excel files...');
    processBtn.disabled = true;
    exportCsvBtn.disabled = true;
    const promises = [];
    if (excelInput.files[0]) {
      promises.push(
        sheetToJsonWithHeader(excelInput.files[0], 0, 1).then(data => {
          clinicianMap = {};
          data.forEach(row => {
            const id = (row['Clinician License'] || '').toString().trim();
            if (id) {
              clinicianMap[id] = {
                name: row['Clinician Name'] || row['Name'] || '',
                category: row['Clinician Category'] || row['Category'] || '',
                privileges: row['Activity Group'] || row['Privileges'] || '',
                from: row['From'] || '',
                to: row['To'] || ''
              };
            }
          });
          clinicianCount = Object.keys(clinicianMap).length;
        })
      );
    }
    if (openJetInput.files[0]) {
      promises.push(
        sheetToJsonWithHeader(openJetInput.files[0], 0, 2).then(data => {
          openJetData = data.map(row => {
            const parseOpenJetDate = (dateStr) => {
              if (!dateStr) return new Date('Invalid');
              const parts = dateStr.split(' ');
              const datePart = parts[0];
              const [day, month, year] = datePart.split('-');
              const monthMap = {
                'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
                'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
                'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
              };
              return new Date(`${year}-${monthMap[month]}-${day.padStart(2, '0')}`);
            };
            return {
              clinicianId: (row['Clinician'] || '').toString().trim(),
              effectiveDate: parseOpenJetDate(row['EffectiveDate']),
              expiryDate: parseOpenJetDate(row['ExpiryDate']),
              eligibility: (row['Status'] || '').toString().trim()
            };
          }).filter(entry => entry.clinicianId);
          openJetCount = openJetData.length;
        }).catch(e => {
          console.error('OpenJet processing error:', e);
          throw new Error(`Failed to process OpenJet file: ${e.message}`);
        })
      );
    }
    Promise.all(promises)
      .then(() => { updateResultsDiv(); })
      .catch(e => {
        resultsDiv.innerHTML = `<p class="error-message">${e.message}</p>`;
        console.error('Excel loading error:', e);
        toggleProcessButton();
      });
  }

  // Enables/disables the process button based on data readiness.
  function toggleProcessButton() { processBtn.disabled = !(xmlDoc && clinicianMap && openJetData.length > 0); }

  // Updates the UI with the current loading status.
  function updateResultsDiv() {
    const messages = [];
    if (claimCount > 0) messages.push(`${claimCount} Claims Loaded`);
    if (clinicianCount > 0) messages.push(`${clinicianCount} Clinicians Loaded`);
    if (openJetCount > 0) messages.push(`${openJetCount} Auths Loaded`);
    document.getElementById('uploadStatus').textContent = messages.join(', ');
    toggleProcessButton();
  }

  // Shows a processing spinner/message.
  function showProcessing(msg = "Processing...") {
    resultsDiv.innerHTML = `<div class="loading-spinner" aria-live="polite"></div><p>${msg}</p>`;
  }

  // Main processing function: iterates over claims, validates clinicians, and checks eligibility windows.
  function processClaims(d, map) {
    showProcessing("Validating Claims...");
    exportCsvBtn.disabled = true;
    setTimeout(() => {
      const claimNodes = Array.from(d.getElementsByTagName('Claim'));
      const results = [];
      claimCount = claimNodes.length;
      claimNodes.forEach(cl => {
        const cid = getText(cl, 'ID') || 'N/A';
        const encounterNode = cl.getElementsByTagName('Encounter')[0];
        const encounterStartStr = encounterNode ? getText(encounterNode, 'From') : '';
        const encounterEndStr = encounterNode ? getText(encounterNode, 'To') : '';
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
          if (!ordXlsxRow) rowRemarks.push(`Ordering Clinician (${oid}) not in Open Jet`);
          if (!perfXlsxRow) rowRemarks.push(`Performing Clinician (${pid}) not in Open Jet`);
          if (!validateClinicians(oid, pid, od, pd)) rowRemarks.push(generateRemarks(od, pd));
          if (ordXlsxRow) {
            const ordEligRes = checkEligibility(encounterStartStr, encounterEndStr, ordXlsxRow);
            if (!ordEligRes.eligible) rowRemarks.push(`Ordering: ${ordEligRes.remarks.join('; ')}`);
          }
          if (perfXlsxRow) {
            const perfEligRes = checkEligibility(encounterStartStr, encounterEndStr, perfXlsxRow);
            if (!perfEligRes.eligible) rowRemarks.push(`Performing: ${perfEligRes.remarks.join('; ')}`);
          }
  
          // New: Validate clinician status against the clinicianStatusMap with Provider ID and encounter start date
          if (clinicianStatusMap) {
            const ordStatus = validateClinicianStatus(oid, getText(cl, 'ProviderID'), encounterStartStr);
            const perfStatus = validateClinicianStatus(pid, getText(cl, 'ProviderID'), encounterStartStr);
            rowRemarks.push(...ordStatus.remarks);
            rowRemarks.push(...perfStatus.remarks);
          }
  
          results.push({
            claimId: cid,
            activityId: aid,
            orderingId: oid,
            orderingName: od.name,
            orderingCategory: od.category,
            orderingEligibility: ordXlsxRow ? ordXlsxRow.eligibility : 'N/A',
            performingId: pid,
            performingName: pd.name,
            performingCategory: pd.category,
            performingEligibility: perfXlsxRow ? perfXlsxRow.eligibility : 'N/A',
            valid: rowRemarks.length === 0,
            remarks: rowRemarks
          });
        });
      });
      renderResults(results);
      setupExportHandler(results);
      updateResultsDiv();
    }, 300);
  }

  // Renders the validation results table in the UI.
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
  }

  // Renders a summary of validation results.
  function renderSummary(results) {
    const validCount = results.filter(r => r.valid).length;
    const total = results.length;
    const pct = total ? Math.round((validCount / total) * 100) : 0;
    validationDiv.textContent = `Validation completed: ${validCount}/${total} valid (${pct}%)`;
    validationDiv.className = pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message';
  }

  // Renders the table body for the results table.
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
      const formatEligibility = r => `
        <div>${r.packageName || 'NO PACKAGE NAME'}</div>
        <div>${r.serviceCategory || ''} ${r.consultationStatus || ''}</div>
        <div>${r.effectiveDate || ''} → ${r.expiryDate || ''}</div>
        <div>${r.cardNumber || ''} (${r.cardStatus || ''})</div>
      `;
      appendCell(tr, r.claimId, { verticalAlign: 'top' });
      appendCell(tr, r.activityId);
      appendCell(tr, encounterDate);
      appendCell(tr, formatClinicianCell(
        r.orderingId,
        r.orderingName,
        r.orderingCategory,
        r.orderingPrivileges,
        r.orderingFrom,
        r.orderingTo
      ), { isHTML: true });
      appendCell(tr, formatClinicianCell(
        r.performingId,
        r.performingName,
        r.performingCategory,
        r.performingPrivileges,
        r.performingFrom,
        r.performingTo
      ), { isHTML: true });
      appendCell(tr, r.status || 'N/A');
      appendCell(tr, formatEligibility(r), { isHTML: true });
      appendCell(tr, r.valid ? '✔︎' : '✘');
      appendCell(tr, r.remarks, { isArray: true });
      tbody.appendChild(tr);
    });
    return tbody;
  }

  // Renders the table header for the results table.
  function renderTableHeader() {
    const thead = document.createElement('thead');
    const row = document.createElement('tr');
    [
      'Claim ID',
      'Activity ID',
      'Activity Start (Encounter Date)',
      'Ordering Clinician',
      'Performing Clinician',
      'License Status',
      'Eligibility',
      'Valid',
      'Remarks'
    ].forEach(text => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text;
      row.appendChild(th);
    });
    thead.appendChild(row);
    return thead;
  }

  // Sets up the export button to generate and download the results as an XLSX file.
  function setupExportHandler(results) {
    exportCsvBtn.disabled = false;
    exportCsvBtn.onclick = function () {
      if (!xmlDoc) { alert('No XML document loaded for export.'); return; }
      const senderID = (xmlDoc.querySelector('Header > SenderID')?.textContent || 'UnknownSender').trim();
      const transactionDateRaw = (xmlDoc.querySelector('Header > TransactionDate')?.textContent || '').trim();
      let transactionDateFormatted = 'UnknownDate';
      if (transactionDateRaw) {
        const dateParts = transactionDateRaw.split(' ')[0].split('/');
        if (dateParts.length === 3) transactionDateFormatted = `${dateParts[2]}-${dateParts[1].padStart(2, '0')}-${dateParts[0].padStart(2, '0')}`;
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
        r.status || '', r.packageName || '',
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
        rows.forEach(r => { const v = r[i]; if (v && v.toString().length > maxLen) maxLen = v.toString().length; });
        return { wch: Math.min(maxLen + 5, 50) };
      });
      XLSX.utils.book_append_sheet(wb, ws, 'Validation Results');
      const filename = `ClinicianCheck_${senderID}_${transactionDateFormatted}.xlsx`;
      XLSX.writeFile(wb, filename);
    };
  }

  // Converts an Excel sheet to JSON, respecting custom headers and row structure.
  function sheetToJsonWithHeader(file, sheetIndex = 0, headerRow = 1) {
    return file.arrayBuffer().then(buffer => {
      const data = new Uint8Array(buffer);
      const wb = XLSX.read(data, { type: 'array' });
      const name = wb.SheetNames[sheetIndex];
      if (!name) throw new Error(`Sheet index ${sheetIndex} not found`);
      const sheet = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const headerRowIndex = headerRow - 1;
      if (!rows || rows.length <= headerRowIndex) throw new Error(`Header row not found at position ${headerRowIndex + 1}`);
      const rawHeaders = rows[headerRowIndex];
      const headers = rawHeaders.map(h => (h || '').toString().trim());
      const dataRows = rows.slice(headerRowIndex + 1);
      return dataRows.map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i] || ''; });
        return obj;
      });
    });
  }

  // Checks if the encounter window (start/end) falls within the clinician's eligibility window.
  function checkEligibility(encounterStartStr, encounterEndStr, xlsxRow) {
    const encounterStart = parseDate(encounterStartStr);
    const encounterEnd = parseDate(encounterEndStr);
    const effectiveDate = new Date(xlsxRow.from);
    const expiryDate = new Date(xlsxRow.to);
    const remarks = [];
    let eligible = true;

    if (isNaN(encounterStart) || isNaN(encounterEnd)) {
      remarks.push("Invalid Encounter dates in XML");
      eligible = false;
    } else if (!effectiveDate || !expiryDate || isNaN(effectiveDate) || isNaN(expiryDate)) {
      remarks.push("Invalid Effective/Expiry dates in Excel");
      eligible = false;
    } else {
      if (!(encounterStart >= effectiveDate && encounterEnd <= expiryDate)) {
        remarks.push("Procedure is done outside of Eligibility window");
        eligible = false;
      }
    }
    return { eligible, remarks, eligibilityValue: xlsxRow.eligibility || '' };
  }

  // Returns a default clinician data object if not found in Shafafiya map.
  function defaultClinicianData() { return { name: 'Unknown', category: 'Unknown', privileges: 'Unknown' }; }

  // Generates remarks for category/privilege mismatches.
  function generateRemarks(od, pd) {
    const r = [];
    if (od.category !== pd.category) r.push(`Category mismatch (${od.category} vs ${pd.category})`);
    return r.join('; ');
  }

  // Validates clinician assignments based on IDs, categories, and privileges.
  function validateClinicians(orderingId, performingId, od, pd) {
    if (!orderingId || !performingId) return false;
    if (orderingId === performingId) return true;
    if (od.category !== pd.category) return false;
    return true;
  }

  // Parses a date string or Excel serial number into a JavaScript Date object.
  function parseDate(dateStr) {
    if (!dateStr) return new Date('Invalid');
    if (!isNaN(dateStr)) {
      const excelSerial = parseFloat(dateStr);
      if (!isNaN(excelSerial)) return new Date((excelSerial - (25567 + 2)) * 86400 * 1000);
    }
    let d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;
    d = new Date(dateStr.replace(/(\d+)\/(\d+)\/(\d+)/, '$2/$1/$3')); // DD/MM/YYYY
    if (!isNaN(d.getTime())) return d;
    d = new Date(dateStr.replace(/(\d+)-(\d+)-(\d+)/, '$1/$2/$3')); // YYYY-MM-DD
    if (!isNaN(d.getTime())) return d;
    return new Date('Invalid');
  }

  // Retrieves text content of a child tag from a parent element.
  function getText(parent, tag) {
    const el = parent.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : '';
  }

  // Utility function to extract text from an element
  function getTextContent(parent, selector, fallback = '') {
    return parent.querySelector(selector)?.textContent.trim() || fallback;
  }

  // Facility/license/status/other helpers, called during claim processing
  function checkFacilityMismatch(license, providerId) {
    const statusRecords = clinicianStatusMap[license];
    return statusRecords?.every(entry => entry.facility !== providerId);
  }

  function checkMostRecentStatus(license, activityDate) {
    const statusRecords = clinicianStatusMap[license];
    if (!statusRecords || statusRecords.length === 0) return null;
    const pastRecords = statusRecords.filter(entry => entry.effectiveDate <= activityDate);
    if (pastRecords.length === 0) return null;
    pastRecords.sort((a, b) => b.effectiveDate - a.effectiveDate);
    return pastRecords[0];
  }

  function validateClinicianStatus(clinicianId, providerId, encounterStartStr) {
    const remarks = [];
    let eligible = true;
  
    if (!clinicianId) {
      remarks.push('Missing Clinician ID');
      eligible = false; return { eligible, remarks };
    }
  
    if (!providerId) {
      remarks.push('Missing Provider ID');
      eligible = false; return { eligible, remarks };
    }
  
    if (!encounterStartStr) {
      remarks.push('Missing Encounter Start Date');
      eligible = false; return { eligible, remarks };
    }
  
    const records = clinicianStatusMap[clinicianId];
    if (!records || records.length === 0) {
      remarks.push(`Clinician (${clinicianId}) not found in status data`);
      eligible = false; return { eligible, remarks };
    }
  
    // Parse encounter date as Date object for comparison
    const encounterDate = new Date(encounterStartStr);
    if (isNaN(encounterDate.getTime())) {
      remarks.push('Invalid Encounter Start Date');
      eligible = false; return { eligible, remarks };
    }
  
    // Filter records by matching providerId (Facility License Number)
    const providerMatches = records.filter(rec => rec.facilityLicenseNumber === providerId);
    if (providerMatches.length === 0) {
      remarks.push(`No matching Facility License Number (${providerId}) for clinician`);
      eligible = false; return { eligible, remarks };
    }
  
    // Find the most recent effective date on or before encounterDate
    let validRecord = null;
    for (const rec of providerMatches) {
      const effDate = new Date(rec.effectiveDate);
      if (!isNaN(effDate.getTime()) && effDate <= encounterDate) {
        if (!validRecord || effDate > new Date(validRecord.effectiveDate)) {
          validRecord = rec;
        }
      }
    }
  
    if (!validRecord) {
      remarks.push(`No effective date record on or before encounter date for clinician`);
      eligible = false; return { eligible, remarks };
    }
  
    if (validRecord.status.toLowerCase() === 'inactive') {
      remarks.push(`Clinician status is Inactive as of ${validRecord.effectiveDate}`);
      eligible = false;
    }
    return { eligible, remarks };
  }

  // Load clinician status XLSX and build clinicianStatusMap; update the unified message div
  function handleClinicianStatusExcelInput(file) {
    // Show a loading message in the unified update area
    const messageDiv = document.getElementById('update-message');
    if (messageDiv) {
      messageDiv.textContent = 'Loading clinician history…';
    }
  
    return sheetToJsonWithHeader(file, 0, 1).then(data => {
      clinicianStatusMap = {};
      data.forEach(row => {
        const licenseNumber = (row['License Number'] || '').toString().trim();
        const facilityLicenseNumber = (row['Facility License Number'] || '').toString().trim();
        const effectiveDate = (row['Effective Date'] || '').toString().trim();
        const status = (row['Status'] || '').toString().trim();
  
        if (!licenseNumber) return;
  
        if (!clinicianStatusMap[licenseNumber]) {
          clinicianStatusMap[licenseNumber] = [];
        }
        clinicianStatusMap[licenseNumber].push({
          facilityLicenseNumber,
          effectiveDate,
          status
        });
      });
  
      // Count unique license numbers for histories
      const count = Object.keys(clinicianStatusMap).length;
      if (messageDiv) {
        messageDiv.textContent = `Loaded license history for ${count} unique clinician${count === 1 ? '' : 's'}.`;
      }
    }).catch(err => {
      const messageDiv = document.getElementById('update-message');
      if (messageDiv) {
        messageDiv.textContent = `Error loading clinician history: ${err.message}`;
      }
    });
  }

  /**
   * Updates the unified loader message area using current global counts.
   * - Claims: Based on `claimCount`
   * - Clinicians: Based on `clinicianCount`
   * - Eligibilities: Based on `openJetCount`
   * - Histories: Based on unique license numbers in `clinicianStatusMap`
   */
  function updateLoaderMessages() {
    const m = [], c = document.getElementById('update-message'); if (!c) return;
    if (claimCount) m.push(`${claimCount} claim${claimCount === 1 ? '' : 's'} loaded`);
    if (clinicianCount) m.push(`${clinicianCount} clinician${clinicianCount === 1 ? '' : 's'} loaded`);
    if (openJetCount) m.push(`${openJetCount} eligibilit${openJetCount === 1 ? 'y' : 'ies'} loaded`);
    const h = Object.keys(clinicianStatusMap).length;
    if (h) m.push(`${h} unique license histor${h === 1 ? 'y' : 'ies'} loaded`);
    c.textContent = m.length === 0 ? '' : m.length === 1 ? m[0] : m.slice(0, -1).join(', ') + ' and ' + m[m.length - 1];
  }


  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }


  // Helpers used only for export/XLSX or HTML table
  function appendCell(tr, content, { isHTML = false, isArray = false, verticalAlign = '' } = {}) {
    const td = document.createElement('td');
    if (verticalAlign) td.style.verticalAlign = verticalAlign;
    if (isArray) {
      td.style.whiteSpace = 'pre-line';
      td.textContent = '';
      content.forEach(text => {
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

})();
