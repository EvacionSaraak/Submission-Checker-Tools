(function () {
  'use strict';

  // === GLOBAL STATE ===
  let openJetData = [];
  let xmlDoc = null;
  let clinicianMap = null;
  let xmlInput, excelInput, openJetInput, clinicianStatusInput, resultsDiv, validationDiv, processBtn, exportCsvBtn;
  let clinicianCount = 0, openJetCount = 0, claimCount = 0;
  let clinicianStatusMap = {};
  const monthMap = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };

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
    clinicianStatusInput = document.getElementById('clinicianStatusFileInput');

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
    clinicianStatusInput.addEventListener('change', handleUnifiedExcelInput);

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
    if (!file) {
      xmlDoc = null; claimCount = 0;
      updateResultsDiv(); toggleProcessButton(); return;
    }
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

  // Helper: process any Excel file given its input element and a parsing callback.
  // Returns a Promise that resolves if no file is selected or after parseFn(data) completes.
  function processExcelInput(inputElement, sheetIndex, headerRow, parseFn) {
    if (!inputElement.files[0]) {
      return Promise.resolve();
    }
    return sheetToJsonWithHeader(inputElement.files[0], sheetIndex, headerRow)
      .then(data => parseFn(data))
      .catch(e => {
        console.error(`Error processing ${inputElement.id}:`, e);
        throw new Error(`Failed to process ${inputElement.id}: ${e.message}`);
      });
  }


  function handleUnifiedExcelInput() {
    showProcessing('Loading Excel files...');
    processBtn.disabled = true;
    exportCsvBtn.disabled = true;
  
    // Define each loader by specifying: input element, sheet index, header‐row, and how to parse.
    const loaders = [
      {
        inputElement: excelInput,
        sheetIndex:   0,
        headerRow:    1,
        parseFn: data => {
          clinicianMap = {};
          data.forEach(row => {
            const id = (row['Clinician License'] || '').toString().trim();
            if (!id) return;
            clinicianMap[id] = {
              name:       row['Clinician Name']     || row['Name']     || '',
              category:   row['Clinician Category'] || row['Category'] || '',
              privileges: row['Activity Group']     || row['Privileges'] || '',
              from:       row['Effective Date'] || '',
              to:         row['Expiry Date']   || '',
              status:     row['Status'] || ''
            };
          });
          clinicianCount = Object.keys(clinicianMap).length;
          updateLoaderMessages();
        }
      },
      {
        inputElement: openJetInput,
        sheetIndex:   0,
        headerRow:    2,
        parseFn: data => {
          openJetData = data.map(row => {
            const parseOpenJetDate = dateStr => {
              if (!dateStr) return new Date('Invalid');
              const parts    = dateStr.split(' ');
              const [day, mon, year] = parts[0].split('-');
              const monthMap = {
                'Jan':'01','Feb':'02','Mar':'03','Apr':'04',
                'May':'05','Jun':'06','Jul':'07','Aug':'08',
                'Sep':'09','Oct':'10','Nov':'11','Dec':'12'
              };
              return new Date(`${year}-${monthMap[mon]}-${day.padStart(2,'0')}`);
            };
            return {
              clinicianId:   (row['Clinician']   || '').toString().trim(),
              effectiveDate: parseOpenJetDate(row['EffectiveDate']),
              expiryDate:    parseOpenJetDate(row['ExpiryDate']),
              eligibility:   (row['Status']      || '').toString().trim()
            };
          }).filter(entry => entry.clinicianId);
          openJetCount = openJetData.length;
          updateLoaderMessages();
        }
      },
      {
        inputElement: clinicianStatusInput,
        sheetIndex:   0,
        headerRow:    1,
        parseFn: data => {
          clinicianStatusMap = {};
          data.forEach(row => {
            const licenseNumber         = (row['License Number']           || '').toString().trim().toUpperCase();
            const facilityLicenseNumber = (row['Facility License Number']  || '').toString().trim().toUpperCase();
            const effectiveDate         = (row['Effective Date']           || '').toString().trim().toUpperCase();
            const status                = (row['Status']                   || '').toString().trim().toUpperCase();
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
          updateLoaderMessages();
        }
      }
    ];
  
    // Kick off all parsers in parallel:
    const promises = loaders.map(loader =>
      processExcelInput(
        loader.inputElement,
        loader.sheetIndex,
        loader.headerRow,
        loader.parseFn
      )
    );
  
    Promise.all(promises)
      .then(() => {
        updateResultsDiv();
        toggleProcessButton();
      })
      .catch(e => {
        resultsDiv.innerHTML = `<p class="error-message">${e.message}</p>`;
        console.error('Excel loading error:', e);
        toggleProcessButton();
      });
  }


  // Enables/disables the process button based on data readiness.
  function toggleProcessButton() {
    processBtn.disabled = !(xmlDoc && clinicianMap && openJetData.length > 0);
  }

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

          // Eligibility and mapping logic
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

          // Validate clinician status using provider ID and encounter date
          if (clinicianStatusMap) {
            const providerId = getText(cl, 'ProviderID');
            const ordStatus = validateClinicianStatus(oid, providerId, encounterStartStr);
            const perfStatus = validateClinicianStatus(pid, providerId, encounterStartStr);
            rowRemarks.push(...ordStatus.remarks);
            rowRemarks.push(...perfStatus.remarks);
          }

          // Compose result row, defensively filling fields for export/table
          results.push({
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
            performingId: pid,
            performingName: pd.name,
            performingCategory: pd.category,
            performingPrivileges: pd.privileges || '',
            performingFrom: pd.from || '',
            performingTo: pd.to || '',
            performingEligibility: perfXlsxRow ? perfXlsxRow.eligibility : 'N/A',
            status: '', // Placeholder, can be filled out with more granular status logic if needed
            packageName: '',
            serviceCategory: '',
            consultationStatus: '',
            effectiveDate: '',
            expiryDate: '',
            cardNumber: '',
            cardStatus: '',
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
      appendCell(tr, (clinicianMap[r.performingId]?.status || clinicianMap[r.orderingId]?.status || 'N/A'));
      appendCell(tr, r.performingEligibility || r.orderingEligibility || 'N/A');
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
    const effectiveDate = new Date(xlsxRow.effectiveDate || xlsxRow.from);
    const expiryDate = new Date(xlsxRow.expiryDate || xlsxRow.to);
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
  function defaultClinicianData() { return { name: 'Unknown', category: 'Unknown', privileges: 'Unknown', from: '', to: '' }; }

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
    
    console.log(clinicianStatusMap);
    console.log(clinicianStatusMap[clinicianId]);
    
    if (!records || records.length === 0) {
      remarks.push(`Clinician (${clinicianId}) not found in status data`);
      eligible = false; return { eligible, remarks };
    }
    const encounterDate = new Date(encounterStartStr);
    if (isNaN(encounterDate.getTime())) {
      remarks.push('Invalid Encounter Start Date');
      eligible = false; return { eligible, remarks };
    }
    const providerMatches = records.filter(rec => rec.facilityLicenseNumber === providerId);
    if (providerMatches.length === 0) {
      remarks.push(`No matching Facility License Number (${providerId}) for clinician`);
      eligible = false; return { eligible, remarks };
    }
    // Find the most recent effective date on or before encounter date
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
    const messageDiv = document.getElementById('update-message');
    if (messageDiv) {
      messageDiv.textContent = 'Loading clinician history…';
    }
    return sheetToJsonWithHeader(file, 0, 1).then(data => {
      clinicianStatusMap = {};
      data.forEach(row => {
        const licenseNumber = (row['License Number'] || '').toString().trim().toUpperCase();
        const facilityLicenseNumber = (row['Facility License Number'] || '').toString().trim().toUpperCase();
        const effectiveDate = (row['Effective Date'] || '').toString().trim().toUpperCase();
        const status = (row['Status'] || '').toString().trim().toUpperCase();
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
   * Updates the single‐line loader message based on global counts.
   * - claimCount
   * - clinicianCount
   * - openJetCount
   * - unique license histories in clinicianStatusMap
   */
  function updateLoaderMessages() {
    const container = document.getElementById('update-message');
    if (!container) return;
  
    const m = [];
    if (claimCount) {
      m.push(`${claimCount} claim${claimCount === 1 ? '' : 's'} loaded`);
    }
    if (clinicianCount) {
      m.push(`${clinicianCount} clinician${clinicianCount === 1 ? '' : 's'} loaded`);
    }
    if (openJetCount) {
      m.push(`${openJetCount} eligibilit${openJetCount === 1 ? 'y' : 'ies'} loaded`);
    }
    const historyCount = Object.keys(clinicianStatusMap).length;
    if (historyCount) {
      m.push(`${historyCount} unique license histor${historyCount === 1 ? 'y' : 'ies'} loaded`);
    }
  
    if (m.length === 0) {
      container.textContent = '';
    } else if (m.length === 1) {
      container.textContent = m[0];
    } else {
      container.textContent = m.slice(0, -1).join(', ') + ' and ' + m[m.length - 1];
    }
  }

  // Helpers used only for export/XLSX or HTML table
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

})();
