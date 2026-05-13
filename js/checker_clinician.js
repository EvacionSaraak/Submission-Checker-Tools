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

  // Excel date threshold: serial dates above this are likely dates (1000 ≈ Sep 26, 1902)
  const MIN_EXCEL_SERIAL_DATE = 1000;

  // Pathology-related profession keywords exempt from affiliation requirement for performing clinicians
  const PATHOLOGY_KEYWORDS = [
    'PATHOLOGY',
    'MEDICAL LABORATORY'
  ];

  // Helper function to check if a clinician's profession is pathology-related
  function isPathologyProfession(clinicianId) {
    if (!clinicianId) return false;
    const clinician = clinicianMap[clinicianId];
    if (!clinician || !clinician.category) return false;
    const category = clinician.category.toString().trim().toUpperCase();
    
    // Check if category contains any of the pathology keywords
    return PATHOLOGY_KEYWORDS.some(keyword => category.includes(keyword));
  }

  let xmlDoc = null, clinicianMap = {}, clinicianStatusMap = {};
  let xmlInput, clinicianInput, statusInput, processBtn, csvBtn, resultsDiv, uploadDiv;
  let claimCount = 0, clinicianCount = 0, historyCount = 0;
  let lastResults = [];
  let affiliatedLicenses = new Set();
  let facilitiesLoaded = false;
  let clinicianDataLoaded = false;
  let statusDataLoaded = false;
  let loadingPromise = null; // Cache the loading promise to prevent race conditions

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
    // Return cached promise if already loading
    if (loadingPromise) {
      console.log('[INFO] Data already loading, returning cached promise...');
      return loadingPromise;
    }
    
    if (clinicianDataLoaded && statusDataLoaded) {
      console.log('[INFO] Data already loaded');
      return Promise.resolve();
    }
    
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
    
    // Cache the promise to prevent race conditions
    loadingPromise = Promise.all(promises)
      .then(() => {
        loadingPromise = null; // Clear the cache after successful load
        updateUploadStatus();
        console.log('[INFO] ✓ All clinician data loaded successfully');
      })
      .catch(err => {
        loadingPromise = null; // Clear the cache on error too
        updateUploadStatus();
        console.error('[CLINICIAN] Failed to load data:', err);
        if (uploadDiv) {
          uploadDiv.textContent = 'Error loading clinician data. Please try again or upload manually.';
        }
        throw err;
      });
    
    return loadingPromise;
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
  // Convert Excel serial date to JavaScript Date
  function excelSerialToDate(serial) {
    // Excel serial dates start from 1900-01-01 (serial 1), but Excel has a bug treating 1900 as leap year
    // Day 1 = 1900-01-01, Day 60 = 1900-02-29 (bug), Day 61 = 1900-03-01
    const utcDays = Math.floor(serial) - 25569; // 25569 = days between 1900-01-01 and 1970-01-01
    const ms = utcDays * 86400 * 1000;
    return new Date(ms);
  }

  // Format date as "MM/DD/YYYY" (e.g., "08/04/2026")
  function formatDateMMDDYYYY(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return '';
    
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const year = date.getUTCFullYear();
    
    return `${month}/${day}/${year}`;
  }

  // Convert and format effective date (handles Excel serial dates and string dates)
  function formatEffectiveDate(dateValue) {
    if (!dateValue) return '';
    
    const trimmed = dateValue.toString().trim();
    if (!trimmed) return '';
    
    // Check if it's a numeric value (Excel serial date)
    const numericValue = parseFloat(trimmed);
    if (!isNaN(numericValue) && numericValue > MIN_EXCEL_SERIAL_DATE) {
      // Likely an Excel serial date (dates after ~1902)
      const date = excelSerialToDate(numericValue);
      return formatDateMMDDYYYY(date);
    }
    
    // Otherwise, return as-is (already formatted or invalid)
    return trimmed;
  }

  function formatLicenseHistory(fullHistory) {
    const rows = fullHistory.split(';').map(e => e.trim()).filter(Boolean);
    if (rows.length === 0) return "<em>No history</em>";
    let table = `<table class="modal-license-table"><tr>
      <th>Facility</th><th>Effective Date</th><th>Status</th></tr>`;
    for (const row of rows) {
      const match = row.match(/^([^:]+):\s*([^\(]+)\s*\(([^)]+)\)$/);
      if (match) {
        const facility = match[1].trim();
        const effectiveDate = formatEffectiveDate(match[2].trim());
        const status = match[3].trim();
        
        table += `<tr>
          <td>${facility}</td>
          <td>${effectiveDate}</td>
          <td>${status}</td>
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

        // Check if performing clinician is pathology-related (exempt from affiliation requirement)
        const isPathology = isPathologyProfession(pid);

        // -- FIX: Accept license at any affiliated facility --
        // For pathology professions, accept any active license regardless of facility affiliation
        const eligible = entries.filter(e => {
          const fac = (e.facility || '').toString().trim().toUpperCase();
          const effDate = parseDMY(e.effective);
          const isAffiliated = affiliatedLicenses.has(fac);
          const effOk = !!e.effective && !isNaN(effDate) && effDate <= encounterD;
          const isActive = (e.status || '').toLowerCase() === 'active';
          
          // If pathology profession, accept any active license with valid effective date
          if (isPathology) {
            return effOk && isActive;
          }
          
          // For non-pathology professions, require affiliated facility
          return isAffiliated && effOk && isActive;
        });

        let mostRecent = null;
        if (eligible.length > 0) {
          eligible.sort((a, b) => parseDMY(b.effective) - parseDMY(a.effective));
          mostRecent = eligible[0];
          valid = true;
        } else {
          if (isPathology) {
            remarks.push('No ACTIVE license for encounter date (pathology profession - affiliation not required)');
          } else {
            remarks.push('No ACTIVE affiliated facility license for encounter date');
          }
        }

        const fullHistory = entries.map(e =>
          `${(e.facility || '[No Facility]').toString().trim().toUpperCase()}: ${e.effective || '[No Date]'} (${e.status || '[No Status]'})`
        ).join('; ');

        if (mostRecent) {
          performingEff = mostRecent.effective || '';
          performingStatus = mostRecent.status || '';
          // Format the effective date before displaying
          const formattedEff = formatEffectiveDate(performingEff);
          performingStatusDisplay = (formattedEff ? `${formattedEff}${performingStatus ? ' (' + performingStatus + ')' : ''}` : '');
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
    
    // Generate unique ID for this table's modals to avoid conflicts
    const uniqueId = `clinician_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Store modalData globally for Check All to access when re-attaching listeners
    if (!window._clinicianModalData) {
      window._clinicianModalData = {};
    }
    window._clinicianModalData[uniqueId] = modalData;
    
    // Store formatLicenseHistory globally for Check All access
    window._formatClinicianLicenseHistory = formatLicenseHistory;

    // Create container
    const container = document.createElement('div');
    
    // Add validation summary
    const summary = document.createElement('div');
    summary.className = pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message';
    summary.textContent = `Validation: ${validCt}/${total} activities valid (${pct}%) across ${claimGroups.length} claim${claimGroups.length === 1 ? '' : 's'}`;
    container.appendChild(summary);
    
    // Create table with proper structure
    const table = document.createElement('table');
    table.className = 'table table-striped table-bordered';
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    
    // Create thead
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
      <th>Claim ID</th>
      <th>Activity</th>
      <th>Encounter Start</th>
      <th>Facility License Number</th>
      <th>Ordering Clinician</th>
      <th>Performing Clinician</th>
      <th>Recent Performing License</th>
      <th>Full License History</th>
      <th>Remarks</th>
    </tr>`;
    table.appendChild(thead);
    
    // Create tbody
    const tbody = document.createElement('tbody');
    
    claimGroups.forEach((claim, claimIdx) => {
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

      // Create row
      const row = document.createElement('tr');
      // Use Bootstrap table classes for styling and unified checker compatibility
      // table-success (green) for valid claims, table-danger (red) for invalid claims
      row.className = claim.valid ? 'table-success' : 'table-danger';
      row.setAttribute('data-claim-id', claim.claimId);
      
      // Format remarks as divs for Copy Invalids compatibility
      const remarksHTML = claim.remarksList && claim.remarksList.length > 0
        ? claim.remarksList.map(r => {
            const text = (r && !r.endsWith('.')) ? r + '.' : r;
            return `<div>${text}</div>`;
          }).join('')
        : '<div class="source-note">No remarks</div>';
      
      row.innerHTML = `
        <td>${claim.claimId}</td>
        <td>
          <button class="view-activities" data-modalid="${modalId}" data-uniqueid="${uniqueId}">${claim.activities.length} Activit${claim.activities.length === 1 ? 'y' : 'ies'}</button>
        </td>
        <td>${claim.encounterStart}</td>
        <td>${claim.facilityLicenseNumber}</td>
        <td>${claim.orderingDisplay}</td>
        <td>${claim.performingDisplay}</td>
        <td>${claim.recentStatus}</td>
        <td class="description-col">
          <button class="view-license-history" data-fullhistory="${encodeURIComponent(claim.fullHistory)}" data-uniqueid="${uniqueId}">View</button>
        </td>
        <td class="description-col">${remarksHTML}</td>
      `;
      
      tbody.appendChild(row);
    });
    
    table.appendChild(tbody);
    container.appendChild(table);
    
    // Add modals
    const modalsHTML = `
      <div id="activityModal_${uniqueId}" class="modal" style="display:none;">
        <div class="modal-content">
          <span class="close" id="activityModalClose_${uniqueId}">&times;</span>
          <h3>Activities</h3>
          <div id="activityModalText_${uniqueId}"></div>
        </div>
      </div>
      <div id="licenseHistoryModal_${uniqueId}" class="modal" style="display:none;">
        <div class="modal-content">
          <span class="close" id="licenseHistoryClose_${uniqueId}">&times;</span>
          <h3>Full License History</h3>
          <div id="licenseHistoryText_${uniqueId}"></div>
        </div>
      </div>
    `;
    
    const modalsContainer = document.createElement('div');
    modalsContainer.innerHTML = modalsHTML;
    container.appendChild(modalsContainer);

    // Attach click handlers for license history modal after a delay (to ensure DOM is ready)
    setTimeout(() => {
      container.querySelectorAll('.view-license-history').forEach(btn => {
        btn.addEventListener('click', function() {
          const uniqueIdFromButton = this.getAttribute('data-uniqueid');
          const fullHistory = decodeURIComponent(this.getAttribute('data-fullhistory'));
          
          // Find modals with this unique ID
          const licenseHistoryModal = container.querySelector(`#licenseHistoryModal_${uniqueIdFromButton}`);
          const licenseHistoryText = container.querySelector(`#licenseHistoryText_${uniqueIdFromButton}`);
          
          if (licenseHistoryText) licenseHistoryText.innerHTML = formatLicenseHistory(fullHistory);
          if (licenseHistoryModal) licenseHistoryModal.style.display = 'block';
        });
      });
      
      // Attach close handlers for license history modal
      const licenseHistoryClose = container.querySelector(`#licenseHistoryClose_${uniqueId}`);
      const licenseHistoryModal = container.querySelector(`#licenseHistoryModal_${uniqueId}`);
      
      if (licenseHistoryClose) {
        licenseHistoryClose.onclick = function() {
          if (licenseHistoryModal) licenseHistoryModal.style.display = 'none';
        };
      }
      
      if (licenseHistoryModal) {
        licenseHistoryModal.onclick = function(event) {
          if (event.target === this) this.style.display = 'none';
        };
      }

      // Attach click handlers for activities modal
      container.querySelectorAll('.view-activities').forEach(btn => {
        btn.addEventListener('click', function() {
          const uniqueIdFromButton = this.getAttribute('data-uniqueid');
          const modalId = this.getAttribute('data-modalid');
          
          // Find modals with this unique ID
          const activityModal = container.querySelector(`#activityModal_${uniqueIdFromButton}`);
          const activityModalText = container.querySelector(`#activityModalText_${uniqueIdFromButton}`);
          
          if (activityModalText) activityModalText.innerHTML = modalData[modalId];
          if (activityModal) activityModal.style.display = 'block';
        });
      });
      
      // Attach close handlers for activity modal
      const activityModalClose = container.querySelector(`#activityModalClose_${uniqueId}`);
      const activityModal = container.querySelector(`#activityModal_${uniqueId}`);
      
      if (activityModalClose) {
        activityModalClose.onclick = function() {
          if (activityModal) activityModal.style.display = 'none';
        };
      }
      
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
    } else if (!clinicianDataLoaded && !loadingPromise) {
      messages.push('Clinician data: Will load when needed');
    }
    if (historyCount) {
      const source = statusDataLoaded ? '(lazy-loaded)' : '(user-uploaded)';
      messages.push(`${historyCount} License Histories ${source}`);
    } else if (!statusDataLoaded && !loadingPromise) {
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
