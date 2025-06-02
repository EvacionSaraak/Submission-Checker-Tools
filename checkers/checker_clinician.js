/**
 * Clinician Checker Tool (refactored)
 * Validates XML submissions for clinician assignments.
 * Handles Excel and OpenJet files for metadata, including eligibility window checks.
 * Applies robust error handling, modular utilities, and improved UI feedback.
 * (c) 2025
 * 
 * MODIFICATIONS:
 * 1. Enhanced OpenJet XLSX loading with flexible column name matching
 * 2. Improved date parsing for both string and Excel serial formats
 * 3. Added better error handling and debugging outputs
 * 4. Added column name flexibility for clinician ID, dates, and eligibility
 */

(function () {
  'use strict';

  // === GLOBAL STATE ===
  let openJetData = [];           // Array of objects from Open Jet XLSX, each: { clinicianId, effectiveDate, expiryDate, eligibility }
  let xmlDoc = null;
  let clinicianMap = null;        // From Shafafiya Excel: map[clinicianID] → { name, category, privileges }
  let xmlInput, excelInput, openJetInput, resultsDiv, validationDiv, processBtn, exportCsvBtn;
  let clinicianCount = 0, openJetCount = 0, claimCount = 0;

  // === UTILITY FUNCTIONS ===
  /**
   * Modified sheetToJsonWithHeader to handle the specific OpenJet format
   */
  function sheetToJsonWithHeader(file, sheetIndex = 0, headerRow = 1) {
      return file.arrayBuffer().then(buffer => {
          const data = new Uint8Array(buffer);
          const wb = XLSX.read(data, { type: 'array' });
          const name = wb.SheetNames[sheetIndex];
          if (!name) throw new Error(`Sheet index ${sheetIndex} not found`);
          
          const sheet = wb.Sheets[name];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          
          // Handle the extra header row in OpenJet files
          const headerRowIndex = headerRow - 1;
          if (!rows || rows.length <= headerRowIndex) {
              throw new Error(`Header row not found at position ${headerRowIndex + 1}`);
          }
          
          const rawHeaders = rows[headerRowIndex];
          console.log(rawHeaders);
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
   * Parses a date string or Excel serial number into a JavaScript Date object.
   * MODIFIED: Now handles Excel serial dates and multiple string formats
   */
  function parseDate(dateStr) {
    if (!dateStr) return new Date('Invalid');
    
    // Handle Excel serial dates (numbers)
    if (!isNaN(dateStr)) {
      const excelSerial = parseFloat(dateStr);
      if (!isNaN(excelSerial)) {
        // Convert Excel serial date (days since 1900-01-01) to JS Date
        return new Date((excelSerial - (25567 + 2)) * 86400 * 1000);
      }
    }
    
    // Try ISO format (YYYY-MM-DD)
    let d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;
    
    // Try other common formats
    d = new Date(dateStr.replace(/(\d+)\/(\d+)\/(\d+)/, '$2/$1/$3')); // DD/MM/YYYY
    if (!isNaN(d.getTime())) return d;
    
    d = new Date(dateStr.replace(/(\d+)-(\d+)-(\d+)/, '$1/$2/$3')); // YYYY-MM-DD
    if (!isNaN(d.getTime())) return d;
    
    return new Date('Invalid');
  }

  /**
   * Checks if the encounter window (start/end) falls within the clinician's eligibility window.
   * xlsxRow already has Date objects for effectiveDate and expiryDate.
   * Returns an object: { eligible: boolean, remarks: [...], eligibilityValue: string }
   */
  function checkEligibility(encounterStartStr, encounterEndStr, xlsxRow) {
    const encounterStart = parseDate(encounterStartStr);
    const encounterEnd = parseDate(encounterEndStr);
    const effectiveDate = xlsxRow.effectiveDate;
    const expiryDate = xlsxRow.expiryDate;

    const remarks = [];
    let eligible = true;

    if (isNaN(encounterStart) || isNaN(encounterEnd)) {
      remarks.push("Invalid Encounter dates in XML");
      eligible = false;
    } else if (!effectiveDate || !expiryDate || isNaN(effectiveDate) || isNaN(expiryDate)) {
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
      eligibilityValue: xlsxRow.eligibility || ''
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
  // ================================================================
  // 1) MODIFIED: updateResultsDiv
  // - No longer writes into resultsDiv
  // - Now writes into uploadStatusDiv (separate <div id="uploadStatus">)
  // ================================================================
  function updateResultsDiv() {
    const messages = [];
    if (claimCount > 0)      messages.push(`${claimCount} Claims Loaded`);
    if (clinicianCount > 0)  messages.push(`${clinicianCount} Clinicians Loaded`);
    if (openJetCount > 0)    messages.push(`${openJetCount} Auths Loaded`);
  
    // Write into the "uploadStatus" container, not resultsDiv
    document.getElementById('uploadStatus').textContent = messages.join(', ');
  
    toggleProcessButton();
  }

  // ================================================================
  // 2) MODIFIED: renderResults
  // - renderSummary() target is still validationDiv
  // - table is injected into resultsDiv
  // - Does NOT clear validationDiv
  // ================================================================
  function renderResults(results) {
    // 1) If no results, show “No results” BELOW existing summary
    if (!results.length) {
      renderSummary(results);
      resultsDiv.innerHTML = '<p>No results found.</p>';
      return;
    }
  
    // 2) Always re‐render summary in validationDiv
    renderSummary(results);
  
    // 3) Clear only the resultsDiv (so old tables vanish)
    resultsDiv.innerHTML = '';
  
    // 4) Build and append new table under resultsDiv
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
      appendCell(tr, `${r.orderingId} - ${r.orderingName}`);
      appendCell(tr, r.orderingCategory);
      appendCell(tr, r.orderingEligibility);
      appendCell(tr, `${r.performingId} - ${r.performingName}`);
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

          // --- 1. Match by Clinician ID (ignore second policy block) ---
          const ordXlsxRow = openJetData.find(r => r.clinicianId === oid);
          const perfXlsxRow = openJetData.find(r => r.clinicianId === pid);

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

          // --- 3. Eligibility date checks using first EffectiveDate/ExpiryDate only ---
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
            orderingEligibility: ordXlsxRow ? ordXlsxRow.eligibility : 'N/A',
            performingId: pid,
            performingName: pd.name,
            performingCategory: pd.category,
            performingEligibility: perfXlsxRow ? perfXlsxRow.eligibility : 'N/A',
            valid: rowValid,
            remarks: rowRemarks
          });
        });
      });

      renderResults(results);
      setupExportHandler(results);
      updateResultsDiv();
    }, 300); // simulate loading
  }

  // ================================================================
