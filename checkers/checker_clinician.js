/**
 * Clinician Checker Tool (refactored)
 * Validates XML submissions for clinician assignments.
 * Handles Excel and OpenJet files for metadata.
 * Applies robust error handling, modular utilities, and improved UI feedback.
 * (c) 2025
 */

(function () {
  'use strict';

  // === GLOBAL STATE ===
  let openJetClinicianList = [];
  let xmlDoc = null;
  let clinicianMap = null;
  let xmlInput, excelInput, openJetInput, resultsDiv, validationDiv, processBtn, exportCsvBtn;
  let clinicianCount = 0, openJetCount = 0, claimCount = 0;

  // === UTILITY FUNCTIONS ===

  /**
   * Converts an Excel file (File object) to JSON with header parsing.
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
   * Shows a processing message with spinner.
   */
  function showProcessing(msg = "Processing...") {
    resultsDiv.innerHTML = `<div class="loading-spinner" aria-live="polite"></div><p>${msg}</p>`;
  }

  /**
   * Utility logger for development/debug.
   */
  function log(level, ...args) {
    if (level === 'error') {
      console.error('[ClinicianChecker]', ...args);
    } else {
      console.log('[ClinicianChecker]', ...args);
    }
  }

  /**
   * Returns a default clinician data object.
   */
  function defaultClinicianData() {
    return { name: 'Unknown', category: 'Unknown', privileges: 'Unknown' };
  }

  /**
   * Validates clinician assignments based on IDs, categories, privileges.
   */
  function validateClinicians(o, p, od, pd) {
    if (!o || !p) return false;
    if (o === p) return true;
    if (od.category !== pd.category) return false;
    if (!String(od.privileges).includes('Allowed') || !String(pd.privileges).includes('Allowed')) return false;
    return true;
  }

  /**
   * Generates remarks based on mismatches.
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
   * Gets text content from a child tag.
   */
  function getText(p, tag) {
    const el = p.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : '';
  }

  // === UI FUNCTIONS ===

  function toggleProcessButton() {
    processBtn.disabled = !(xmlDoc && clinicianMap && openJetClinicianList.length > 0);
  }

  function updateResultsDiv() {
    let messages = [];
    if (clinicianCount > 0) messages.push(`${clinicianCount} clinicians loaded`);
    if (openJetCount > 0) messages.push(`${openJetCount} Open Jet IDs loaded`);
    if (claimCount > 0) messages.push(`${claimCount} claims loaded`);
    resultsDiv.textContent = messages.join(', ');
    toggleProcessButton();
  }

  /**
   * Renders results in a table, applies accessibility and styling.
   */
  function renderResults(results) {
    resultsDiv.innerHTML = '';
    validationDiv.innerHTML = '';

    if (!results.length) {
      resultsDiv.innerHTML = '<p>No results found.</p>';
      return;
    }

    const validCount = results.filter(r => r.valid).length;
    const total = results.length;
    const pct = Math.round((validCount / total) * 100);

    validationDiv.textContent = `Validation completed: ${validCount}/${total} valid (${pct}%)`;
    validationDiv.className = pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message';

    const table = document.createElement('table');
    table.setAttribute('aria-label', 'Clinician validation results');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Claim ID', 'Act ID', 'Clinicians', 'Privileges', 'Categories', 'Valid', 'Remarks'].forEach(t => {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = t;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    let prevClaimId = null;
    results.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = r.valid ? 'valid' : 'invalid';

      // Claim ID column
      const td0 = document.createElement('td');
      td0.textContent = (r.claimId !== prevClaimId) ? r.claimId : '';
      td0.style.verticalAlign = 'top';
      prevClaimId = r.claimId;
      tr.appendChild(td0);

      // Other columns
      const cols = [
        r.activityId,
        formatClinicianInfo(r.clinicianInfo),
        r.privilegesInfo,
        r.categoryInfo,
        r.valid ? '\u2714\ufe0f' : '\u274c',
        r.remarks
      ];
      cols.forEach((txt, idx) => {
        const td = document.createElement('td');
        if (idx === 1) {
          td.style.whiteSpace = 'pre-line';
          td.innerHTML = txt;
        } else {
          td.style.whiteSpace = String(txt).includes('\n') ? 'pre-line' : 'nowrap';
          td.textContent = txt;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    resultsDiv.appendChild(table);
  }

  /**
   * Formats clinician info for display (bold, italics).
   */
  function formatClinicianInfo(text) {
    if (!text) return '';
    text = text.replace(/\b(Ordering|Performing):/g, '<b>$1:</b>');
    text = text.replace(/\bDr\b\s/g, '<i>Dr</i> ');
    return text;
  }

  // === DATA PROCESSING ===

  function processClaims(d, m) {
    showProcessing();
    setTimeout(() => {
      const claims = Array.from(d.getElementsByTagName('Claim'));
      const res = [];
      claims.forEach(cl => {
        const cid = getText(cl, 'ID') || 'N/A';
        const acts = Array.from(cl.getElementsByTagName('Activity'));
        acts.forEach(act => {
          const aid = getText(act, 'ID') || 'N/A';
          const oid = getText(act, 'OrderingClinician') || '';
          const pid = getText(act, 'Clinician') || '';
          const od = m[oid] || defaultClinicianData();
          const pd = m[pid] || defaultClinicianData();

          const rem = [];
          if (pid && !openJetClinicianList.includes(pid)) {
            rem.push(`Performing Clinician (${pid}) not in Open Jet`);
          }
          if (oid && !openJetClinicianList.includes(oid)) {
            rem.push(`Ordering Clinician (${oid}) not in Open Jet`);
          }

          const valid = validateClinicians(oid, pid, od, pd);
          if (!valid) {
            rem.push(generateRemarks(od, pd));
          }

          res.push({
            claimId: cid,
            activityId: aid,
            clinicianInfo: `Ordering: ${oid} - ${od.name}\nPerforming: ${pid} - ${pd.name}`,
            privilegesInfo: `Ordering: ${od.privileges}\nPerforming: ${pd.privileges}`,
            categoryInfo: `Ordering: ${od.category}\nPerforming: ${pd.category}`,
            valid,
            remarks: rem.join('; '),
            rowSpan: 1
          });
        });
      });

      // Merge claim rows for display
      for (let i = 1; i < res.length; i++) {
        if (res[i].claimId === res[i - 1].claimId) {
          res[i].rowSpan = 0;
          res[i - 1].rowSpan++;
        }
      }

      renderResults(res);
      setupExportHandler(res);
    }, 300); // Simulate loading
  }

  /**
   * Handles exporting results to Excel (or add CSV/JSON as needed).
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
      // Extract TransactionDate (format: dd/MM/yyyy HH:mm)
      const transactionDateRaw = (xmlDoc.querySelector('Header > TransactionDate')?.textContent || '').trim();
      let transactionDateFormatted = 'UnknownDate';
      if (transactionDateRaw) {
        const dateParts = transactionDateRaw.split(' ')[0].split('/');
        if (dateParts.length === 3) {
          transactionDateFormatted = `${dateParts[2]}-${dateParts[1].padStart(2, '0')}-${dateParts[0].padStart(2, '0')}`;
        }
      }
      // Prepare data rows for XLSX
      const headers = [
        'Claim ID', 'Activity ID', 'Valid/Invalid', 'Remarks',
        'Ordering Clinician ID', 'Ordering Privilege', 'Ordering Category',
        'Performing Clinician ID', 'Performing Privilege', 'Performing Category'
      ];
      const rows = results.map(r => {
        let orderingID = '', performingID = '';
        if (r.clinicianInfo) {
          const lines = r.clinicianInfo.split('\n');
          const orderingLine = lines.find(l => l.startsWith('Ordering:')) || '';
          const performingLine = lines.find(l => l.startsWith('Performing:')) || '';
          const orderMatch = orderingLine.match(/^Ordering:\s*(\S+)\s*-/);
          orderingID = orderMatch ? orderMatch[1] : '';
          const performMatch = performingLine.match(/^Performing:\s*(\S+)\s*-/);
          performingID = performMatch ? performMatch[1] : '';
        }
        return [
          r.claimId,
          r.activityId,
          r.valid ? 'Valid' : 'Invalid',
          r.remarks,
          orderingID,
          r.privilegesInfo.split('\n')[0].replace(/^Ordering:\s*/, '') || '',
          r.categoryInfo.split('\n')[0].replace(/^Ordering:\s*/, '') || '',
          performingID,
          r.privilegesInfo.split('\n')[1]?.replace(/^Performing:\s*/, '') || '',
          r.categoryInfo.split('\n')[1]?.replace(/^Performing:\s*/, '') || ''
        ];
      });
      // Create workbook and worksheet
      const wb = XLSX.utils.book_new();
      const wsData = [headers, ...rows];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };
      ws['!cols'] = headers.map((h, i) => {
        let maxLen = h.length;
        rows.forEach(r => {
          const v = r[i];
          if (v) maxLen = Math.max(maxLen, v.toString().length);
        });
        return { wch: Math.min(maxLen + 5, 50) };
      });
      XLSX.utils.book_append_sheet(wb, ws, 'Validation Results');
      const filename = `ClaimsValidation__${senderID}__${transactionDateFormatted}.xlsx`;
      XLSX.writeFile(wb, filename);
    };
  }

  // === EVENT HANDLERS ===

  /**
   * Handles Excel/OpenJet file input changes.
   */
  function handleUnifiedExcelInput() {
    showProcessing('Loading Excel files...');
    processBtn.disabled = true;
    const promises = [];
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
    if (openJetInput.files[0]) {
      promises.push(
        sheetToJsonWithHeader(openJetInput.files[0], 0, 1, true).then(data => {
          openJetClinicianList = [];
          data.forEach(row => {
            const lic = (row['Clinician'] || '').toString().trim();
            if (lic) openJetClinicianList.push(lic);
          });
          openJetCount = openJetClinicianList.length;
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
   * Sets up file input listeners and UI.
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

    // Accessibility: add ARIA roles
    resultsDiv.setAttribute('role', 'region');
    validationDiv.setAttribute('role', 'status');

    // Input listeners
    if (xmlInput) xmlInput.addEventListener('change', handleXmlInput);
    if (excelInput) excelInput.addEventListener('change', handleUnifiedExcelInput);
    if (openJetInput) openJetInput.addEventListener('change', handleUnifiedExcelInput);

    // Process button
    processBtn.addEventListener('click', () => {
      if (xmlDoc && clinicianMap && openJetClinicianList.length > 0) {
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
