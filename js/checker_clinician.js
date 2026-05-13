(function () {
  try {
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

  // Resource paths configuration
  const RESOURCE_PATHS = {
    FACILITIES_JSON: '../json/facilities.json',
    CLINICIAN_LICENSES_JSON: '../json/clinician_licenses.json', // Use JSON instead of Excel
    LICENSING_HISTORY_XLSX: '../resources/Clinician%20Licensing%20History.xlsx'
  };

  let xmlDoc = null, clinicianMap = {}, clinicianStatusMap = {};
  let xmlInput, clinicianInput, statusInput, processBtn, csvBtn, resultsDiv, uploadDiv;
  let claimCount = 0, clinicianCount = 0, historyCount = 0;
  let lastResults = [];
  let affiliatedLicenses = new Set();
  let facilitiesLoaded = false;
  let clinicianDataLoaded = false;
  let statusDataLoaded = false;
  let isLoadingData = false; // Track if data is currently being loaded

  // Load affiliated facilities (small file, load immediately)
  console.log('[INFO] Loading facilities.json...');
  fetch(RESOURCE_PATHS.FACILITIES_JSON)
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

  // Helper function to fetch and parse Excel from URL
  function fetchExcelFromUrl(url, sheetName) {
    return fetch(url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error ${response.status} - ${response.statusText}`);
        }
        return response.arrayBuffer();
      })
      .then(buffer => {
        const data = new Uint8Array(buffer);
        const workbook = XLSX.read(data, { type: 'array' });
        let sheet;
        if (sheetName && workbook.SheetNames.includes(sheetName)) {
          sheet = workbook.Sheets[sheetName];
        } else {
          sheet = workbook.Sheets[workbook.SheetNames[0]];
        }
        return XLSX.utils.sheet_to_json(sheet);
      });
  }

  // Lazy load clinician data - only load when needed
  function loadClinicianData() {
    if (isLoadingData) {
      console.log('[INFO] Data already loading...');
      return Promise.resolve();
    }
    
    if (clinicianDataLoaded && statusDataLoaded) {
      console.log('[INFO] Data already loaded');
      return Promise.resolve();
    }
    
    isLoadingData = true;
    console.log('[INFO] Starting lazy load of clinician data...');
    
    // Show loading message
    if (uploadDiv) {
      uploadDiv.textContent = 'Loading clinician data... Please wait.';
    }
    
    const promises = [];
    
    // Load clinician licenses from JSON (faster than Excel)
    if (!clinicianDataLoaded) {
      console.log('[INFO] Loading clinician licenses from JSON...');
      promises.push(
        fetch(RESOURCE_PATHS.CLINICIAN_LICENSES_JSON)
          .then(response => {
            if (!response.ok) {
              throw new Error(`HTTP error ${response.status} - ${response.statusText}`);
            }
            return response.json();
          })
          .then(data => {
            clinicianMap = {};
            data.forEach(row => {
              // JSON structure uses "Phy Lic" instead of "Clinician License"
              const id = (row['Phy Lic'] || row['Clinician License'] || '').toString().trim();
              if (!id) return;
              clinicianMap[id] = {
                name: row['Clinician Name'] || row['Name'] || '',
                category: row['Clinician Category'] || row['Category'] || row['Specialty'] || '',
              };
            });
            clinicianCount = Object.keys(clinicianMap).length;
            clinicianDataLoaded = true;
            console.log(`[INFO] Loaded ${clinicianCount} clinicians from JSON`);
          })
          .catch(err => {
            clinicianDataLoaded = false;
            console.warn('[CLINICIAN] Failed to load clinician licenses JSON:', err);
            throw err;
          })
      );
    }
    
    // Load licensing history from Excel (no JSON alternative yet)
    if (!statusDataLoaded) {
      console.log('[INFO] Loading licensing history from Excel...');
      promises.push(
        fetchExcelFromUrl(RESOURCE_PATHS.LICENSING_HISTORY_XLSX, 'Clinician Licensing Status')
          .then(data => {
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
            statusDataLoaded = true;
            console.log(`[INFO] Loaded ${historyCount} license histories from Excel`);
          })
          .catch(err => {
            statusDataLoaded = false;
            console.warn('[CLINICIAN] Failed to load licensing history Excel:', err);
            throw err;
          })
      );
    }
    
    return Promise.all(promises)
      .then(() => {
        isLoadingData = false;
        updateUploadStatus();
        console.log('[INFO] ✓ All clinician data loaded successfully');
      })
      .catch(err => {
        isLoadingData = false;
        updateUploadStatus();
        console.error('[CLINICIAN] Failed to load data:', err);
        if (uploadDiv) {
          uploadDiv.textContent = 'Error loading clinician data. Please try again or upload manually.';
        }
        throw err;
      });
  }

  // Remove auto-loading - data will be loaded lazily when clinician checker is opened

  document.addEventListener('DOMContentLoaded', () => {
    try {
      xmlInput = document.getElementById('xmlFileInput');
      clinicianInput = document.getElementById('clinicianFileInput');
      statusInput = document.getElementById('statusFileInput');
      processBtn = document.getElementById('processBtn');
      csvBtn = document.getElementById('csvBtn');
      resultsDiv = document.getElementById('results');
      uploadDiv = document.getElementById('uploadStatus');

      if (xmlInput) xmlInput.addEventListener('change', handleXmlInput);
      if (clinicianInput) clinicianInput.addEventListener('change', handleClinicianInput);
      if (statusInput) statusInput.addEventListener('change', handleStatusInput);

      if (processBtn) {
        processBtn.addEventListener('click', validateClinicians);
        processBtn.disabled = true;
      }
      if (csvBtn) {
        csvBtn.addEventListener('click', exportResults);
        csvBtn.disabled = true;
      }
      updateUploadStatus();
    } catch (error) {
      console.error('[CLINICIAN] DOMContentLoaded initialization error:', error);
    }
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

  // --- Grouping logic: Group by Claim ID ---
  function groupResultsByClaim(results) {
    const claimGroups = {};
    for (const row of results) {
      const claimId = row.claimId;
      if (!claimGroups[claimId]) {
        claimGroups[claimId] = {
          claimId: claimId,
          activities: [],
          encounterStart: row.encounterStart,
          facilityLicenseNumber: row.facilityLicenseNumber,
          // For claim-level data, we'll take the first activity's data
          // or aggregate if there are multiple different values
          orderingClinicians: new Set(),
          performingClinicians: new Set(),
          recentStatuses: new Set(),
          fullHistories: new Set(),
          remarks: new Set(),
          valid: true  // Will be set to false if any activity is invalid
        };
      }
      
      // Add activity to the claim
      claimGroups[claimId].activities.push({
        activityId: row.activityId,
        orderingDisplay: row.orderingDisplay,
        performingDisplay: row.performingDisplay,
        recentStatus: row.recentStatus,
        fullHistory: row.fullHistory,
        remarks: row.remarks
      });
      
      // Aggregate unique values
      if (row.orderingDisplay) claimGroups[claimId].orderingClinicians.add(row.orderingDisplay);
      if (row.performingDisplay) claimGroups[claimId].performingClinicians.add(row.performingDisplay);
      if (row.recentStatus) claimGroups[claimId].recentStatuses.add(row.recentStatus);
      if (row.fullHistory) claimGroups[claimId].fullHistories.add(row.fullHistory);
      if (row.remarks && Array.isArray(row.remarks)) {
        row.remarks.forEach(r => claimGroups[claimId].remarks.add(r));
      }
      
      // If any activity is invalid, mark the claim as invalid
      if (!row.valid) claimGroups[claimId].valid = false;
    }
    
    // Convert sets to arrays/strings for display
    return Object.values(claimGroups).map(claim => ({
      ...claim,
      orderingDisplay: Array.from(claim.orderingClinicians).join('; '),
      performingDisplay: Array.from(claim.performingClinicians).join('; '),
      recentStatus: Array.from(claim.recentStatuses).join('; '),
      fullHistory: Array.from(claim.fullHistories).join('; '),
      remarksList: Array.from(claim.remarks)
    }));
  }

  // Main validation logic (now checks any affiliated facility)
  async function validateClinicians() {
    if (!xmlDoc) {
      logCriticalError('No XML loaded', '');
      return null;
    }
    if (!facilitiesLoaded || affiliatedLicenses.size === 0) {
      logCriticalError('Facility list not loaded. Please check facilities.json and reload.', '');
      return null;
    }
    
    // Lazy load clinician data if not already loaded
    try {
      await loadClinicianData();
    } catch (err) {
      logCriticalError('Failed to load clinician data', err);
      return null;
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
    const tableElement = buildResultsTable(results);
    if (csvBtn) csvBtn.disabled = !(results.length > 0);
    return tableElement;
  }

  // --- Streamlined, claim-grouped rendering with modal for Activities ---
  function buildResultsTable(results) {
    let validCt = results.filter(r => r.valid).length;
    let total = results.length;
    let pct = total ? Math.round(validCt / total * 100) : 0;

    const claimGroups = groupResultsByClaim(results);
    const modalData = {};

    const container = document.createElement('div');
    container.innerHTML =
      `<div class="${pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message'}">
        Validation: ${validCt}/${total} activities valid (${pct}%) across ${claimGroups.length} claim${claimGroups.length === 1 ? '' : 's'}
      </div>` +
      '<table><tr>' +
      '<th>Claim ID</th><th>Activity</th><th>Encounter Start</th><th>Facility License Number</th>' +
      '<th>Ordering Clinician</th>' +
      '<th>Performing Clinician</th><th>Recent Performing License</th><th>Full License History</th>' +
      '<th>Remarks</th></tr>' +
      claimGroups.map((claim, claimIdx) => {
        // Build modal content for activities
        const activityTableRows = claim.activities.map(act => {
          return `<tr>
            <td>${act.activityId}</td>
            <td>${act.orderingDisplay || ''}</td>
            <td>${act.performingDisplay || ''}</td>
            <td>${act.recentStatus || ''}</td>
            <td class="description-col">${act.remarks.map(s => s && !s.endsWith('.') ? s + '.' : s).join('; ')}</td>
          </tr>`;
        }).join('');
        
        const modalHtml = `
          <div>
            <b>Claim ID:</b> ${claim.claimId}
            <br>
            <b>Total Activities:</b> ${claim.activities.length}
            <br><br>
            <table style="margin:0.5em 0; width:100%;">
              <tr>
                <th>Activity ID</th>
                <th>Ordering Clinician</th>
                <th>Performing Clinician</th>
                <th>Recent License</th>
                <th>Remarks</th>
              </tr>
              ${activityTableRows}
            </table>
          </div>
        `;

        const modalId = `activityModal_${claimIdx}`;
        modalData[modalId] = modalHtml;

        return `<tr class="${claim.valid ? 'valid' : 'invalid'}">
          <td>${claim.claimId}</td>
          <td>
            <button class="view-activities" data-modalid="${modalId}">${claim.activities.length} Activit${claim.activities.length === 1 ? 'y' : 'ies'}</button>
          </td>
          <td>${claim.encounterStart}</td>
          <td>${claim.facilityLicenseNumber}</td>
          <td>${claim.orderingDisplay}</td>
          <td>${claim.performingDisplay}</td>
          <td>${claim.recentStatus}</td>
          <td class="description-col">
            <button class="view-license-history" data-fullhistory="${encodeURIComponent(claim.fullHistory)}">View</button>
          </td>
          <td class="description-col">${claim.remarksList.map(s => s && !s.endsWith('.') ? s + '.' : s).join('; ')}</td>
        </tr>`;
      }).join('') + '</table>' +
      `<div id="activityModal" class="modal" style="display:none;">
        <div class="modal-content">
          <span class="close" id="activityModalClose">&times;</span>
          <h3>Activities</h3>
          <div id="activityModalText"></div>
        </div>
      </div>
      <div id="licenseHistoryModal" class="modal" style="display:none;">
        <div class="modal-content">
          <span class="close" id="licenseHistoryClose">&times;</span>
          <h3>Full License History</h3>
          <div id="licenseHistoryText"></div>
        </div>
      </div>`;

    // Attach click handlers for license history modal after a delay (to ensure DOM is ready)
    setTimeout(() => {
      document.querySelectorAll('.view-license-history').forEach(btn => {
        btn.addEventListener('click', function() {
          const fullHistory = decodeURIComponent(this.getAttribute('data-fullhistory'));
          document.getElementById('licenseHistoryText').innerHTML = formatLicenseHistory(fullHistory);
          document.getElementById('licenseHistoryModal').style.display = 'block';
        });
      });
      const licenseHistoryClose = document.getElementById('licenseHistoryClose');
      if (licenseHistoryClose) {
        licenseHistoryClose.onclick = function() {
          document.getElementById('licenseHistoryModal').style.display = 'none';
        };
      }
      const licenseHistoryModal = document.getElementById('licenseHistoryModal');
      if (licenseHistoryModal) {
        licenseHistoryModal.onclick = function(event) {
          if (event.target === this) this.style.display = 'none';
        };
      }

      // Attach click handlers for activities modal
      document.querySelectorAll('.view-activities').forEach(btn => {
        btn.addEventListener('click', function() {
          const modalId = this.getAttribute('data-modalid');
          document.getElementById('activityModalText').innerHTML = modalData[modalId];
          document.getElementById('activityModal').style.display = 'block';
        });
      });
      const activityModalClose = document.getElementById('activityModalClose');
      if (activityModalClose) {
        activityModalClose.onclick = function() {
          document.getElementById('activityModal').style.display = 'none';
        };
      }
      const activityModal = document.getElementById('activityModal');
      if (activityModal) {
        activityModal.onclick = function(event) {
          if (event.target === this) this.style.display = 'none';
        };
      }
      
      updateUploadStatus();
    }, 0);
    
    return container;
  }


  function exportResults() {
    if (!window.XLSX || !lastResults.length) return;
    
    // Group results by claim
    const claimGroups = groupResultsByClaim(lastResults);
    
    const headers = [
      'Claim ID', 'Activity Count', 'Encounter Start',
      'Facility License Number',
      'Ordering Clinician',
      'Performing Clinician', 'Recent Performing License',
      'Full License History',
      'Remarks'
    ];
    const rows = claimGroups.map(claim => [
      claim.claimId,
      claim.activities.length,
      claim.encounterStart,
      claim.facilityLicenseNumber || '',
      claim.orderingDisplay || '',
      claim.performingDisplay || '',
      claim.recentStatus || '',
      claim.fullHistory || '',
      claim.remarksList.map(s => s && !s.endsWith('.') ? s + '.' : s).join('; ')
    ]);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Results');
    XLSX.writeFile(wb, `ClinicianValidation.xlsx`);
  }

  function updateUploadStatus() {
    const messages = [];
    if (claimCount) messages.push(`${claimCount} Claims Loaded`);
    if (clinicianCount) {
      const source = clinicianDataLoaded ? '(lazy-loaded from JSON)' : '(user-uploaded)';
      messages.push(`${clinicianCount} Clinicians ${source}`);
    } else if (!clinicianDataLoaded && !isLoadingData) {
      messages.push('Clinician data: Will load when needed');
    }
    if (historyCount) {
      const source = statusDataLoaded ? '(lazy-loaded)' : '(user-uploaded)';
      messages.push(`${historyCount} License Histories ${source}`);
    } else if (!statusDataLoaded && !isLoadingData) {
      messages.push('License history: Will load when needed');
    }
    if (facilitiesLoaded && affiliatedLicenses.size) {
      messages.push(`${affiliatedLicenses.size} Facilities Loaded`);
    } else {
      messages.push('Facilities not loaded');
    }
    if (uploadDiv) uploadDiv.textContent = messages.join(', ');
    // Enable process button if XML is loaded (data will be loaded lazily)
    if (processBtn) processBtn.disabled = !(claimCount && facilitiesLoaded && affiliatedLicenses.size);
  }

  // Unified checker entry point
  window.runClinicianCheck = async function() {
    xmlInput = document.getElementById('xmlFileInput');
    clinicianInput = document.getElementById('clinicianFileInput');
    statusInput = document.getElementById('statusFileInput');
    processBtn = document.getElementById('processBtn');
    csvBtn = document.getElementById('csvBtn');
    resultsDiv = document.getElementById('results');
    uploadDiv = document.getElementById('uploadStatus');
    
    if (typeof validateClinicians === 'function') {
      return validateClinicians();
    } else {
      console.error('validateClinicians function not found');
      return null;
    }
  };

  } catch (error) {
    console.error('[CHECKER-ERROR] Failed to load checker:', error);
    console.error(error.stack);
  }
})();