// NEW FUNCTION: setupExportHandler
// - Renamed from setupExportr and updated to build an XLSX via SheetJS
// - Extracts SenderID and TransactionDate from xmlDoc for filename
// - Freezes header row and auto-adjusts column widths
// ================================================================
function setupExportHandler(results) {
  exportCsvBtn.disabled = false;

  exportCsvBtn.onclick = function () {
    if (!xmlDoc) {
      alert('No XML document loaded for export.');
      return;
    }

    // 1) Extract SenderID from <Header><SenderID>
    const senderID = (xmlDoc.querySelector('Header > SenderID')?.textContent || 'UnknownSender').trim();

    // 2) Extract TransactionDate (assumed format dd/MM/yyyy HH:mm)
    const transactionDateRaw = (xmlDoc.querySelector('Header > TransactionDate')?.textContent || '').trim();
    let transactionDateFormatted = 'UnknownDate';
    if (transactionDateRaw) {
      const dateParts = transactionDateRaw.split(' ')[0].split('/');
      if (dateParts.length === 3) {
        transactionDateFormatted = `${dateParts[2]}-${dateParts[1].padStart(2, '0')}-${dateParts[0].padStart(2, '0')}`;
      }
    }

    // 3) Build header row and data rows for SheetJS
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

    // 4) Create new workbook/sheet, freeze header row, auto‐adjust column widths
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

    // 5) Filename: ClinicianCheck_<SenderID>_<YYYY-MM-DD>.xlsx
    const filename = `ClinicianCheck_${senderID}_${transactionDateFormatted}.xlsx`;
    XLSX.writeFile(wb, filename);
  };
}


  /**
   * Prepares and triggers the Excel export of results.
   */
  function setupExportr(results) {
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

  // === EVENT RS ===

  /**
   * s Shafafiya Excel and Open Jet Excel inputs.
   * MODIFIED: Added flexible column name matching and better date parsing
   */
  /**
   * Modified OpenJet XLSX processing for the specific format
   */
  function handleUnifiedExcelInput() {
      showProcessing('Loading Excel files...');
      processBtn.disabled = true;
      exportCsvBtn.disabled = true;
  
      const promises = [];
  
      // Load Shafafiya Excel → clinicianMap (unchanged)
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
                              privileges: row['Activity Group'] || row['Privileges'] || ''
                          };
                      }
                  });
                  clinicianCount = Object.keys(clinicianMap).length;
              })
          );
      }
  
      // Load Open Jet Excel → openJetData (modified for specific format)
      if (openJetInput.files[0]) {
          promises.push(
              sheetToJsonWithHeader(openJetInput.files[0], 0, 2).then(data => {
                  openJetData = data.map(row => {
                      // Parse dates from the specific format "dd-MMM-yyyy HH:mm:ss"
                      const parseOpenJetDate = (dateStr) => {
                          if (!dateStr) return new Date('Invalid');
                          const parts = dateStr.split(' ');
                          const datePart = parts[0]; // "31-May-2025"
                          const [day, month, year] = datePart.split('-');
                          const monthMap = {
                              'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
                              'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
                              'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
                          };
                          return new Date(`${year}-${monthMap[month]}-${day.padStart(2, '0')}`);
                      };
  
                      // Get first policy block data (ignore second policy block)
                      return {
                          clinicianId: (row['Clinician'] || '').toString().trim(),
                          effectiveDate: parseOpenJetDate(row['EffectiveDate']),
                          expiryDate: parseOpenJetDate(row['ExpiryDate']),
                          eligibility: (row['Status'] || '').toString().trim()
                      };
                  }).filter(entry => entry.clinicianId);
                  
                  openJetCount = openJetData.length;
                  console.log('OpenJet data sample:', openJetData.slice(0, 3));
              }).catch(e => {
                  console.error('OpenJet processing error:', e);
                  throw new Error(`Failed to process OpenJet file: ${e.message}`);
              })
          );
      }
  
      Promise.all(promises)
          .then(() => {
              updateResultsDiv();
          })
          .catch(e => {
              resultsDiv.innerHTML = `<p class="error-message">${e.message}</p>`;
              console.error('Excel loading error:', e);
              toggleProcessButton();
          });
  }
  /**
   * Handles XML file input changes.
   */
  function handleXmlInput() {
    showProcessing('Loading XML...');
    processBtn.disabled = true;
    exportCsvBtn.disabled = true;

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
      console.error('XML loading error:', e);
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
    console.error('Global error:', { msg, url, line, col, error });
  };

})();
