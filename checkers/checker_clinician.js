(function () {
  'use strict';

  // --- Helper: Parse DD/MM/YYYY or DD/MM/YYYY HH:MM ---
  function parseDMY(dateStr) {
    if (typeof dateStr !== 'string') return new Date(dateStr);
    const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (!match) return new Date(dateStr); // fallback
    const [ , dd, mm, yyyy, HH, MM ] = match;
    if (HH && MM) {
      return new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:00`);
    }
    return new Date(`${yyyy}-${mm}-${dd}`);
  }

  // Inject scrollable modal CSS
  (function () {
    const style = document.createElement('style');
    style.innerHTML = `
      .modal-content {
        max-height: 70vh;
        overflow-y: auto;
      }
    `;
    document.head.appendChild(style);
  })();

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
        // Preprocess XML to replace unescaped & with "and" for parseability
        const xmlContent = text.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g, "and");
        xmlDoc = new DOMParser().parseFromString(xmlContent, 'application/xml');
        claimCount = xmlDoc.getElementsByTagName('Claim').length;
        console.log('[XML] Claims loaded:', claimCount);
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
        console.log('[Clinician Excel] Loaded:', clinicianCount, 'clinicians');
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
            effective: row['Effective Date'] || '',
            status: row['Status'] || ''
          });
        });
        historyCount = Object.keys(clinicianStatusMap).length;
        console.log('[Status Excel] Loaded:', historyCount, 'license histories');
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
        console.log('[Excel] Rows loaded from', sheetName, ':', rows.length);
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

  function getText(parent, tag) {
    const el = parent.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : '';
  }

  // Format the license history for modal display as a table
  function formatLicenseHistory(fullHistory) {
    const rows = fullHistory.split(';').map(e => e.trim()).filter(Boolean);
    if (rows.length === 0) return "<em>No history</em>";
    let table = `<table class="modal-license-table"><tr>
      <th>Facility</th><th>Effective Date</th><th>Status</th></tr>`;
    for (const row of rows) {
      const match = row.match(/^([^:]+):\s*([^\(]+)\s*\(([^)]+)\)$/);
      if (match) {
        table += `<tr>
          <td>${match[1].trim()}</td>
          <td>${match[2].trim()}</td>
          <td>${match[3].trim()}</td>
        </tr>`;
      } else {
        table += `<tr><td colspan="3">${row}</td></tr>`;
      }
    }
    table += `</table>`;
    return table;
  }

  // --- Grouping logic ---
  function groupResults(results) {
    const groups = {};
    for (const row of results) {
      const groupKey = JSON.stringify({
        ...row,
        claimId: undefined,
        activityId: undefined,
        encounterStart: undefined,
      });
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(row);
    }
    return Object.values(groups);
  }

  // Main validation logic (now checks any affiliated facility)
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

    // Console grouping per unique clinician+affiliated+license
    const clinicianLogs = {};

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

        let performingEff = '', performingStatus = '', performingStatusDisplay = '';
        let valid = false;

        const entries = clinicianStatusMap[pid] || [];
        const encounterD = parseDMY(encounterStart);

        // -- FIX: Accept license at any affiliated facility --
        const eligible = entries.filter(e => {
          const fac = (e.facility || '').toString().trim().toUpperCase();
          const effDate = parseDMY(e.effective);
          const isAffiliated = affiliatedLicenses.has(fac);
          const effOk = !!e.effective && !isNaN(effDate) && effDate <= encounterD;
          const isActive = (e.status || '').toLowerCase() === 'active';
          return isAffiliated && effOk && isActive;
        });

        let mostRecent = null;
        if (eligible.length > 0) {
          eligible.sort((a, b) => parseDMY(b.effective) - parseDMY(a.effective));
          mostRecent = eligible[0];
          valid = true;
        } else {
          remarks.push('No ACTIVE affiliated facility license for encounter date');
        }

        const fullHistory = entries.map(e =>
          `${(e.facility || '[No Facility]').toString().trim().toUpperCase()}: ${e.effective || '[No Date]'} (${e.status || '[No Status]'})`
        ).join('; ');

        if (mostRecent) {
          performingEff = mostRecent.effective || '';
          performingStatus = mostRecent.status || '';
          performingStatusDisplay = (performingEff ? `${performingEff}${performingStatus ? ' (' + performingStatus + ')' : ''}` : '');
        }

        // Grouping key: performing clinician, any affiliated facility, and full license history
        // (for logging, you may want to group just on pid and fullHistory)
        const logKey = `${pid}|${fullHistory}`;

        if (!clinicianLogs[logKey]) {
          clinicianLogs[logKey] = {
            pid,
            performingDisplay,
            affiliated: Array.from(new Set(entries.map(e => (e.facility || '').toString().trim().toUpperCase()).filter(fac => affiliatedLicenses.has(fac)))),
            fullHistory,
            claimIds: [],
            licenses: entries.map(e => ({
              facility: (e.facility || '').toString().trim().toUpperCase(),
              effective: e.effective,
              status: e.status
            }))
          };
        }
        clinicianLogs[logKey].claimIds.push(claimId);

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

    // Output single log per clinician/affiliation/license
    Object.values(clinicianLogs).forEach(log => {
      console.log(
        `[Clinician] ${log.performingDisplay} | Affiliated Facilities: [${log.affiliated.join(', ')}] | Claim IDs: [${log.claimIds.join(', ')}] | Licenses:`,
        log.licenses
      );
    });

    lastResults = results;
    renderResults(results);
    if (csvBtn) csvBtn.disabled = !(results.length > 0);
  }

  // --- Streamlined, grouped rendering with modal for Claim IDs ---
  function renderResults(results) {
    let validCt = results.filter(r => r.valid).length;
    let total = results.length;
    let pct = total ? Math.round(validCt / total * 100) : 0;

    const groupedResults = groupResults(results);
    const modalData = {};

    resultsDiv.innerHTML =
      `<div class="${pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message'}">
        Validation: ${validCt}/${total} valid (${pct}%)
      </div>` +
      '<table><tr>' +
      '<th>Claim(s)</th><th>Activity</th><th>Encounter Start(s)</th><th>Facility License Number</th>' +
      '<th>Ordering</th>' +
      '<th>Performing</th><th>Recent Performing License Status</th><th>Full License History</th>' +
      '<th>Remarks</th></tr>' +
      groupedResults.map((group, groupIdx) => {
        const sortedGroup = group.slice().sort((a, b) => parseDMY(a.encounterStart) - parseDMY(b.encounterStart));
        const claimIds = sortedGroup.map(r => r.claimId);
        const uniqueClaimIds = Array.from(new Set(claimIds));
        const activityIds = sortedGroup.map(r => r.activityId);
        const encounterStarts = sortedGroup.map(r => r.encounterStart);
        const uniqueEncounterStarts = Array.from(new Set(encounterStarts));

        // Table in modal: claim, activity, encounter start (all three columns)
        let lastClaimId = null;
        const tableRows = sortedGroup.map(r => {
          let claimCell = '';
          if (r.claimId !== lastClaimId) {
            claimCell = `<td>${r.claimId}</td>`;
            lastClaimId = r.claimId;
          } else {
            claimCell = `<td></td>`;
          }
          return `<tr>${claimCell}<td>${r.activityId}</td><td>${r.encounterStart}</td></tr>`;
        }).join('');
        const modalHtml = `
          <div>
            <b>All Claim IDs:</b> ${uniqueClaimIds.join(', ')}
            <br>
            <b>All Encounter Starts:</b> ${uniqueEncounterStarts.join(', ')}
            <br>
            <b>Table:</b>
            <table style="margin:0.5em 0;">
              <tr><th>Claim ID</th><th>Activity ID</th><th>Encounter Start</th></tr>
              ${tableRows}
            </table>
          </div>
        `;

        const modalId = `claimModal_${groupIdx}`;
        modalData[modalId] = modalHtml;

        const r = sortedGroup[0];
        return `<tr class="${r.valid ? 'valid' : 'invalid'}">
          <td>
            <button class="view-claims-group" data-modalid="${modalId}">${uniqueClaimIds.length} Claims</button>
          </td>
          <td>${activityIds[0]}</td>
          <td>${uniqueEncounterStarts.join(', ')}</td>
          <td>${r.facilityLicenseNumber}</td>
          <td>${r.orderingDisplay}</td>
          <td>${r.performingDisplay}</td>
          <td>${r.recentStatus}</td>
          <td class="description-col">
            <button class="view-license-history" data-fullhistory="${encodeURIComponent(r.fullHistory)}">View</button>
          </td>
          <td class="description-col">${r.remarks.join('; ')}</td>
        </tr>`;
      }).join('') + '</table>' +
      `<div id="claimIdsModal" class="modal" style="display:none;">
        <div class="modal-content">
          <span class="close" id="claimIdsModalClose">&times;</span>
          <h3>Group Details</h3>
          <div id="claimIdsModalText"></div>
        </div>
      </div>
      <div id="licenseHistoryModal" class="modal" style="display:none;">
        <div class="modal-content">
          <span class="close" id="licenseHistoryClose">&times;</span>
          <h3>Full License History</h3>
          <div id="licenseHistoryText"></div>
        </div>
      </div>`;

    // Attach click handlers for license history modal
    document.querySelectorAll('.view-license-history').forEach(btn => {
      btn.addEventListener('click', function() {
        const fullHistory = decodeURIComponent(this.getAttribute('data-fullhistory'));
        document.getElementById('licenseHistoryText').innerHTML = formatLicenseHistory(fullHistory);
        document.getElementById('licenseHistoryModal').style.display = 'block';
      });
    });
    document.getElementById('licenseHistoryClose').onclick = function() {
      document.getElementById('licenseHistoryModal').style.display = 'none';
    };
    document.getElementById('licenseHistoryModal').onclick = function(event) {
      if (event.target === this) this.style.display = 'none';
    };

    // Attach click handlers for claims group modal
    document.querySelectorAll('.view-claims-group').forEach(btn => {
      btn.addEventListener('click', function() {
        const modalId = this.getAttribute('data-modalid');
        document.getElementById('claimIdsModalText').innerHTML = modalData[modalId];
        document.getElementById('claimIdsModal').style.display = 'block';
      });
    });
    document.getElementById('claimIdsModalClose').onclick = function() {
      document.getElementById('claimIdsModal').style.display = 'none';
    };
    document.getElementById('claimIdsModal').onclick = function(event) {
      if (event.target === this) this.style.display = 'none';
    };

    updateUploadStatus();
  }


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
    if (facilitiesLoaded && affiliatedLicenses.size) {
      messages.push(`${affiliatedLicenses.size} Facilities Loaded`);
    } else {
      messages.push('Facilities not loaded');
    }
    uploadDiv.textContent = messages.join(', ');
    processBtn.disabled = !(claimCount && clinicianCount && historyCount && facilitiesLoaded && affiliatedLicenses.size);
  }
})();
