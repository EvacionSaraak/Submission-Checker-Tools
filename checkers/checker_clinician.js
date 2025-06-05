(function () {
  'use strict';

  // ======= 1. DOM/Initialization =======

  let xmlDoc = null, clinicianMap = {}, clinicianStatusMap = {};
  let xmlInput, clinicianInput, statusInput, processBtn, csvBtn, resultsDiv, uploadDiv;
  let claimCount = 0, clinicianCount = 0, historyCount = 0;
  let lastResults = [];

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
          effective: row['Effective Date'] || '',
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

  // ======= 3. Data Utilities =======

  function getText(parent, tag) {
    const el = parent.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : '';
  }

  // Returns the most recent license status record for a clinician at a facility before/on a given date.
  function getMostRecentStatusRecord(entries, providerId, encounterStart) {
    const encounterD = new Date(encounterStart);
    // Only consider records for this facility and effective date <= encounter date
    const eligible = entries.filter(e =>
      e.facility === providerId &&
      !!e.effective && !isNaN(new Date(e.effective)) &&
      new Date(e.effective) <= encounterD
    );
    if (eligible.length === 0) return null;
    // Find the most recent (latest effective date)
    eligible.sort((a, b) => new Date(b.effective) - new Date(a.effective));
    return eligible[0];
  }

  // ======= 4. Validation Logic =======

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
        let valid = true;

        // Category check
        if (oid && pid && oid !== pid) {
          const oCat = clinicianMap[oid]?.category;
          const pCat = clinicianMap[pid]?.category;
          if (oCat && pCat && oCat !== pCat) {
            remarks.push('Category mismatch');
            valid = false;
          }
        }

        // License status check for ordering and performing clinicians
        const statusRemark = (id, label) => {
          const entries = clinicianStatusMap[id] || [];
          const rec = getMostRecentStatusRecord(entries, providerId, encounterStart);
          if (!rec) return `${label}: No matching license record before encounter date`;
          if ((rec.status || '').toLowerCase() !== 'active')
            return `${label}: Inactive as of ${rec.effective}`;
          return null;
        };
        if (oid) {
          const ordStatus = statusRemark(oid, 'Ordering');
          if (ordStatus) {
            remarks.push(ordStatus);
            valid = false;
          }
        }
        if (pid) {
          const perfStatus = statusRemark(pid, 'Performing');
          if (perfStatus) {
            remarks.push(perfStatus);
            valid = false;
          }
        }

        results.push({
          claimId, activityId,
          ordering: oid,
          performing: pid,
          remarks,
          valid
        });
      }
    }
    lastResults = results;
    renderResults(results);
    if (csvBtn) csvBtn.disabled = !(results.length > 0);
  }

  // ======= 5. Results Rendering =======

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
      '<table><tr><th>Claim</th><th>Activity</th><th>Ordering</th><th>Performing</th><th>Remarks</th><th>Valid</th></tr>' +
      results.map(r => {
        if (displayedClaims.has(r.claimId)) return '';
        displayedClaims.add(r.claimId);

        // Add name in parentheses if present
        const orderingName = (clinicianMap[r.ordering]?.name || '').trim();
        const performingName = (clinicianMap[r.performing]?.name || '').trim();
        const orderingDisplay = r.ordering ? (orderingName ? `${r.ordering} (${orderingName})` : r.ordering) : '';
        const performingDisplay = r.performing ? (performingName ? `${r.performing} (${performingName})` : r.performing) : '';

        return `<tr class="${r.valid ? 'valid' : 'invalid'}">
          <td>${r.claimId}</td>
          <td>${r.activityId}</td>
          <td>${orderingDisplay}</td>
          <td>${performingDisplay}</td>
          <td>${r.remarks.join('; ')}</td>
          <td>${r.valid ? '✔' : '✘'}</td>
        </tr>`;
      }).join('') + '</table>';
    updateUploadStatus();
  }

  function exportResults() {
    if (!window.XLSX || !lastResults.length) return;
    // Same duplicate-claim logic for export
    const displayedClaims = new Set();
    const headers = [
      'Claim ID', 'Activity ID', 'Ordering ID (Name)', 'Performing ID (Name)', 'Remarks', 'Valid'
    ];
    const rows = lastResults.map(r => {
      if (displayedClaims.has(r.claimId)) return null;
      displayedClaims.add(r.claimId);
      const orderingName = (clinicianMap[r.ordering]?.name || '').trim();
      const performingName = (clinicianMap[r.performing]?.name || '').trim();
      const orderingDisplay = r.ordering ? (orderingName ? `${r.ordering} (${orderingName})` : r.ordering) : '';
      const performingDisplay = r.performing ? (performingName ? `${r.performing} (${performingName})` : r.performing) : '';
      return [
        r.claimId, r.activityId, orderingDisplay, performingDisplay, r.remarks.join('; '), r.valid ? 'Valid' : 'Invalid'
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
