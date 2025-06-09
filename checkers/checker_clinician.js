(function () {
  'use strict';

  let xmlDoc = null, clinicianMap = {}, clinicianStatusMap = {};
  let xmlInput, clinicianInput, statusInput, processBtn, csvBtn, resultsDiv, uploadDiv;
  let claimCount = 0, clinicianCount = 0, historyCount = 0;
  let lastResults = [];
  let affiliatedLicenses = new Set();

  fetch('checkers/facilities.json')
    .then(response => response.json())
    .then(data => {
      affiliatedLicenses = new Set(
        data.facilities.map(f => (f.license || '').toString().trim().toUpperCase())
      );
      console.log('[DEBUG] Affiliated Licenses Loaded:', Array.from(affiliatedLicenses));
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
      console.log('[DEBUG] Clinician Map Loaded:', clinicianMap);
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
      console.log('[DEBUG] Clinician Status Map Loaded:', clinicianStatusMap);
    }, 'Clinician Licensing Status');
  }

  function readExcel(file, callback, sheetName) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      let sheet;
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

  function excelDateToISO(excelDate) {
    if (!excelDate) return '';
    if (typeof excelDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(excelDate)) return excelDate.slice(0, 10);
    const serial = Number(excelDate);
    if (isNaN(serial)) return excelDate;
    const utc_days = serial - 25569;
    const utc_value = utc_days * 86400 * 1000;
    const d = new Date(utc_value);
    return d.toISOString().slice(0, 10);
  }

  function getText(parent, tag) {
    const el = parent.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : '';
  }

  function getMostRecentStatusRecord(entries, providerId, encounterStart) {
    const encounterD = new Date(excelDateToISO(encounterStart));
    // Normalize facility IDs for robust comparison
    const normalizedProviderId = (providerId || '').toString().trim().toUpperCase();
    const eligible = entries.filter(e =>
      (e.facility || '').toString().trim().toUpperCase() === normalizedProviderId &&
      !!e.effective && !isNaN(new Date(excelDateToISO(e.effective))) &&
      new Date(excelDateToISO(e.effective)) <= encounterD
    );
    if (eligible.length === 0) return null;
    eligible.sort((a, b) =>
      new Date(excelDateToISO(b.effective)) - new Date(excelDateToISO(a.effective))
    );
    return eligible[0];
  }

  // Main validation logic
  function validateClinicians() {
    if (!xmlDoc) return;
    const claims = xmlDoc.getElementsByTagName('Claim');
    const results = [];
    // Prepare normalized affiliated license set for robust comparison
    const normalizedAffiliatedLicenses = affiliatedLicenses; // already normalized at fetch

    for (const claim of claims) {
      const providerId = getText(claim, 'ProviderID');
      const normalizedProviderId = (providerId || '').toString().trim().toUpperCase();
      const encounter = claim.getElementsByTagName('Encounter')[0];
      const encounterStart = getText(encounter, 'Start');

      const activities = claim.getElementsByTagName('Activity');
      for (const act of activities) {
        const claimId = getText(claim, 'ID');
        const activityId = getText(act, 'ID');
        const oid = getText(act, 'OrderingClinician');
        const pid = getText(act, 'Clinician');
        const remarks = [];

        // Ordering and performing display
        const orderingDisplay = oid ? (
          clinicianMap[oid]?.name ? `${oid} (${clinicianMap[oid].name})` : oid
        ) : '';
        const performingDisplay = pid ? (
          clinicianMap[pid]?.name ? `${pid} (${clinicianMap[pid].name})` : pid
        ) : '';

        // Category check
        if (oid && pid && oid !== pid) {
          const oCat = clinicianMap[oid]?.category;
          const pCat = clinicianMap[pid]?.category;
          console.log(`[Validator] Comparing categories for claim ${claimId}, activity ${activityId}: Ordering (${oCat}), Performing (${pCat})`);
          if (oCat && pCat && oCat !== pCat) {
            remarks.push('Category mismatch');
            console.log(`[Validator] Category mismatch detected for claim ${claimId}, activity ${activityId}`);
          }
        }

        // Most recent status for performing clinician at this facility and encounter date
        let performingEff = '', performingStatus = '', performingStatusDisplay = '', mostRecentRemark = '';
        let valid = true;

        const entries = clinicianStatusMap[pid] || [];
        const mostRecent = getMostRecentStatusRecord(entries, providerId, encounterStart);

        // Full license history for this clinician
        console.log(`All license history entries for clinician ${pid}:`, entries);
        const fullHistory = entries.map(e =>
          `${e.facility || '[No Facility]'}: ${e.effective || '[No Date]'} (${e.status || '[No Status]'})`
        ).join('; ');

        if (mostRecent) {
          performingEff = mostRecent.effective || '';
          performingStatus = mostRecent.status || '';
          performingStatusDisplay = (performingEff ? `${performingEff}${performingStatus ? ' (' + performingStatus + ')' : ''}` : '');

          // Normalize facility for robust comparison
          const fac = (mostRecent.facility || '').toString().trim().toUpperCase();
          const isAffiliated = normalizedAffiliatedLicenses.has(fac);

          console.log(`[Validator] Checking performing clinician for claim ${claimId}, activity ${activityId}:`);
          console.log('  Facility being checked:', JSON.stringify(fac));
          console.log('  All affiliated:', Array.from(normalizedAffiliatedLicenses));
          console.log('  Is Affiliated:', isAffiliated);
          console.log('  Status:', (mostRecent.status || '').toLowerCase());
          if (!isAffiliated) {
            // Show matches if not found
            const similar = Array.from(normalizedAffiliatedLicenses).filter(x => x.includes(fac) || fac.includes(x));
            console.log('  Similar entries in set:', similar);
          }

          if ((mostRecent.status || '').toLowerCase() !== 'active') {
            mostRecentRemark = `Performing: Status is not ACTIVE (${mostRecent.status})`;
            valid = false;
            console.log(`[Validator] Not ACTIVE for claim ${claimId}, activity ${activityId}`);
          }
          if (!isAffiliated) {
            mostRecentRemark += (mostRecentRemark ? '; ' : '') + `Not affiliated facility (${mostRecent.facility})`;
            valid = false;
            console.log(`[Validator] Not affiliated for claim ${claimId}, activity ${activityId}`);
          }
        } else {
          mostRecentRemark = 'No license record at this facility for encounter date';
          valid = false;
          console.log(`[Validator] No license record found for claim ${claimId}, activity ${activityId}`);
        }

        if (!oid) {
          remarks.push('OrderingClinician missing');
          console.log(`[Validator] OrderingClinician missing for claim ${claimId}, activity ${activityId}`);
        }
        if (!pid) {
          remarks.push('Clinician missing');
          console.log(`[Validator] Clinician missing for claim ${claimId}, activity ${activityId}`);
        }
        if (mostRecentRemark) remarks.push(mostRecentRemark);

        results.push({
          claimId,
          activityId,
          encounterStart,
          facilityLicenseNumber: providerId,
          orderingDisplay,
          performingDisplay,
          performingEff,
          performingStatus,
          recentStatus: performingStatusDisplay,
          fullHistory,
          remarks,
          valid
        });
      }
      // Log claim separator for clarity
      console.log('---------------------------');
    }
    lastResults = results;
    renderResults(results);
    if (csvBtn) csvBtn.disabled = !(results.length > 0);
  }

  // Render results (with full history column and recent performing status)
  function renderResults(results) {
    let validCt = results.filter(r => r.valid).length;
    let total = results.length;
    let pct = total ? Math.round(validCt / total * 100) : 0;

    resultsDiv.innerHTML =
      `<div class="${pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message'}">
        Validation: ${validCt}/${total} valid (${pct}%)
      </div>` +
      '<table><tr>' +
      '<th>Claim</th><th>Activity</th><th>Encounter Start</th><th>Facility License Number</th>' +
      '<th>Ordering</th>' +
      '<th>Performing</th><th>Recent Performing License Status</th><th>Full License History</th>' +
      '<th>Remarks</th></tr>' +
      results.map(r => {
        return `<tr class="${r.valid ? 'valid' : 'invalid'}">
          <td>${r.claimId}</td>
          <td>${r.activityId}</td>
          <td>${r.encounterStart}</td>
          <td>${r.facilityLicenseNumber}</td>
          <td>${r.orderingDisplay}</td>
          <td>${r.performingDisplay}</td>
          <td>${r.recentStatus}</td>
          <td class="description-col">${r.fullHistory}</td>
          <td class="description-col">${r.remarks.join('; ')}</td>
        </tr>`;
      }).join('') + '</table>';
    updateUploadStatus();
  }

  // Export with your specified headers
  function exportResults() {
    if (!window.XLSX || !lastResults.length) return;
    const headers = [
      'Claim ID', 'Activity ID', 'Encounter Start',
      'Facility License Number',
      'Ordering',
      'Performing', 'Recent Performing License Status',
      'Full License History',
      'Remarks'
    ];
    const rows = lastResults.map(r => [
      r.claimId,
      r.activityId,
      r.encounterStart,
      r.facilityLicenseNumber || '',
      r.orderingDisplay || '',
      r.performingDisplay || '',
      r.recentStatus || '',
      r.fullHistory || '',
      r.remarks.join('; ')
    ]);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Results');
    XLSX.writeFile(wb, `ClinicianValidation.xlsx`);
  }

  function updateUploadStatus() {
    const messages = [];
    if (claimCount) messages.push(`${claimCount} Claims Loaded`);
    if (clinicianCount) messages.push(`${clinicianCount} Clinicians Loaded`);
    if (historyCount) messages.push(`${historyCount} License Histories Loaded`);
    uploadDiv.textContent = messages.join(', ');
    processBtn.disabled = !(claimCount && clinicianCount && historyCount);
    console.log(
      `[Loaded] Claims: ${claimCount}, Clinicians: ${clinicianCount}, License Histories: ${historyCount}`
    );
  }

})();
