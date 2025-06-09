(function () {
  'use strict';

  let xmlDoc = null, clinicianMap = {}, clinicianStatusMap = {};
  let xmlInput, clinicianInput, statusInput, processBtn, csvBtn, resultsDiv, uploadDiv;
  let claimCount = 0, clinicianCount = 0, historyCount = 0;
  let lastResults = [];
  let affiliatedLicenses = new Set();
  let facilitiesLoaded = false;

  // Load affiliated facilities
  console.log('[INFO] Loading facilities.json...');
  fetch('/Submission-Checker-Tools/checkers/facilities.json')
    .then(response => {
      if (!response.ok) {
        throw new Error(`[FACILITIES FETCH ERROR] HTTP status ${response.status} - ${response.statusText}`);
      }
      return response.json();
    })
    .then(data => {
      if (!data || !Array.isArray(data.facilities)) {
        console.error('[FACILITIES ERROR] Malformed facilities.json, expected { facilities: [...] }');
        affiliatedLicenses = new Set();
        facilitiesLoaded = false;
        updateUploadStatus();
        return;
      }
      affiliatedLicenses = new Set(
        data.facilities
          .map(f => (f.license || '').toString().trim().toUpperCase())
          .filter(x => !!x)
      );
      facilitiesLoaded = true;
      console.log(`[INFO] Facilities loaded: ${affiliatedLicenses.size}`);
      updateUploadStatus();
    })
    .catch(err => {
      affiliatedLicenses = new Set();
      facilitiesLoaded = false;
      console.error('[FACILITIES ERROR] Failed to load facilities.json:', err);
      updateUploadStatus();
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
      try {
        xmlDoc = new DOMParser().parseFromString(text, 'application/xml');
        claimCount = xmlDoc.getElementsByTagName('Claim').length;
        updateUploadStatus();
      } catch (err) {
        logCriticalError('Parsing XML failed', err);
      }
    }).catch(err => {
      logCriticalError('Reading XML file failed', err);
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
      try {
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
      } catch (err) {
        logCriticalError('Processing Clinician Excel failed', err);
      }
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
      try {
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
      } catch (err) {
        logCriticalError('Processing Status Excel failed', err);
      }
    }, 'Clinician Licensing Status');
  }

  function logCriticalError(message, detail) {
    let errorMsg = `[CRITICAL ERROR] ${message}`;
    if (detail !== undefined) {
      try {
        errorMsg += '\nDetail: ' + (typeof detail === 'object' ? JSON.stringify(detail, null, 2) : detail.toString());
      } catch (e) {
        errorMsg += '\n[Unable to stringify error detail]';
      }
    }
    console.error(errorMsg);
    if (resultsDiv) {
      resultsDiv.innerHTML = `<span style="color:red">${errorMsg.replace(/\n/g, '<br>')}</span>`;
    }
  }

  function readExcel(file, callback, sheetName) {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        let sheet;
        if (sheetName && workbook.SheetNames.includes(sheetName)) {
          sheet = workbook.Sheets[sheetName];
        } else {
          sheet = workbook.Sheets[workbook.SheetNames[0]];
        }
        const rows = XLSX.utils.sheet_to_json(sheet);
        callback(rows);
      } catch (err) {
        logCriticalError('Reading Excel file failed', err);
      }
    };
    reader.onerror = function(err) {
      logCriticalError('FileReader error while reading Excel', err);
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

  // Main validation logic
  function validateClinicians() {
    if (!xmlDoc) {
      logCriticalError('No XML loaded', '');
      return;
    }
    if (!facilitiesLoaded || affiliatedLicenses.size === 0) {
      logCriticalError('Facility list not loaded. Please check facilities.json and reload.', '');
      return;
    }
    const claims = xmlDoc.getElementsByTagName('Claim');
    const results = [];

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
          if (oCat && pCat && oCat !== pCat) {
            remarks.push('Category mismatch');
          }
        }

        // New logic: Valid if clinician has ACTIVE license at any affiliated facility before/on encounter date
        let performingEff = '', performingStatus = '', performingStatusDisplay = '';
        let valid = false;

        const entries = clinicianStatusMap[pid] || [];
        const encounterD = new Date(excelDateToISO(encounterStart));
        // Find all ACTIVE licenses at any affiliated facility before/on encounter date
        const eligible = entries.filter(e => {
          const fac = (e.facility || '').toString().trim().toUpperCase();
          const effDate = new Date(excelDateToISO(e.effective));
          return affiliatedLicenses.has(fac) &&
                 !!e.effective &&
                 !isNaN(effDate) &&
                 effDate <= encounterD &&
                 (e.status || '').toLowerCase() === 'active';
        });
        let mostRecent = null;
        if (eligible.length > 0) {
          eligible.sort((a, b) => new Date(excelDateToISO(b.effective)) - new Date(excelDateToISO(a.effective)));
          mostRecent = eligible[0];
          valid = true;
        }

        // Full license history for this clinician
        const fullHistory = entries.map(e =>
          `${(e.facility || '[No Facility]').toString().trim().toUpperCase()}: ${e.effective || '[No Date]'} (${e.status || '[No Status]'})`
        ).join('; ');

        if (mostRecent) {
          performingEff = mostRecent.effective || '';
          performingStatus = mostRecent.status || '';
          performingStatusDisplay = (performingEff ? `${performingEff}${performingStatus ? ' (' + performingStatus + ')' : ''}` : '');
        } else {
          // Only add this remark if there was no eligible license at all (not if valid)
          remarks.push('No ACTIVE affiliated facility license for encounter date');
        }

        if (!oid) remarks.push('OrderingClinician missing');
        if (!pid) remarks.push('Clinician missing');

        // Only push the result as invalid if valid is false
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
          <td class="description-col">${r.valid ? '' : r.remarks.join('; ')}</td>
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
      r.valid ? '' : r.remarks.join('; ')
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
    if (facilitiesLoaded && affiliatedLicenses.size) {
      messages.push(`${affiliatedLicenses.size} Facilities Loaded`);
    } else {
      messages.push('Facilities not loaded');
    }
    uploadDiv.textContent = messages.join(', ');
    processBtn.disabled = !(claimCount && clinicianCount && historyCount && facilitiesLoaded && affiliatedLicenses.size);
  }

})();
