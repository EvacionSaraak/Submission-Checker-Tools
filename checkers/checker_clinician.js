/**
 * Clinician Checker Tool (refactored)
 * Validates XML submissions for clinician assignments.
 * Handles Excel and OpenJet files for metadata, including eligibility window checks.
 * Applies robust error handling, modular utilities, and improved UI feedback.
 * (c) 2025
 */

(function () {
  'use strict';

  // === GLOBAL STATE ===
  let openJetData = [];           // Array of objects from Open Jet XLSX, each row has Clinician, EffectiveDate, ExpiryDate, Eligibility
  let xmlDoc = null;
  let clinicianMap = null;        // From Shafafiya Excel: map[clinicianID] → { name, category, privileges }
  let xmlInput, excelInput, openJetInput, resultsDiv, validationDiv, processBtn, exportCsvBtn;
  let clinicianCount = 0, openJetCount = 0, claimCount = 0;

  // === UTILITY FUNCTIONS ===

  /**
   * Converts an Excel file to JSON, using a specific sheet and header row.
   */
  function sheetToJsonWithHeader(file, sheetIndex = 0, headerRow = 1, skipRowAboveHeader = false) {
    return file.arrayBuffer().then(buffer => {
      const data = new Uint8Array(buffer);
      const wb = XLSX.read(data, { type: 'array' });
      const name = wb.SheetNames[sheetIndex];
      if (!name) throw new Error(`Sheet index ${sheetIndex} not found in file: ${file.name}`);
      const sheet = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const headerRowIndex = (headerRow - 1) + (skipRowAboveHeader ? 1 : 0);
      if (!rows || rows.length <= headerRowIndex) {
        throw new Error(`Header row ${headerRowIndex + 1} out of range in file: ${file.name}`);
      }
      const rawHeaders = rows[headerRowIndex];
      const headers = rawHeaders.map(h => (h || '').toString().trim());
      const dataRows = rows.slice(headerRowIndex + 1);
      return dataRows.map(row => {
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = row[i] || '';
        });
        return obj;
      });
    });
  }

  /**
   * Shows a processing spinner/message.
   */
  function showProcessing(msg = "Processing...") {
    resultsDiv.innerHTML = `<div class="loading-spinner" aria-live="polite"></div><p>${msg}</p>`;
  }

  /**
   * Returns a default clinician data object if not found in Shafafiya map.
   */
  function defaultClinicianData() {
    return { name: 'Unknown', category: 'Unknown', privileges: 'Unknown' };
  }

  /**
   * Validates clinician assignments based on IDs, categories, and privileges.
   */
  function validateClinicians(orderingId, performingId, od, pd) {
    if (!orderingId || !performingId) return false;
    if (orderingId === performingId) return true;
    if (od.category !== pd.category) return false;
    if (!String(od.privileges).includes('Allowed') || !String(pd.privileges).includes('Allowed')) return false;
    return true;
  }

  /**
   * Generates remarks for category/privilege mismatches.
   */
  function generateRemarks(od, pd) {
    const r = [];
    if (od.category !== pd.category) {
      r.push(`Category mismatch (${od.category} vs ${pd.category})`);
    }
    if (!String(od.privileges).includes('Allowed')) {
      r.push(`Ordering privileges not allowed (${od.privileges})`);
    }
    if (!String(pd.privileges).includes('Allowed')) {
      r.push(`Performing privileges not allowed (${pd.privileges})`);
    }
    return r.join('; ');
  }

  /**
   * Parses a date string (e.g., "YYYY-MM-DD") into a JavaScript Date object.
   */
  function parseDate(dateStr) {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? new Date('Invalid') : d;
  }

  /**
   * Checks if the encounter window (start/end) falls within the clinician's eligibility window.
   * Returns an object: { eligible: boolean, remarks: [...], eligibilityValue: string }
   */
  function checkEligibility(encounterStartStr, encounterEndStr, xlsxRow) {
    const encounterStart = parseDate(encounterStartStr);
    const encounterEnd = parseDate(encounterEndStr);
    const effectiveDate = parseDate(xlsxRow.EffectiveDate);
    const expiryDate = parseDate(xlsxRow.ExpiryDate);

    const remarks = [];
    let eligible = true;

    if (isNaN(encounterStart) || isNaN(encounterEnd)) {
      remarks.push("Invalid Encounter dates in XML");
      eligible = false;
    } else if (isNaN(effectiveDate) || isNaN(expiryDate)) {
      remarks.push("Invalid Effective/Expiry dates in Open Jet XLSX");
      eligible = false;
    } else {
      if (!(encounterStart >= effectiveDate && encounterEnd <= expiryDate)) {
        remarks.push("Procedure is done outside of Eligibility window");
        eligible = false;
      }
    }

    return {
      eligible,
      remarks,
      eligibilityValue: xlsxRow.Eligibility || ''
    };
  }

  /**
   * Retrieves text content of a child tag from a parent element.
   */
  function getText(parent, tag) {
    const el = parent.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : '';
  }

  // === UI FUNCTIONS ===

  function toggleProcessButton() {
    processBtn.disabled = !(xmlDoc && clinicianMap && openJetData.length > 0);
  }

  function updateResultsDiv() {
    const messages = [];
    if (clinicianCount > 0) messages.push(`${clinicianCount} clinicians loaded`);
    if (openJetCount > 0) messages.push(`${openJetCount} Open Jet rows loaded`);
    if (claimCount > 0) messages.push(`${claimCount} claims loaded`);
    resultsDiv.textContent = messages.join(', ');
    toggleProcessButton();
  }

  /**
   * Renders the results in a table, with summary, styling, and accessibility.
   */
  function renderResults(results) {
    clearOutput();
    if (!results.length) {
      showNoResults();
      return;
    }
    renderSummary(results);

    const table = document.createElement('table');
    table.setAttribute('aria-label', 'Clinician validation results');
    table.appendChild(renderTableHeader());
    table.appendChild(renderTableBody(results));
    resultsDiv.appendChild(table);
  }

  function clearOutput() {
    resultsDiv.innerHTML = '';
    validationDiv.textContent = '';
  }

  function showNoResults() {
    resultsDiv.innerHTML = '<p>No results found.</p>';
  }

  function renderSummary(results) {
    const validCount = results.filter(r => r.valid).length;
    const total = results.length;
    const pct = total ? Math.round((validCount / total) * 100) : 0;

    validationDiv.textContent = `Validation completed: ${validCount}/${total} valid (${pct}%)`;
    validationDiv.className = pct > 90
      ? 'valid-message'
      : pct > 70
        ? 'warning-message'
        : 'error-message';
  }

  function renderTableHeader() {
    const thead = document.createElement('thead');
    const row = document.createElement('tr');
    ['Claim ID', 'Activity ID',
     'Ordering Clinician', 'Ordering Category', 'Ordering Eligibility',
     'Performing Clinician', 'Performing Category', 'Performing Eligibility',
     'Valid', 'Remarks'
    ].forEach(text => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = text;
      row.appendChild(th);
    });
    thead.appendChild(row);
    return thead;
  }

  function renderTableBody(results) {
    const tbody = document.createElement('tbody');
    results.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = r.valid ? 'valid' : 'invalid';

      appendCell(tr, r.claimId, { verticalAlign: 'top' });
      appendCell(tr, r.activityId);
      appendCell(tr, `${r.orderingId} - ${r.orderingName}`, { isHTML: false });
      appendCell(tr, r.orderingCategory);
      appendCell(tr, r.orderingEligibility);
      appendCell(tr, `${r.performingId} - ${r.performingName}`, { isHTML: false });
      appendCell(tr, r.performingCategory);
      appendCell(tr, r.performingEligibility);
      appendCell(tr, r.valid ? '✔︎' : '✘');
      appendCell(tr, r.remarks, { isArray: true });

      tbody.appendChild(tr);
    });
    return tbody;
  }

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

  // === DATA PROCESSING ===

  /**
   * Main processing function: iterates over claims, validates clinicians, and checks eligibility windows.
   */
  function processClaims(d, map) {
    showProcessing();
    setTimeout(() => {
      const claimNodes = Array.from(d.getElementsByTagName('Claim'));
      const results = [];
      claimCount = claimNodes.length;

      claimNodes.forEach(cl => {
        const cid = getText(cl, 'ID') || 'N/A';
        const encounterNode = cl.getElementsByTagName('Encounter')[0];
        const encounterStartStr = encounterNode ? getText(encounterNode, 'Start') : '';
        const encounterEndStr   = encounterNode ? getText(encounterNode, 'End')   : '';
        const activities = Array.from(cl.getElementsByTagName('Activity'));

        activities.forEach(act => {
          const aid = getText(act, 'ID') || 'N/A';
          const oid = getText(act, 'OrderingClinician') || '';
          const pid = getText(act, 'Clinician') || '';

          const od = map[oid] || defaultClinicianData();
          const pd = map[pid] || defaultClinicianData();

          const rowRemarks = [];
          let rowValid = true;

          // --- 1. Check presence in Open Jet data and capture XLSX row ---
          const ordXlsxRow = openJetData.find(r => r.Clinician === oid);
          const perfXlsxRow = openJetData.find(r => r.Clinician === pid);

          if (!ordXlsxRow) {
            rowRemarks.push(`Ordering Clinician (${oid}) not in Open Jet`);
            rowValid = false;
          }
          if (!perfXlsxRow) {
            rowRemarks.push(`Performing Clinician (${pid}) not in Open Jet`);
            rowValid = false;
          }

          // --- 2. Validate categories & privileges from Shafafiya data ---
          const basicValid = validateClinicians(oid, pid, od, pd);
          if (!basicValid) {
            rowRemarks.push(generateRemarks(od, pd));
            rowValid = false;
          }

          // --- 3. Eligibility date checks for both clinicians ---
          if (ordXlsxRow) {
            const ordEligRes = checkEligibility(encounterStartStr, encounterEndStr, ordXlsxRow);
            if (!ordEligRes.eligible) {
              rowRemarks.push(`Ordering: ${ordEligRes.remarks.join('; ')}`);
              rowValid = false;
            }
          }
          if (perfXlsxRow) {
            const perfEligRes = checkEligibility(encounterStartStr, encounterEndStr, perfXlsxRow);
            if (!perfEligRes.eligible) {
              rowRemarks.push(`Performing: ${perfEligRes.remarks.join('; ')}`);
              rowValid = false;
            }
          }

          // --- 4. Build the result record ---
          results.push({
            claimId: cid,
            activityId: aid,
            orderingId: oid,
            orderingName: od.name,
            orderingCategory: od.category,
            orderingEligibility: ordXlsxRow ? ordXlsxRow.Eligibility : 'N/A',
            performingId: pid,
            performingName: pd.name,
            performingCategory: pd.category,
            performingEligibility: perfXlsxRow ? perfXlsxRow.Eligibility : 'N/A',
            valid: rowValid,
            remarks: rowRemarks
          });
        });
      });

      renderResults(results);
      setupExportHandler(results);
    }, 300); // simulate loading
  }

  /**
   * Prepares and triggers the Excel export of results.
   */
  function setupExportHandler(results) {
    exportCsvBtn.disabled = false;
    exportCsvBtn.onclick = function () {
      if (!xmlDoc) {
        alert('No XML document loaded for export.');
        return;
      }
      // Extract SenderID
      const senderID = (xmlDoc.querySelector('Header > SenderID')?.textContent || 'UnknownSender').trim();
      // Extract TransactionDate (dd/MM/yyyy HH:mm)
      const transactionDateRaw = (xmlDoc.querySelector('Header > TransactionDate')?.textContent || '').trim();
      let transactionDateFormatted = 'UnknownDate';
      if (transactionDateRaw) {
        const dateParts = transactionDateRaw.split(' ')[0].split('/');
        if (dateParts.length === 3) {
          transactionDateFormatted = `${dateParts[2]}-${dateParts[1].padStart(2, '0')}-${dateParts[0].padStart(2, '0')}`;
        }
      }

      // Prepare data rows
      const headers = [
        'Claim ID', 'Activity ID',
        'Ordering Clinician ID', 'Ordering Category', 'Ordering Eligibility',
        'Performing Clinician ID', 'Performing Category', 'Performing Eligibility',
        'Valid/Invalid', 'Remarks'
      ];
      const rows = results.map(r => [
        r.claimId,
        r.activityId,
        r.orderingId,
        r.orderingCategory,
        r.orderingEligibility,
        r.performingId,
        r.performingCategory,
        r.performingEligibility,
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
          if (v && v.toString().length > maxLen) {
            maxLen = v.toString().length;
          }
        });
        return { wch: Math.min(maxLen + 5, 50) };
      });
      XLSX.utils.book_append_sheet(wb, ws, 'Validation Results');
      const filename = `ClinicianCheck_${senderID}_${transactionDateFormatted}.xlsx`;
      XLSX.writeFile(wb, filename);
    };
  }

  // === EVENT HANDLERS ===

  /**
   * Handles Shafafiya Excel and Open Jet Excel inputs.
   */
  function handleUnifiedExcelInput() {
    showProcessing('Loading Excel files...');
    processBtn.disabled = true;
    const promises = [];

    // Load Shafafiya Excel → clinicianMap
    if (excelInput.files[0]) {
      promises.push(
        sheetToJsonWithHeader(excelInput.files[0], 0, 1, false).then(data => {
          clinicianMap = {};
          data.forEach(row => {
            const id = (row['Clinician License'] || '').toString().trim();
            if (id) {
              clinicianMap[id] = {
                name: row['Clinician Name'] || row['Name'] || '',
                category: row['Clinician Category'] || row['Category'] || '',
                privileges: row['Activity Group'] || row['Privileges'] || ''
              };
            }
          });
          clinicianCount = Object.keys(clinicianMap).length;
          updateResultsDiv();
        })
      );
    }

    // Load Open Jet Excel → openJetData
    if (openJetInput.files[0]) {
      promises.push(
        sheetToJsonWithHeader(openJetInput.files[0], 0, 1, false).then(data => {
          openJetData = data.map(row => ({
            Clinician: (row['Clinician'] || '').toString().trim(),
            EffectiveDate: (row['EffectiveDate'] || '').toString().trim(),
            ExpiryDate: (row['ExpiryDate'] || '').toString().trim(),
            Eligibility: (row['Eligibility'] || '').toString().trim()
          }));
          openJetCount = openJetData.length;
          updateResultsDiv();
        })
      );
    }

    Promise.all(promises).catch(e => {
      resultsDiv.innerHTML = `<p class="error-message">Error loading Excel files: ${e.message}</p>`;
      toggleProcessButton();
    });
  }

  /**
   * Handles XML file input changes.
   */
  function handleXmlInput() {
    showProcessing('Loading XML...');
    processBtn.disabled = true;
    const file = xmlInput.files[0];
    if (!file) {
      xmlDoc = null;
      claimCount = 0;
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
      updateResultsDiv();
      toggleProcessButton();
    }).catch(e => {
      xmlDoc = null;
      claimCount = 0;
      resultsDiv.innerHTML = `<p class="error-message">Error loading XML: ${e.message}</p>`;
      toggleProcessButton();
    });
  }

  /**
   * Initializes UI elements and event listeners.
   */
  function initEventListeners() {
    xmlInput = document.getElementById('xmlFileInput');
    excelInput = document.getElementById('excelFileInput');
    openJetInput = document.getElementById('openJetFileInput');
    resultsDiv = document.getElementById('results');
    validationDiv = document.createElement('div');
    validationDiv.id = 'validation-message';
    resultsDiv.parentNode.insertBefore(validationDiv, resultsDiv);
    processBtn = document.getElementById('processBtn');
    exportCsvBtn = document.getElementById('exportCsvBtn');

    // ARIA roles
    resultsDiv.setAttribute('role', 'region');
    validationDiv.setAttribute('role', 'status');

    // Input listeners
    xmlInput.addEventListener('change', handleXmlInput);
    excelInput.addEventListener('change', handleUnifiedExcelInput);
    openJetInput.addEventListener('change', handleUnifiedExcelInput);

    // Process button
    processBtn.addEventListener('click', () => {
      if (xmlDoc && clinicianMap && openJetData.length > 0) {
        processClaims(xmlDoc, clinicianMap);
      }
    });
  }

  // === INITIALIZE ===
  document.addEventListener('DOMContentLoaded', initEventListeners);

  // Global error handler
  window.onerror = function (msg, url, line, col, error) {
    if (resultsDiv) {
      resultsDiv.innerHTML = `<p class="error-message">Unexpected error: ${msg} at ${line}:${col}</p>`;
    }
  };

})();
