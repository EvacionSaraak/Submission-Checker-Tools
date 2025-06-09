(function () {
  'use strict';

  // ======= 1. DOM/Initialization =======

  let xmlDoc = null, clinicianMap = {}, clinicianStatusMap = {};
  let xmlInput, clinicianInput, statusInput, processBtn, csvBtn, resultsDiv, uploadDiv;
  let claimCount = 0, clinicianCount = 0, historyCount = 0;
  let lastResults = [];
  
  // Load facilities.json and create a Set of valid license numbers
  let affiliatedLicenses = new Set();
  fetch('checkers/facilities.json')
    .then(response => response.json())
    .then(data => {
      affiliatedLicenses = new Set(data.facilities.map(f => f.license));
    });

  document.addEventListener('DOMContentLoaded', () => {
    xmlInput = document.getElementById('xmlFileInput');
    clinicianInput = document.getElementById('clinicianFileInput');
    statusInput = document.getElementById('statusFileInput');
    processBtn = document.getElementById('processBtn');
    csvBtn = document.getElementById('csvBtn');
    resultsDiv = document.getElementById('results');
    uploadDiv = document.getElementById('uploadStatus');

    xmlInput.addEventListener('change', handleXmlInput);
    clinicianInput.addEventListener('change', handleClinicianInput);
    statusInput.addEventListener('change', handleStatusInput);

    processBtn.addEventListener('click', validateClinicians);
    if (csvBtn) csvBtn.addEventListener('click', exportResults);

    processBtn.disabled = true;
    if (csvBtn) csvBtn.disabled = true;
    updateUploadStatus();
  });

  // ======= 2. File Handling & Parsing =======

  function handleXmlInput(e) {
    const file = e.target.files[0];
    if (!file) {
      xmlDoc = null;
      claimCount = 0;
      updateUploadStatus();
      return;
    }
    file.text().then(text => {
      xmlDoc = new DOMParser().parseFromString(text, 'application/xml');
      claimCount = xmlDoc.getElementsByTagName('Claim').length;
      updateUploadStatus();
    });
  }

  function handleClinicianInput(e) {
    const file = e.target.files[0];
    if (!file) {
      clinicianMap = {};
      clinicianCount = 0;
      updateUploadStatus();
      return;
    }
    resultsDiv.innerHTML = 'Loading Excel...';
    readExcel(file, data => {
      clinicianMap = {};
      data.forEach(row => {
        const id = (row['Clinician License'] || '').toString().trim();
        if (!id) return;
        clinicianMap[id] = {
          name: row['Clinician Name'] || row['Name'] || '',
          category: row['Clinician Category'] || row['Category'] || '',
        };
      });
      clinicianCount = Object.keys(clinicianMap).length;
      resultsDiv.innerHTML = '';
      updateUploadStatus();
    }, 'Clinicians');
  }

  function handleStatusInput(e) {
    const file = e.target.files[0];
    if (!file) {
      clinicianStatusMap = {};
      historyCount = 0;
      updateUploadStatus();
      return;
    }
    resultsDiv.innerHTML = 'Loading Excel...';
    readExcel(file, data => {
      clinicianStatusMap = {};
      data.forEach(row => {
        const id = (row['License Number'] || '').toString().trim();
        if (!id) return;
        clinicianStatusMap[id] = clinicianStatusMap[id] || [];
        clinicianStatusMap[id].push({
          facility: row['Facility License Number'] || '',
          effective: excelDateToISO(row['Effective Date']),
          status: row['Status'] || ''
        });
      });
      historyCount = Object.keys(clinicianStatusMap).length;
      resultsDiv.innerHTML = '';
      updateUploadStatus();
    }, 'Clinician Licensing Status');
  }

  function readExcel(file, callback, sheetName) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      let sheet;
      // Use the correct sheet name if present
      if (sheetName && workbook.SheetNames.includes(sheetName)) {
        sheet = workbook.Sheets[sheetName];
      } else {
        sheet = workbook.Sheets[workbook.SheetNames[0]];
        if (sheetName) {
          console.warn(`[Excel] Sheet "${sheetName}" not found. Using first sheet "${workbook.SheetNames[0]}".`);
        }
      }
      const rows = XLSX.utils.sheet_to_json(sheet);
      callback(rows);
    };
    reader.readAsArrayBuffer(file);
  }

  // ======= Date Conversion Utility =======

  function excelDateToISO(excelDate) {
    if (!excelDate) return '';
    if (typeof excelDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(excelDate)) return excelDate.slice(0, 10); // already ISO
    const serial = Number(excelDate);
    if (isNaN(serial)) return excelDate;
    // Excel's "zero" is 1899-12-31, but JS Date UTC counts from 1970
    const utc_days = serial - 25569;
    const utc_value = utc_days * 86400 * 1000;
    const d = new Date(utc_value);
    return d.toISOString().slice(0, 10);
  }

  // ======= 3. Data Utilities =======

  function getText(parent, tag) {
    const el = parent.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : '';
  }

  // Returns the most recent license status record for a clinician at a facility before/on a given date.
  function getMostRecentStatusRecord(entries, providerId, encounterStart) {
    const encounterD = new Date(excelDateToISO(encounterStart));
    const eligible = entries.filter(e =>
      e.facility === providerId &&
      !!e.effective && !isNaN(new Date(excelDateToISO(e.effective))) &&
      new Date(excelDateToISO(e.effective)) <= encounterD
    );
    if (eligible.length === 0) return null;
    eligible.sort((a, b) =>
      new Date(excelDateToISO(b.effective)) - new Date(excelDateToISO(a.effective))
    );
    return eligible[0];
  }

  function isClinicianActiveAtAffiliated(clinicianId) {
    const entries = clinicianStatusMap[clinicianId] || [];
    return entries.some(entry =>
      affiliatedLicenses.has(entry.facility) &&
      (entry.status || '').toLowerCase() === 'active'
    );
  }

  // ======= 4. Validation Logic =======
  // ======= MODIFIED SECTION: Detect All Status Entries =======
  function validateClinicians() {
    if (!xmlDoc) return;
    const claims = xmlDoc.getElementsByTagName('Claim');
    const results = [];
    for (const claim of claims) {
      const providerId = getText(claim, 'ProviderID');
      const encounter = claim.getElementsByTagName('Encounter')[0];
      const encounterStart = getText(encounter, 'Start');

      const activities = claim.getElementsByTagName('Activity');
      for (const act of activities) {
        const claimId = getText(claim, 'ID');
        const activityId = getText(act, 'ID');
        const oid = getText(act, 'OrderingClinician');
        const pid = getText(act, 'Clinician');
        const remarks = [];

        // Check for missing fields
        if (!oid) remarks.push('OrderingClinician missing');
        if (!pid) remarks.push('Clinician missing');

        // Category check
        if (oid && pid && oid !== pid) {
          const oCat = clinicianMap[oid]?.category;
          const pCat = clinicianMap[pid]?.category;
          if (oCat && pCat && oCat !== pCat) remarks.push('Category mismatch');
        }

        // === NEW: Check and report all status entries for the performing clinician ===
        let allStatusRemarks = [];
        let performingStatusEntries = [];
        if (pid && clinicianStatusMap[pid]) {
          clinicianStatusMap[pid].forEach((entry) => {
            let entryRemark = '';
            const isAffiliated = affiliatedLicenses.has(entry.facility);
            const isActive = (entry.status || '').toLowerCase() === 'active';

            performingStatusEntries.push(
              `${entry.facility || '[No Facility]'}: ${entry.effective || '[No Date]'} (${entry.status || '[No Status]'})`
            );

            if (!isAffiliated) entryRemark += `Not affiliated with facility ${entry.facility || '[No Facility]'}`;
            if (!isActive) entryRemark += (entryRemark ? '; ' : '') + `Status is not ACTIVE (${entry.status || '[No Status]'})`;

            if (entryRemark) {
              allStatusRemarks.push(
                `Facility ${entry.facility || '[No Facility]'} on ${entry.effective || '[No Date]'}: ${entryRemark}`
              );
            }
          });
        } else if (pid) {
          allStatusRemarks.push('No status history found for clinician');
        }

        if (allStatusRemarks.length > 0) {
          remarks.push(...allStatusRemarks);
        }

        // Legacy: If you still want to keep the "Not ACTIVE at any affiliated facility" summary
        if (pid && !isClinicianActiveAtAffiliated(pid)) remarks.push('Performing: Not ACTIVE at any affiliated facility');

        if (remarks.length > 0) console.log(`Claim ${claimId}, Activity ${activityId}:`, remarks);

        results.push({
          claimId,
          activityId,
          encounterStart,
          facilityLicenseNumber: providerId,
          ordering: oid,
          orderingName: (clinicianMap[oid]?.name || '').trim(),
          performing: pid,
          performingName: (clinicianMap[pid]?.name || '').trim(),
          performingStatuses: performingStatusEntries.join('; '),
          remarks,
          valid: remarks.length === 0
        });
      }
    }
    lastResults = results;
    renderResults(results);
    if (csvBtn) csvBtn.disabled = !(results.length > 0);
  }

  // ======= 5. Results Rendering (Show All Status Entries) =======

  function renderResults(results) {
    let validCt = results.filter(r => r.valid).length;
    let total = results.length;
    let pct = total ? Math.round(validCt / total * 100) : 0;

    // Track displayed claim IDs to avoid duplicates
    const displayedClaims = new Set();
    resultsDiv.innerHTML =
      `<div class="${pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message'}">
        Validation: ${validCt}/${total} valid (${pct}%)
      </div>` +
      '<table><tr>' +
      '<th>Claim</th><th>Activity</th><th>Encounter Start</th><th>Facility License Number</th>' +
      '<th>Ordering</th>' +
      '<th>Performing</th><th>All Performing License Statuses</th>' +
      '<th>Remarks</th></tr>' +
      results.map(r => {
        if (displayedClaims.has(r.claimId)) return '';
        displayedClaims.add(r.claimId);

        const orderingDisplay =
          r.ordering ? (r.orderingName ? `${r.ordering} (${r.orderingName})` : r.ordering) : '';
        const performingDisplay =
          r.performing ? (r.performingName ? `${r.performing} (${r.performingName})` : r.performing) : '';

        const performingStatusDisplay = r.performingStatuses || '';

        return `<tr class="${r.valid ? 'valid' : 'invalid'}">
          <td>${r.claimId}</td>
          <td>${r.activityId}</td>
          <td>${r.encounterStart}</td>
          <td>${r.facilityLicenseNumber}</td>
          <td>${orderingDisplay}</td>
          <td>${performingDisplay}</td>
          <td class="description-col">${performingStatusDisplay}</td>
          <td class="description-col">${r.remarks.join('; ')}</td>
        </tr>`;
      }).join('') + '</table>';
    updateUploadStatus();
  }

  function exportResults() {
    if (!window.XLSX || !lastResults.length) return;
    // Same duplicate-claim logic for export
    const displayedClaims = new Set();
    const headers = [
      'Claim ID', 'Activity ID', 'Encounter Start',
      'Facility License Number',
      'Ordering ID (Name)',
      'Performing ID (Name)', 'All Performing License Statuses',
      'Remarks'
    ];
    const rows = lastResults.map(r => {
      if (displayedClaims.has(r.claimId)) return null;
      displayedClaims.add(r.claimId);
      const orderingDisplay =
        r.ordering ? (r.orderingName ? `${r.ordering} (${r.orderingName})` : r.ordering) : '';
      const performingDisplay =
        r.performing ? (r.performingName ? `${r.performing} (${r.performingName})` : r.performing) : '';
      const performingStatusDisplay = r.performingStatuses || '';
      return [
        r.claimId, r.activityId, r.encounterStart,
        r.facilityLicenseNumber || '',
        orderingDisplay,
        performingDisplay, performingStatusDisplay,
        r.remarks.join('; ')
      ];
    }).filter(Boolean);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Results');
    XLSX.writeFile(wb, `ClinicianValidation.xlsx`);
  }

  // ======= 6. Status/State Display =======

  function updateUploadStatus() {
    const messages = [];
    if (claimCount) messages.push(`${claimCount} Claims Loaded`);
    if (clinicianCount) messages.push(`${clinicianCount} Clinicians Loaded`);
    if (historyCount) messages.push(`${historyCount} License Histories Loaded`);
    uploadDiv.textContent = messages.join(', ');
    processBtn.disabled = !(claimCount && clinicianCount && historyCount);
    // Console log for totals
    console.log(
      `[Loaded] Claims: ${claimCount}, Clinicians: ${clinicianCount}, License Histories: ${historyCount}`
    );
  }

})();
