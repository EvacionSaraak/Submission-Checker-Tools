// unified_checker.js - Unified controller for all checkers
// Refactored: Checkers return tables; rendering handled centrally

(function() {
  'use strict';

  // Constants
  const CLIPBOARD_FEEDBACK_DURATION_MS = 2000;
  const ERROR_FEEDBACK_DURATION_EXTENSION_FACTOR = 1.5; // Extend error messages display time by 50%
  const INVALID_ROW_CLASSES = 'tbody tr.table-danger, tbody tr.table-warning';
  
  // Remarks column offset varies by checker:
  // - Most checkers: Remarks is 2nd from end (before Details/Compare which is last)
  // - Timings checker: Remarks is LAST column (no column after it)
  const REMARKS_COLUMN_OFFSET_DEFAULT = 2; // Most checkers: second-to-last
  const REMARKS_COLUMN_OFFSET_TIMINGS = 1; // Timings: last column

  // Initialize session counter immediately
  (function initSessionCounter() {
    let sessionCount = sessionStorage.getItem('checkerSessionCount');
    sessionCount = sessionCount ? parseInt(sessionCount) + 1 : 1;
    sessionStorage.setItem('checkerSessionCount', sessionCount);
    console.log(`[INIT] Unified Checker v1.2.107 - Session #${sessionCount}`);
    
    // Update DOM when ready
    document.addEventListener('DOMContentLoaded', () => {
      const sessionElement = document.getElementById('sessionCount');
      if (sessionElement) {
        sessionElement.textContent = `v1.2.98 | Session #${sessionCount}`;
      }
    });
  })();

  // File storage
  const files = {
    xml: null,
    clinician: null,
    eligibility: null,
    auth: null,
    status: null,
    pricing: null
  };

  // Expose files globally for checkers to access
  window.unifiedCheckerFiles = files;

  let activeChecker = null;
  
  // Filter state for floating button
  let filterActive = false;
  
  // Debug log for Check All functionality
  let debugLog = [];
  
  // Storage for invalid rows from Check All
  let invalidRowsData = [];

  // Helper function to add to debug log
  function logDebug(message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      message,
      data
    };
    debugLog.push(logEntry);
    console.log(`[DEBUG-LOG] ${timestamp} - ${message}`, data || '');
  }

  // Loading overlay functions
  function showLoadingOverlay(text = 'Processing...', subtext = 'Please wait while we check your data') {
    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const loadingSubtext = document.getElementById('loadingSubtext');
    
    if (overlay) {
      overlay.classList.add('active');
      if (loadingText) loadingText.textContent = text;
      if (loadingSubtext) loadingSubtext.textContent = subtext;
      console.log('[LOADING] Showing loading overlay:', text);
    }
  }
  
  function hideLoadingOverlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
      overlay.classList.remove('active');
      console.log('[LOADING] Hiding loading overlay');
    }
  }
  
  function updateLoadingOverlay(text, subtext) {
    const loadingText = document.getElementById('loadingText');
    const loadingSubtext = document.getElementById('loadingSubtext');
    if (loadingText) loadingText.textContent = text;
    if (loadingSubtext) loadingSubtext.textContent = subtext;
  }

  // DOM elements
  let elements = {};

  document.addEventListener('DOMContentLoaded', init);

  // LocalStorage helpers for file persistence
  function init() {
    elements = {
      // File inputs
      xmlInput: document.getElementById('xmlFileInput'),
      clinicianInput: document.getElementById('clinicianFileInput'),
      eligibilityInput: document.getElementById('eligibilityFileInput'),
      authInput: document.getElementById('authFileInput'),
      statusInput: document.getElementById('statusFileInput'),
      pricingInput: document.getElementById('pricingFileInput'),
      
      // Status spans
      xmlStatus: document.getElementById('xmlStatus'),
      clinicianStatus: document.getElementById('clinicianStatus'),
      eligibilityStatus: document.getElementById('eligibilityStatus'),
      authStatus: document.getElementById('authStatus'),
      statusStatus: document.getElementById('statusStatus'),
      pricingStatus: document.getElementById('pricingStatus'),
      
      // Buttons
      btnClinician: document.getElementById('btn-clinician'),
      btnElig: document.getElementById('btn-elig'),
      btnAuths: document.getElementById('btn-auths'),
      btnTimings: document.getElementById('btn-timings'),
      btnTeeth: document.getElementById('btn-teeth'),
      btnSchema: document.getElementById('btn-schema'),
      btnPricing: document.getElementById('btn-pricing'),
      btnModifiers: document.getElementById('btn-modifiers'),
      btnCheckAll: document.getElementById('btn-check-all'),
      
      // Export and filter
      exportBtn: document.getElementById('exportBtn'),
      exportInvalidsBtn: document.getElementById('exportInvalidsBtn'),
      floatingFilterBtn: document.getElementById('floatingFilterBtn'),
      debugLogContainer: document.getElementById('debugLogContainer'),
      downloadDebugLogBtn: document.getElementById('downloadDebugLogBtn'),
      
      // Results
      uploadStatus: document.getElementById('uploadStatus'),
      resultsContainer: document.getElementById('results-container')
    };

    // File input event listeners - add null checks to prevent crashes
    // Also add click listeners to reset input value (allows re-uploading same filename)
    if (elements.xmlInput) {
      elements.xmlInput.addEventListener('click', (e) => {
        e.target.value = ''; // Reset to allow same file to be re-uploaded
      });
      elements.xmlInput.addEventListener('change', (e) => {
        handleFileChange(e, 'xml', elements.xmlStatus);
      });
    }
    if (elements.clinicianInput) {
      elements.clinicianInput.addEventListener('click', (e) => {
        e.target.value = '';
      });
      elements.clinicianInput.addEventListener('change', (e) => {
        handleFileChange(e, 'clinician', elements.clinicianStatus);
      });
    }
    if (elements.eligibilityInput) {
      elements.eligibilityInput.addEventListener('click', (e) => {
        e.target.value = '';
      });
      elements.eligibilityInput.addEventListener('change', (e) => {
        handleFileChange(e, 'eligibility', elements.eligibilityStatus);
      });
    }
    if (elements.authInput) {
      elements.authInput.addEventListener('click', (e) => {
        e.target.value = '';
      });
      elements.authInput.addEventListener('change', (e) => {
        handleFileChange(e, 'auth', elements.authStatus);
      });
    }
    if (elements.statusInput) {
      elements.statusInput.addEventListener('click', (e) => {
        e.target.value = '';
      });
      elements.statusInput.addEventListener('change', (e) => {
        handleFileChange(e, 'status', elements.statusStatus);
      });
    }
    if (elements.pricingInput) {
      elements.pricingInput.addEventListener('click', (e) => {
        e.target.value = '';
      });
      elements.pricingInput.addEventListener('change', (e) => {
        handleFileChange(e, 'pricing', elements.pricingStatus);
      });
    }

    // Checker button event listeners
    elements.btnTimings.addEventListener('click', () => {
      runChecker('timings');
    });
    elements.btnTeeth.addEventListener('click', () => {
      runChecker('teeth');
    });
    elements.btnSchema.addEventListener('click', () => {
      runChecker('schema');
    });
    elements.btnClinician.addEventListener('click', () => {
      runChecker('clinician');
    });
    elements.btnElig.addEventListener('click', () => {
      runChecker('elig');
    });
    elements.btnAuths.addEventListener('click', () => {
      runChecker('auths');
    });
    elements.btnPricing.addEventListener('click', () => {
      runChecker('pricing');
    });
    elements.btnModifiers.addEventListener('click', () => {
      runChecker('modifiers');
    });
    elements.btnCheckAll.addEventListener('click', () => {
      runAllCheckers();
    });

    // Filter button - make it toggleable
    elements.floatingFilterBtn.addEventListener('click', () => {
      filterActive = !filterActive;
      elements.floatingFilterBtn.classList.toggle('active', filterActive);
      applyFilter();
    });

    // Claim type radio buttons - update button states when changed
    const claimTypeDental = document.getElementById('claimTypeDental');
    const claimTypeMedical = document.getElementById('claimTypeMedical');
    if (claimTypeDental) {
      claimTypeDental.addEventListener('change', () => {
        updateButtonStates();
      });
    }
    if (claimTypeMedical) {
      claimTypeMedical.addEventListener('change', () => {
        updateButtonStates();
      });
    }

    // Export button
    if (elements.exportBtn) elements.exportBtn.addEventListener('click', exportResults);
    
    // Export Invalids button
    if (elements.exportInvalidsBtn) {
      elements.exportInvalidsBtn.addEventListener('click', exportInvalids);
      // Speech bubble is visible by default in HTML with initial message
    }

    // Debug log download button
    if (elements.downloadDebugLogBtn) {
      console.log('[INIT] Debug log button found, attaching click listener');
      elements.downloadDebugLogBtn.addEventListener('click', () => {
        console.log('[DEBUG-LOG] Debug button clicked');
        downloadDebugLog();
      });
    } else {
      console.warn('[INIT] Debug log button not found in DOM');
    }

    console.log('[INIT] Performing initial button state update...');
    updateButtonStates();
    
    // Bug #29 fix: Ensure Modifiers button is hidden on page load if Dental is selected
    if (claimTypeDental && claimTypeDental.checked && elements.btnModifiers) {
      console.log('[INIT] DENTAL selected on page load - ensuring Modifiers button is hidden');
      elements.btnModifiers.style.display = 'none';
    }
    
    console.log('[INIT] ✓ Initialization complete! Ready for file uploads.');
  }

  function handleFileChange(event, fileKey, statusElement) {
    const file = event.target.files[0];
    if (file) {
      files[fileKey] = file;
      statusElement.textContent = `✓ ${file.name}`;
      statusElement.style.color = '#0f5132';
      statusElement.style.backgroundColor = '#d1e7dd';
      statusElement.style.fontWeight = 'bold';
      
      // Console log
      console.log(`[FILE] Uploaded: ${fileKey} = "${file.name}" (${(file.size / 1024).toFixed(1)} KB, type: ${file.type})`);
    } else {
      files[fileKey] = null;
      statusElement.textContent = '';
      statusElement.style.backgroundColor = '';
      
      console.log(`[FILE] Cleared: ${fileKey}`);
    }
    updateButtonStates();
  }

  function updateButtonStates() {
    console.log('[BUTTON] Updating button states based on available files and claim type...');
    console.log('[BUTTON] Current files state:', JSON.stringify(files));
    
    // Check claim type selection
    const claimTypeMedical = document.getElementById('claimTypeMedical');
    const isMedical = claimTypeMedical && claimTypeMedical.checked;
    
    const requirements = {
      clinician: ['xml', 'clinician', 'status'],
      elig: ['xml', 'eligibility'],
      auths: ['xml', 'auth'],
      timings: ['xml'],
      teeth: ['xml'],
      schema: ['xml'],
      pricing: ['xml', 'pricing'],
      modifiers: ['xml', 'eligibility']
    };

    for (const [checker, reqs] of Object.entries(requirements)) {
      const btnName = `btn${checker.charAt(0).toUpperCase() + checker.slice(1)}`;
      const button = elements[btnName];
      console.log(`[BUTTON] Checking ${checker}: button element found = ${!!button}, btnName = ${btnName}`);
      
      if (button) {
        // Special handling for Modifiers - only available for Medical claims
        if (checker === 'modifiers' && !isMedical) {
          button.disabled = true;
          button.style.display = 'none';
          
          // Also hide the modifiers container if it's currently active
          const modifiersContainer = document.getElementById('checker-container-modifiers');
          if (modifiersContainer && activeChecker === 'modifiers') {
            modifiersContainer.style.display = 'none';
            modifiersContainer.innerHTML = ''; // Clear the content
            activeChecker = null;
            console.log('[BUTTON] Cleared modifiers container (switched to DENTAL)');
          }
          
          console.log(`[BUTTON] ${checker}: HIDDEN (claim type is DENTAL, modifiers only available for MEDICAL)`);
          continue;
        } else if (checker === 'modifiers' && isMedical) {
          button.style.display = '';  // Show button when Medical
        }
        
        const hasAll = reqs.every(req => {
          const hasFile = files[req] !== null && files[req] !== undefined;
          console.log(`[BUTTON]   - Checking requirement '${req}': ${hasFile ? 'YES' : 'NO'} (value: ${files[req] ? 'File object' : files[req]})`);
          return hasFile;
        });
        button.disabled = !hasAll;
        
        const missingFiles = reqs.filter(req => !files[req]);
        if (hasAll) {
          console.log(`[BUTTON] ${checker}: ENABLED (has all required: ${reqs.join(', ')})`);
        } else {
          console.log(`[BUTTON] ${checker}: DISABLED (missing: ${missingFiles.join(', ')})`);
        }
      } else {
        console.log(`[BUTTON] ${checker}: BUTTON ELEMENT NOT FOUND (looking for #${btnName})`);
      }
    }

    if (elements.btnCheckAll) {
      elements.btnCheckAll.disabled = !files.xml;
      if (files.xml) {
        console.log('[BUTTON] Check All: ENABLED (has XML file)');
      } else {
        console.log('[BUTTON] Check All: DISABLED (missing XML file)');
      }
    }
    
    console.log('[BUTTON] Button state update complete');
  }

  async function runChecker(checkerName) {
    console.log(`[DEBUG] runChecker called with: ${checkerName}`);
    console.log(`[DEBUG] Files available:`, Object.keys(files).filter(k => files[k]));
    
    // Safety check: Don't allow running Modifiers checker when Dental is selected
    if (checkerName === 'modifiers') {
      const claimTypeMedical = document.getElementById('claimTypeMedical');
      const isMedical = claimTypeMedical && claimTypeMedical.checked;
      if (!isMedical) {
        console.error('[ERROR] Cannot run Modifiers checker - only available for MEDICAL claims');
        elements.uploadStatus.innerHTML = '<div class="status-message error">Modifiers checker is only available for Medical claims. Please select Medical claim type.</div>';
        return;
      }
    }
    
    try {
      // Show loading overlay
      showLoadingOverlay(`Running ${checkerName} checker...`, 'Processing your data...');
      
      elements.uploadStatus.innerHTML = `<div class="status-message info">Running ${checkerName} checker...</div>`;
      
      setActiveButton(checkerName);
      activeChecker = checkerName;

      // Reset filter when starting a new checker (Bug #26 fix)
      // Always set to inactive state when new tables are loaded
      filterActive = false;
      if (elements.floatingFilterBtn) {
        elements.floatingFilterBtn.classList.remove('active');
      }
      console.log('[FILTER] Auto-reset: Filter set to off when running new checker');

      // Hide all checker containers and show the active one
      hideAllCheckerContainers();
      const container = document.getElementById(`checker-container-${checkerName}`);
      if (!container) {
        throw new Error(`Container for ${checkerName} not found`);
      }
      container.style.display = 'block';

      // Always recreate interface to ensure fresh state (Bug #3 fix)
      console.log(`[DEBUG] Creating ${checkerName} interface...`);
      createCheckerInterface(checkerName, container);

      // Sync global claim type with timings checker if applicable
      if (checkerName === 'timings') {
        console.log('[DEBUG] Syncing claim type for timings');
        syncClaimType(container);
      }

      // Set files in the checker's hidden inputs and run
      console.log(`[DEBUG] Executing ${checkerName} checker...`);
      const tableElement = await executeChecker(checkerName, container);

      // Collect invalid rows from this individual checker
      if (tableElement) {
        const invalidRows = tableElement.querySelectorAll('tbody tr.table-danger, tbody tr.table-warning, tbody tr.invalid, tbody tr.unknown');
        if (invalidRows.length > 0) {
          console.log(`[CHECKER] Found ${invalidRows.length} invalid rows in ${checkerName}`);
          // Reset invalidRowsData for single checker (don't accumulate from previous runs)
          invalidRowsData = [];
          invalidRows.forEach(row => {
            const rowData = {
              checker: checkerName,
              cells: []
            };
            row.querySelectorAll('td').forEach(cell => {
              rowData.cells.push(cell.textContent.trim());
            });
            invalidRowsData.push(rowData);
          });
          
          // Enable Export Invalids button
          if (elements.exportInvalidsBtn) {
            elements.exportInvalidsBtn.disabled = false;
            console.log(`[CHECKER] Export Invalids button enabled (${invalidRows.length} invalid rows)`);
            updateExportInvalidsTooltip(); // Remove tooltip when enabled
          }
        } else {
          // No invalids found, disable button
          invalidRowsData = [];
          if (elements.exportInvalidsBtn) {
            elements.exportInvalidsBtn.disabled = true;
            console.log(`[CHECKER] Export Invalids button disabled (no invalid rows)`);
            updateExportInvalidsTooltip('no-errors'); // Set tooltip explaining no errors found
          }
        }
      }

      // Bug #6: Clean up inactive containers to free memory
      cleanupInactiveContainers(checkerName);

      elements.uploadStatus.innerHTML = ''; // Clear status message
      if (elements.exportBtn) {
        elements.exportBtn.disabled = false;
      }
      console.log(`[DEBUG] ${checkerName} checker completed successfully`);

      // Apply filter if button is active (works on already-rendered tables)
      if (filterActive) {
        setTimeout(() => applyFilter(), 100); // Small delay to ensure table is fully rendered
      }
      
      // Hide loading overlay after completion
      hideLoadingOverlay();

    } catch (error) {
      console.error('[DEBUG] Error running checker:', error);
      console.error(error.stack);
      elements.uploadStatus.innerHTML = `<div class="status-message error">Error: ${error.message}</div>`;
      const container = document.getElementById(`checker-container-${checkerName}`);
      if (container) {
        container.innerHTML = `<div class="alert alert-danger" role="alert"><strong>Error:</strong> ${error.message}</div>`;
      }
      // Hide loading overlay on error
      hideLoadingOverlay();
    }
  }

  function hideAllCheckerContainers() {
    const containers = document.querySelectorAll('.checker-container');
    containers.forEach(c => c.style.display = 'none');
  }

  // Bug #6: Memory cleanup for inactive containers
  function cleanupInactiveContainers(activeCheckerName) {
    console.log(`[DEBUG] Cleaning up inactive containers (keeping ${activeCheckerName})`);
    const allCheckers = ['schema', 'timings', 'teeth', 'elig', 'auths', 'clinician', 'pricing', 'modifiers'];
    
    allCheckers.forEach(checkerName => {
      if (checkerName !== activeCheckerName) {
        const container = document.getElementById(`checker-container-${checkerName}`);
        if (container && container.style.display === 'none') {
          // Clear results from hidden containers to free memory
          const resultsDiv = container.querySelector('#results');
          if (resultsDiv && resultsDiv.innerHTML) {
            resultsDiv.innerHTML = '';
            console.log(`[DEBUG] Cleared results from inactive container: ${checkerName}`);
          }
        }
      }
    });
  }

  function createCheckerInterface(checkerName, container) {
    // Create a simple interface for the checker with necessary DOM elements
    const interfaces = {
      timings: () => {
        // Read current global radio button state
        const globalDental = document.getElementById('claimTypeDental');
        const globalMedical = document.getElementById('claimTypeMedical');
        const isDental = globalDental ? globalDental.checked : true;
        const isMedical = globalMedical ? globalMedical.checked : false;
        
        console.log('🟡 [TIMINGS-INIT] Creating interface with claim type:', isDental ? 'DENTAL' : 'MEDICAL');
        
        return `
          <div id="typeSelector" style="display:none;">
            <label><input type="radio" name="claimType" value="DENTAL" ${isDental ? 'checked' : ''}> Dental</label>
            <label><input type="radio" name="claimType" value="MEDICAL" ${isMedical ? 'checked' : ''}> Medical</label>
          </div>
          <input type="file" id="xmlFileInput" accept=".xml" style="display:none" />
          <button id="exportBtn" class="btn btn-secondary" style="display:none;">Export Invalid Entries</button>
          <div id="resultsSummary" style="margin:10px;font-weight:bold;"></div>
          <div id="results"></div>
        `;
      },
      teeth: `
        <input type="file" id="xmlFile" accept=".xml" style="display:none" />
        <button id="exportBtn" class="btn btn-secondary" style="display:none;">Export Invalid Activities</button>
        <div id="messageBox" style="color: red; font-weight: bold;"></div>
        <div id="resultsSummary" style="margin:10px;font-weight:bold;"></div>
        <div id="results"></div>
      `,
      schema: `
        <input type="file" id="xmlFile" accept=".xml" style="display:none" />
        <div id="uploadStatus" aria-live="polite"></div>
        <div id="results"></div>
      `,
      clinician: `
        <input type="file" id="xmlFileInput" accept=".xml" style="display:none" />
        <input type="file" id="clinicianFileInput" accept=".xlsx" style="display:none" />
        <input type="file" id="statusFileInput" accept=".xlsx" style="display:none" />
        <button id="processBtn" class="btn btn-primary" style="display:none;">Validate</button>
        <button id="exportCsvBtn" class="btn btn-secondary" style="display:none;">Export to Excel</button>
        <div id="uploadStatus" aria-live="polite"></div>
        <div id="results"></div>
      `,
      elig: `
        <div id="xmlReportInputGroup" style="display:block;">
          <input type="file" id="xmlFileInput" accept=".xml" style="display:none" />
        </div>
        <div id="reportInputGroup" style="display:none;">
          <input type="file" id="reportFileInput" accept=".xlsx" style="display:none" />
        </div>
        <input type="file" id="eligibilityFileInput" accept=".xlsx" style="display:none" />
        <div style="display:none;">
          <label><input type="radio" name="reportSource" value="xml" checked> XML</label>
          <label><input type="radio" name="reportSource" value="xls"> XLS</label>
        </div>
        <button id="processBtn" class="btn btn-primary" style="display:none;">Process</button>
        <button id="exportInvalidBtn" class="btn btn-secondary" style="display:none;">Export Invalid Rows</button>
        <div id="uploadStatus" style="margin-top:12px; color:#0074D9;"></div>
        <div id="results" style="margin-top:20px;"></div>
      `,
      auths: `
        <input type="file" id="xmlInput" accept=".xml" style="display:none" />
        <input type="file" id="xlsxInput" accept=".xlsx" style="display:none" />
        <button id="processBtn" class="btn btn-primary" style="display:none;">Run Checker</button>
        <div id="uploadStatus" style="margin-top:12px; color:#0074D9;"></div>
        <div id="file-status"></div>
        <div id="results"></div>
      `,
      pricing: `
        <input type="file" id="xml-file" accept=".xml" style="display:none" />
        <input type="file" id="xlsx-file" accept=".xlsx" style="display:none" />
        <button id="run-button" class="btn btn-primary" style="display:none;">Run Check</button>
        <button id="download-button" class="btn btn-secondary" style="display:none;">Download Results</button>
        <div id="progress-bar-container" class="progress-bar-container"></div>
        <div id="messageBox" class="message-box" aria-live="polite"></div>
        <div id="results">
          <div id="outputTableContainer" class="results-container"></div>
        </div>
      `,
      modifiers: `
        <input type="file" id="xml-file" accept=".xml" style="display:none" />
        <input type="file" id="xlsx-file" accept=".xlsx" style="display:none" />
        <button id="run-button" class="btn btn-primary" style="display:none;">Run Check</button>
        <button id="download-button" class="btn btn-secondary" style="display:none;">Download Results</button>
        <div id="messageBox" class="message-box" aria-live="polite"></div>
        <div id="results">
          <div id="outputTableContainer" class="results-container"></div>
        </div>
      `
    };

    container.innerHTML = (typeof interfaces[checkerName] === 'function' ? interfaces[checkerName]() : interfaces[checkerName]) || '<div id="results"></div>';
  }

  function syncClaimType(container) {
    // Get the global claim type selection
    const globalDental = document.getElementById('claimTypeDental');
    const globalMedical = document.getElementById('claimTypeMedical');
    
    if (!globalDental || !globalMedical) {
      console.warn('[SYNC] WARNING: Global claim type radio buttons not found');
      return;
    }
    
    const selectedType = globalDental.checked ? 'DENTAL' : 'MEDICAL';
    
    // Set the hidden radio buttons in the timings checker to match
    const timingsRadios = container.querySelectorAll('input[name="claimType"]');
    
    if (timingsRadios.length === 0) {
      console.error('[SYNC] ERROR: No radio buttons found in timings container');
      return;
    }
    
    timingsRadios.forEach((radio) => {
      radio.checked = (radio.value === selectedType);
    });
    
    // Verify the sync worked
    const checkedRadio = container.querySelector('input[name="claimType"]:checked');
    if (!checkedRadio) {
      console.error('[SYNC] ERROR: No radio button checked after sync');
    }
  }

  async function executeChecker(checkerName, container) {
    console.log(`[DEBUG] executeChecker called for: ${checkerName}`);
    
    // ✅ Clear previous results before running checker
    const resultsDiv = container.querySelector('#results');
    if (resultsDiv) {
      resultsDiv.innerHTML = '';
      console.log(`[DEBUG] Cleared previous results for ${checkerName}`);
    }
    
    // Also clear other common result containers
    const resultsSummary = container.querySelector('#resultsSummary');
    if (resultsSummary) {
      resultsSummary.innerHTML = '';
    }
    
    const messageBox = container.querySelector('#messageBox');
    if (messageBox) {
      messageBox.innerHTML = '';
    }
    
    const uploadStatus = container.querySelector('#uploadStatus');
    if (uploadStatus) {
      uploadStatus.innerHTML = '';
    }
    
    const fileStatus = container.querySelector('#file-status');
    if (fileStatus) {
      fileStatus.innerHTML = '';
    }
    
    const fileInputMap = {
      clinician: { xmlFileInput: 'xml', clinicianFileInput: 'clinician', statusFileInput: 'status' },
      elig: { xmlFileInput: 'xml', eligibilityFileInput: 'eligibility' },
      auths: { xmlInput: 'xml', xlsxInput: 'auth' },
      timings: { xmlFileInput: 'xml' },
      teeth: { xmlFile: 'xml' },
      schema: { xmlFile: 'xml' },
      pricing: { 'xml-file': 'xml', 'xlsx-file': 'pricing' },
      modifiers: { 'xml-file': 'xml', 'xlsx-file': 'eligibility' }
    };

    const inputMap = fileInputMap[checkerName];
    if (!inputMap) {
      console.warn(`[DEBUG] No input map found for: ${checkerName}`);
      return;
    }

    // Set files in hidden inputs within the container
    console.log(`[DEBUG] Setting files for ${checkerName}:`, inputMap);
    for (const [inputId, fileKey] of Object.entries(inputMap)) {
      const input = container.querySelector(`#${inputId}`);
      console.log(`[DEBUG] Looking for input #${inputId}, found:`, !!input, 'File key:', fileKey, 'Has file:', !!files[fileKey]);
      
      if (input && files[fileKey]) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(files[fileKey]);
        input.files = dataTransfer.files;
        console.log(`[DEBUG] Set file for #${inputId}:`, input.files[0]?.name);
        
        // Trigger change event
        const event = new Event('change', { bubbles: true });
        input.dispatchEvent(event);
      }
    }

    // Call the checker function directly (scripts are already loaded)
    // Bug #5 fix: Use function registry map instead of if-else chain
    try {
      console.log(`[DEBUG] Calling ${checkerName} checker function...`);
      
      const checkerFunctions = {
        schema: validateXmlSchema,
        timings: validateTimingsAsync,
        teeth: parseXML,
        elig: runEligCheck,
        auths: runAuthsCheck,
        clinician: runClinicianCheck,
        pricing: runPricingCheck,
        modifiers: runModifiersCheck
      };
      
      const checkerFn = checkerFunctions[checkerName];
      
      if (!checkerFn || typeof checkerFn !== 'function') {
        throw new Error(`Checker function not found for: ${checkerName}`);
      }
      
      console.log(`[DEBUG] Executing ${checkerName} checker function`);
      const tableElement = await checkerFn();  // GET the returned table
      
      // ✅ NEW: Render the returned table
      if (tableElement && resultsDiv) {
        console.log(`[DEBUG] Rendering table returned from ${checkerName}`);
        resultsDiv.appendChild(tableElement);
      } else if (!tableElement) {
        console.log(`[DEBUG] ${checkerName} returned no table (may have rendered status message instead)`);
      }
      
      // Return the table element so Check All can use it
      return tableElement;
      
    } catch (error) {
      console.error(`[DEBUG] Error executing ${checkerName}:`, error);
      throw error;
    }
  }

  function setActiveButton(checkerName) {
    const allButtons = [
      elements.btnClinician, elements.btnElig, elements.btnAuths,
      elements.btnTimings, elements.btnTeeth, elements.btnSchema,
      elements.btnPricing, elements.btnModifiers,
      elements.btnCheckAll
    ];
    
    allButtons.forEach(btn => btn && btn.classList.remove('active'));
    
    const btnName = `btn${checkerName.charAt(0).toUpperCase() + checkerName.slice(1)}`;
    const currentBtn = elements[btnName];
    if (currentBtn) {
      currentBtn.classList.add('active');
    }
  }

  /**
   * Re-attach event listeners to a cloned table for Check-All functionality
   * When tables are cloned, event listeners are lost. This function restores them.
   */
  function reattachEventListeners(clonedTable, checkerName) {
    console.log(`[CHECK-ALL] Re-attaching event listeners for ${checkerName} table`);
    
    try {
      if (checkerName === 'schema') {
        // Schema checker uses .view-claim-btn buttons with data-index
        const results = window._lastValidationResults;
        if (!results || !Array.isArray(results)) {
          console.warn('[CHECK-ALL] No validation results found for schema checker');
          return;
        }
        
        results.forEach((row, index) => {
          const btn = clonedTable.querySelector(`.view-claim-btn[data-index="${index}"]`);
          if (btn) {
            btn.onclick = () => {
              if (typeof window.showModal === 'function' && typeof window.claimToHtmlTable === 'function') {
                window.showModal(window.claimToHtmlTable(row.ClaimXML));
              } else {
                console.error('[CHECK-ALL] Modal functions not available');
              }
            };
          }
        });
        console.log(`[CHECK-ALL] Re-attached ${results.length} event listeners for schema checker`);
      } else if (checkerName === 'elig') {
        // Eligibility checker uses .eligibility-details buttons
        // Note: initEligibilityModal should be called with the results
        if (typeof window.initEligibilityModal === 'function') {
          // The eligibility modal initialization needs the results array
          // For now, we'll attach basic click handlers that use global modal functions
          const detailButtons = clonedTable.querySelectorAll('.eligibility-details');
          console.log(`[CHECK-ALL] Found ${detailButtons.length} eligibility detail buttons`);
          
          detailButtons.forEach(btn => {
            btn.onclick = function() {
              console.log('[CHECK-ALL] Eligibility detail button clicked, but full data not available in cloned table');
              alert('For detailed eligibility information, please run the Eligibility checker individually.');
            };
          });
        }
      }
      // Add more checker types as needed
    } catch (error) {
      console.error(`[CHECK-ALL] Error re-attaching event listeners for ${checkerName}:`, error);
    }
  }

  async function runAllCheckers() {
    try {
      console.log('[CHECK-ALL] Starting Check All functionality...');
      
      // Show loading overlay
      showLoadingOverlay('Running all checkers...', 'Please wait while we check all your data');
      
      // Reset debug log and invalid rows data
      debugLog = [];
      invalidRowsData = [];
      logDebug('Check All Started', { timestamp: new Date().toISOString() });
    
    // Disable Export Invalids button initially
    if (elements.exportInvalidsBtn) {
      elements.exportInvalidsBtn.disabled = true;
      updateExportInvalidsTooltip('no-tables'); // Set initial tooltip
    }
    
    // Hide debug log button initially
    if (elements.debugLogContainer) {
      elements.debugLogContainer.style.display = 'none';
    }
    
    // Log system information
    logDebug('System Information', {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screenResolution: `${screen.width}x${screen.height}`,
      viewportSize: `${window.innerWidth}x${window.innerHeight}`
    });
    
    // Log uploaded files
    logDebug('Uploaded Files', {
      xml: files.xml ? files.xml.name : 'Not uploaded',
      clinician: files.clinician ? files.clinician.name : 'Not uploaded',
      eligibility: files.eligibility ? files.eligibility.name : 'Not uploaded',
      auth: files.auth ? files.auth.name : 'Not uploaded',
      status: files.status ? files.status.name : 'Not uploaded',
      pricing: files.pricing ? files.pricing.name : 'Not uploaded'
    });
    
    // Determine which checkers are available (enabled buttons)
    const availableCheckers = [];
    const checkerButtons = {
      'clinician': elements.btnClinician,
      'elig': elements.btnElig,
      'auths': elements.btnAuths,
      'timings': elements.btnTimings,
      'teeth': elements.btnTeeth,
      'schema': elements.btnSchema,
      'pricing': elements.btnPricing,
      'modifiers': elements.btnModifiers
    };
    
    // Find all enabled checkers
    for (const [checkerName, button] of Object.entries(checkerButtons)) {
      if (button && !button.disabled) {
        availableCheckers.push(checkerName);
        logDebug(`Checker Available: ${checkerName}`, { 
          buttonEnabled: true,
          buttonExists: !!button 
        });
      } else {
        logDebug(`Checker Unavailable: ${checkerName}`, { 
          buttonEnabled: false,
          buttonExists: !!button,
          reason: !button ? 'Button element not found' : 'Button is disabled (missing required files)'
        });
      }
    }
    
    console.log('[CHECK-ALL] Available checkers:', availableCheckers);
    logDebug('Available Checkers Detected', { 
      count: availableCheckers.length,
      checkers: availableCheckers 
    });
    
    if (availableCheckers.length === 0) {
      const errorMsg = 'No checkers are available. Please upload the required files first.';
      elements.uploadStatus.innerHTML = `<div class="status-message error">${errorMsg}</div>`;
      logDebug('Check All Aborted', { reason: 'No checkers available' });
      
      // Show debug log button even if aborted
      if (elements.debugLogContainer) {
        elements.debugLogContainer.style.display = 'block';
      }
      
      // Hide loading overlay since we're done
      hideLoadingOverlay();
      return;
    }
    
    // Show progress message
    elements.uploadStatus.innerHTML = `<div class="status-message info">Running ${availableCheckers.length} checker(s): ${availableCheckers.join(', ')}... Please wait.</div>`;
    logDebug('Check All Progress Started', { 
      totalCheckers: availableCheckers.length,
      checkerList: availableCheckers.join(', ')
    });
    
    // Set Check All button as active
    setActiveButton('checkAll');
    activeChecker = 'check-all';
    
    // Reset filter when starting Check All
    // Always set to inactive state when new tables are loaded
    filterActive = false;
    if (elements.floatingFilterBtn) {
      elements.floatingFilterBtn.classList.remove('active');
    }
    console.log('[FILTER] Auto-reset: Filter set to off when running Check All');
    
    // Hide all containers and show the check-all container
    hideAllCheckerContainers();
    const checkAllContainer = document.getElementById('checker-container-check-all');
    if (checkAllContainer) {
      checkAllContainer.style.display = 'block';
      checkAllContainer.innerHTML = '<div id="results"></div>';
    }
    
    logDebug('Results Container Cleared');
    
    // Array to store all results for combined export
    const allResults = [];
    let successCount = 0;
    let errorCount = 0;
    const checkerTimings = [];
    
    // Run each available checker sequentially
    for (const checkerName of availableCheckers) {
      const checkerStartTime = performance.now();
      logDebug(`Starting Checker: ${checkerName}`, {
        checkerNumber: successCount + errorCount + 1,
        totalCheckers: availableCheckers.length,
        timestamp: new Date().toISOString()
      });
      
      try {
        console.log(`[CHECK-ALL] Running ${checkerName} checker...`);
        
        // Update loading overlay with current progress
        updateLoadingOverlay(
          `Running ${checkerName} checker...`,
          `Progress: ${successCount + errorCount + 1}/${availableCheckers.length} checkers`
        );
        
        // Update status
        if (elements.uploadStatus) {
          elements.uploadStatus.innerHTML = `<div class="status-message info">Running ${checkerName} checker (${successCount + errorCount + 1}/${availableCheckers.length})...</div>`;
        }
        
        // Create a section for this checker's results
        const sectionDiv = document.createElement('div');
        sectionDiv.id = `${checkerName}-section`;
        sectionDiv.style.marginBottom = '30px';
        
        // Add clipboard button for ALL checkers
        const clipboardButton = `<button class="btn btn-sm btn-outline-primary checker-copy-button" data-checker="${checkerName}" style="margin-left:10px;" title="Copy invalid ${checkerName.toUpperCase()} results to clipboard">📋 Copy Invalids</button>`;
        
        sectionDiv.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #0d6efd;padding-bottom:10px;margin-top:20px;">
            <h3 style="color:#0d6efd;margin:0;">
              ${checkerName.toUpperCase()} Checker Results
            </h3>
            ${clipboardButton}
          </div>
          <div id="${checkerName}-results"></div>
        `;
        if (checkAllContainer) {
          checkAllContainer.appendChild(sectionDiv);
          
          // Attach event listener to clipboard button
          const copyBtn = sectionDiv.querySelector('.checker-copy-button');
          if (copyBtn) {
            copyBtn.addEventListener('click', () => copyCheckerInvalidResults(checkerName));
            logDebug(`${checkerName} copy button event listener attached`);
          }
        }
        
        logDebug(`Created Results Section: ${checkerName}`);
        
        // Get this checker's persistent container and run it
        const checkerContainer = document.getElementById(`checker-container-${checkerName}`);
        let table = null;
        
        if (checkerContainer) {
          // IMPORTANT: Ensure checker container stays hidden during Check All
          checkerContainer.style.display = 'none';
          
          // Execute the checker and get returned table element (Bug #10 fix: removed duplicate initialization check)
          logDebug(`Executing Checker: ${checkerName}`);
          table = await executeChecker(checkerName, checkerContainer);
          
          // Re-confirm container is hidden after execution
          checkerContainer.style.display = 'none';
        }
        const checkerEndTime = performance.now();
        const executionTime = (checkerEndTime - checkerStartTime).toFixed(2);
        
        // Get section results container (needed for both success and failure cases)
        const sectionResults = document.getElementById(`${checkerName}-results`);
        
        if (table) {
          successCount++;
          const rowCount = table.querySelectorAll('tbody tr').length;
          console.log(`[CHECK-ALL] ✓ ${checkerName} checker completed successfully`);
          
          // Collect invalid rows from this table
          const invalidRows = table.querySelectorAll('tbody tr.table-danger, tbody tr.table-warning, tbody tr.invalid, tbody tr.unknown');
          if (invalidRows.length > 0) {
            console.log(`[CHECK-ALL] Found ${invalidRows.length} invalid rows in ${checkerName}`);
            invalidRows.forEach(row => {
              const rowData = {
                checker: checkerName,
                cells: []
              };
              row.querySelectorAll('td').forEach(cell => {
                rowData.cells.push(cell.textContent.trim());
              });
              invalidRowsData.push(rowData);
            });
          }
          
          // Copy table to check-all results section
          if (sectionResults && table) {
            const clonedTable = table.cloneNode(true);
            sectionResults.appendChild(clonedTable);
            
            // Re-attach event listeners that were lost during cloning
            reattachEventListeners(clonedTable, checkerName);
          }
          
          logDebug(`Checker Success: ${checkerName}`, {
            status: 'success',
            executionTimeMs: executionTime,
            rowsGenerated: rowCount,
            tableGenerated: true
          });
          
          checkerTimings.push({
            checker: checkerName,
            executionTimeMs: executionTime,
            status: 'success',
            rowCount: rowCount
          });
          
          // Store table for combined export
          allResults.push({
            checkerName: checkerName,
            table: table.cloneNode(true)
          });
        } else {
          errorCount++;
          console.log(`[CHECK-ALL] ✗ ${checkerName} checker failed to generate table`);
          if (sectionResults) {
            sectionResults.innerHTML = '<div class="alert alert-warning">No results or checker did not complete</div>';
          }
          
          logDebug(`Checker Failed: ${checkerName}`, {
            status: 'failed',
            executionTimeMs: executionTime,
            reason: 'No table generated',
            tableGenerated: false
          });
          
          checkerTimings.push({
            checker: checkerName,
            executionTimeMs: executionTime,
            status: 'failed',
            reason: 'No table generated'
          });
        }
        
      } catch (error) {
        errorCount++;
        const checkerEndTime = performance.now();
        const executionTime = (checkerEndTime - checkerStartTime).toFixed(2);
        
        console.error(`[CHECK-ALL] Error running ${checkerName}:`, error);
        const errorDiv = document.getElementById(`${checkerName}-results`);
        if (errorDiv) {
          errorDiv.innerHTML = `<div class="alert alert-danger">Error: ${error.message}</div>`;
        }
        
        logDebug(`Checker Error: ${checkerName}`, {
          status: 'error',
          executionTimeMs: executionTime,
          errorMessage: error.message,
          errorStack: error.stack,
          errorType: error.name
        });
        
        checkerTimings.push({
          checker: checkerName,
          executionTimeMs: executionTime,
          status: 'error',
          errorMessage: error.message
        });
      }
    }
    
    // Calculate total execution time
    const totalExecutionTime = checkerTimings.reduce((sum, timing) => 
      sum + parseFloat(timing.executionTimeMs), 0
    ).toFixed(2);
    
    // Show completion status
    const totalRun = successCount + errorCount;
    if (elements.uploadStatus) {
      elements.uploadStatus.innerHTML = `<div class="status-message success">Check All complete: ${successCount} successful, ${errorCount} failed out of ${totalRun} checker(s)</div>`;
    }
    
    logDebug('Check All Completed', {
      totalCheckers: totalRun,
      successCount: successCount,
      errorCount: errorCount,
      totalExecutionTimeMs: totalExecutionTime,
      timestamp: new Date().toISOString()
    });
    
    logDebug('Checker Execution Timings', checkerTimings);
    
    // Enable export button if we have results
    if (successCount > 0 && elements.exportBtn) {
      elements.exportBtn.disabled = false;
      logDebug('Export Button Enabled', { resultsCount: successCount });
    }
    
    // Enable Export Invalids button if we have invalid rows
    if (invalidRowsData.length > 0 && elements.exportInvalidsBtn) {
      elements.exportInvalidsBtn.disabled = false;
      console.log(`[CHECK-ALL] Export Invalids button enabled (${invalidRowsData.length} invalid rows from ${successCount} checkers)`);
      logDebug('Export Invalids Button Enabled', { invalidRowsCount: invalidRowsData.length });
      updateExportInvalidsTooltip(); // Remove tooltip when enabled
    } else if (elements.exportInvalidsBtn) {
      elements.exportInvalidsBtn.disabled = true;
      console.log(`[CHECK-ALL] Export Invalids button disabled (no invalid rows found)`);
      
      // Determine appropriate tooltip reason
      // Check if ANY tables were generated (even if there were some errors)
      const anyTablesGenerated = successCount > 0 || totalRun > errorCount;
      let tooltipReason;
      
      if (!anyTablesGenerated) {
        // No tables generated at all
        if (errorCount > 0) {
          tooltipReason = 'error'; // Fatal errors prevented all tables
        } else {
          tooltipReason = 'no-tables'; // No checkers ran
        }
      } else {
        // Tables were generated, but no invalids found
        tooltipReason = 'no-errors';
      }
      
      updateExportInvalidsTooltip(tooltipReason);
    }
    
    // Store results globally for export
    window._checkAllResults = allResults;
    
    logDebug('Results Stored for Export', { 
      checkersWithResults: allResults.length,
      checkerNames: allResults.map(r => r.checkerName)
    });
    
    // Show debug log download button
    if (elements.debugLogContainer) {
      elements.debugLogContainer.style.display = 'block';
      logDebug('Debug Log Button Displayed');
    }
    
    // Hide loading overlay after all checkers complete
    hideLoadingOverlay();
    
    console.log('[CHECK-ALL] ✓ Check All functionality complete');
    console.log('[CHECK-ALL] Results collected from', allResults.length, 'checkers');
    console.log('[CHECK-ALL] Debug log contains', debugLog.length, 'entries');
  } catch (error) {
    // Catch any unexpected errors to ensure loading overlay is hidden
    console.error('[CHECK-ALL] Unexpected error in runAllCheckers:', error);
    logDebug('Check All Fatal Error', {
      errorMessage: error.message,
      errorStack: error.stack
    });
    
    // Show error message to user
    if (elements.uploadStatus) {
      elements.uploadStatus.innerHTML = `<div class="status-message error">An unexpected error occurred: ${error.message}</div>`;
    }
    
    // Show debug log button so user can download the log
    if (elements.debugLogContainer) {
      elements.debugLogContainer.style.display = 'block';
    }
    
    // Always hide loading overlay on error
    hideLoadingOverlay();
  }
  }

  function updateExportInvalidsTooltip(reason = null) {
    const bubble = document.getElementById('exportInvalidsBubble');
    const bubbleText = document.getElementById('exportInvalidsBubbleText');
    
    if (!bubble || !bubbleText) {
      return;
    }
    
    // If button is enabled, hide speech bubble
    if (elements.exportInvalidsBtn && !elements.exportInvalidsBtn.disabled) {
      bubble.style.display = 'none';
      return;
    }
    
    // Button is disabled, show speech bubble with appropriate message
    let tooltipMessage = '';
    
    if (reason === 'no-tables') {
      tooltipMessage = 'No tables generated. Please run a checker first.';
    } else if (reason === 'no-errors') {
      // Get list of checkers that ran successfully but had no errors
      const checkersWithoutErrors = [];
      const checkersWithErrors = [];
      
      // Check which checkers have tables and categorize them
      const allContainers = document.querySelectorAll('[id^="checker-container-"]');
      allContainers.forEach(container => {
        const tables = container.querySelectorAll('table');
        if (tables.length > 0) {
          const invalidRows = container.querySelectorAll('tr.table-danger, tr.table-warning, tr.invalid, tr.unknown');
          const checkerMatch = container.id.match(/checker-container-(.+)/);
          if (checkerMatch) {
            const name = checkerMatch[1].toUpperCase();
            // Exclude CHECK-ALL from the list (it's a meta-container, not a real checker)
            if (name !== 'CHECK-ALL') {
              if (invalidRows.length > 0) {
                checkersWithErrors.push(name);
              } else {
                checkersWithoutErrors.push(name);
              }
            }
          }
        }
      });
      
      // If there are checkers with errors, show them
      if (checkersWithErrors.length > 0) {
        // Format the list with proper grammar: "x, y, and z"
        let checkerList = '';
        if (checkersWithErrors.length === 1) {
          checkerList = checkersWithErrors[0];
        } else if (checkersWithErrors.length === 2) {
          checkerList = checkersWithErrors.join(' and ');
        } else {
          const lastChecker = checkersWithErrors.pop();
          checkerList = checkersWithErrors.join(', ') + ', and ' + lastChecker;
        }
        tooltipMessage = `Errors found in ${checkerList} checker${checkersWithErrors.length > 1 ? 's' : ''}`;
      } else if (checkersWithoutErrors.length > 0) {
        tooltipMessage = `No errors found in all checkers`;
      } else {
        tooltipMessage = 'No invalid entries found. Please run a checker first.';
      }
    } else if (reason === 'error') {
      tooltipMessage = 'Error occurred during checker execution. Please download debug log for more details.';
    } else {
      tooltipMessage = 'No invalid entries found. Please run a checker first.';
    }
    
    // Update speech bubble text and make sure it's visible
    bubbleText.textContent = tooltipMessage;
    bubble.style.display = 'block';
  }

  function applyFilter() {
    const filterEnabled = filterActive;
    
    // Get tables from the active checker's container
    const container = document.getElementById(`checker-container-${activeChecker}`);
    if (!container) {
      console.warn('[FILTER] No active checker container found');
      return;
    }
    
    const tables = container.querySelectorAll('table');
    console.log('[FILTER] Applying filter, enabled:', filterEnabled, 'to', tables.length, 'tables');

    tables.forEach(table => {
      const rows = table.querySelectorAll('tbody tr');
      
      // Track which Claim IDs have been shown in the filtered view
      // This is used to fill the claim ID for the first invalid occurrence only
      const shownClaimIds = new Set();
      
      rows.forEach(row => {
        if (filterEnabled) {
          // Check for invalid/error indicators based on CSS classes only
          // CSS classes are set by the checker logic based on whether remarks exist
          // 1. Bootstrap danger class (red rows - has remarks/errors)
          // 2. Bootstrap warning class (yellow rows - warnings)
          // 3. Old 'invalid' or 'unknown' class (backward compatibility for other checkers)
          const hasInvalid = row.classList.contains('table-danger') ||
                            row.classList.contains('table-warning') ||
                            row.classList.contains('invalid') ||
                            row.classList.contains('unknown');
          
          if (hasInvalid) {
            // Show all invalid rows
            row.style.display = '';
            
            // Get the Claim ID from this row (if it has one)
            const claimId = row.getAttribute('data-claim-id');
            
            if (claimId && !shownClaimIds.has(claimId)) {
              // First invalid occurrence of this Claim ID - ensure it's displayed
              shownClaimIds.add(claimId);
              
              const claimIdCell = row.querySelector('.claim-id-cell');
              if (claimIdCell && claimIdCell.textContent.trim() === '') {
                claimIdCell.textContent = claimId;
                claimIdCell.style.color = '#666';
                claimIdCell.style.fontStyle = 'italic';
              }
            }
            // Subsequent invalid rows with the same Claim ID keep their blank cells
          } else {
            row.style.display = 'none';
          }
        } else {
          row.style.display = '';
        }
      });
    });

    console.log('[FILTER] Filter applied to', tables.length, 'tables');
  }

  function exportResults() {
    // Check if this is a Check All export
    if (activeChecker === 'check-all' && window._checkAllResults && window._checkAllResults.length > 0) {
      console.log('[EXPORT] Exporting Check All results from', window._checkAllResults.length, 'checkers');
      
      const wb = XLSX.utils.book_new();
      
      window._checkAllResults.forEach((result, index) => {
        const ws = XLSX.utils.table_to_sheet(result.table);
        // Limit sheet name to 31 characters (Excel limit)
        const sheetName = result.checkerName.substring(0, 31);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
      });
      
      const filename = `check-all_results_${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(wb, filename);
      console.log('[EXPORT] ✓ Check All export complete:', filename);
      return;
    }
    
    // Regular single checker export - get tables from active checker's container
    const container = document.getElementById(`checker-container-${activeChecker}`);
    if (!container) {
      alert('No active checker container found');
      return;
    }
    
    const tables = container.querySelectorAll('table');
    if (tables.length === 0) {
      alert('No results to export');
      return;
    }

    const wb = XLSX.utils.book_new();
    tables.forEach((table, index) => {
      const ws = XLSX.utils.table_to_sheet(table);
      const sheetName = activeChecker ? activeChecker.substring(0, 31) : `Sheet${index + 1}`;
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    const filename = `${activeChecker || 'checker'}_results_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    console.log('[EXPORT] ✓ Single checker export complete:', filename);
  }
  
  /**
   * Export only invalid rows to Excel with unified headers
   * Redesigned to scan all tables and create unified export
   */
  function exportInvalids() {
    console.log('[EXPORT-INVALIDS] Starting unified export of invalid rows...');
    
    // Step 1: Collect all tables from all containers
    const allTables = [];
    
    // Scan all checker containers
    const checkerContainers = document.querySelectorAll('[id^="checker-container-"]');
    checkerContainers.forEach(container => {
      const tables = container.querySelectorAll('table');
      tables.forEach(table => {
        // Extract checker name - prioritize from parent section, fallback to container ID
        let checkerName = container.id.replace('checker-container-', '');
        
        // If in check-all container, find the actual checker from parent section
        if (checkerName === 'check-all') {
          const parentSection = table.closest('[id$="-section"]');
          if (parentSection) {
            checkerName = parentSection.id.replace('-section', '');
          }
        }
        
        allTables.push({ table, checkerName });
      });
    });
    
    console.log(`[EXPORT-INVALIDS] Found ${allTables.length} table(s) across all containers`);
    
    if (allTables.length === 0) {
      alert('No tables found. Please run a checker or Check All first.');
      return;
    }
    
    // Step 2: Extract and merge headers from all tables
    const allHeadersSet = new Set();
    const tableHeadersMap = new Map(); // Store headers for each table
    
    allTables.forEach(({ table, checkerName }) => {
      const headers = [];
      table.querySelectorAll('thead th').forEach(th => {
        const headerText = th.textContent.trim();
        if (headerText) {
          headers.push(headerText);
          allHeadersSet.add(headerText);
        }
      });
      tableHeadersMap.set(table, { headers, checkerName });
      console.log(`[EXPORT-INVALIDS] Extracted ${headers.length} header(s) from ${checkerName} table`);
    });
    
    // Remove unwanted columns and merge similar ones
    const columnsToRemove = ['View Full Entry', 'Valid'];
    columnsToRemove.forEach(col => allHeadersSet.delete(col));
    
    // Handle Remark/Remarks merge - keep only "Remarks"
    if (allHeadersSet.has('Remark') || allHeadersSet.has('Remarks')) {
      allHeadersSet.delete('Remark');
      allHeadersSet.add('Remarks');
    }
    
    // Convert Set to sorted Array for consistent column order
    const unifiedHeaders = Array.from(allHeadersSet).sort();
    console.log(`[EXPORT-INVALIDS] Unified headers (${unifiedHeaders.length} total):`, unifiedHeaders);
    
    // Step 3: Collect invalid rows from all tables
    const invalidRows = [];
    let totalInvalidCount = 0;
    
    allTables.forEach(({ table, checkerName }) => {
      const tableInfo = tableHeadersMap.get(table);
      const tableHeaders = tableInfo.headers;
      
      // Find all invalid rows
      const invalidRowElements = table.querySelectorAll('tbody tr.table-danger, tbody tr.table-warning, tbody tr.invalid, tbody tr.unknown');
      
      if (invalidRowElements.length > 0) {
        console.log(`[EXPORT-INVALIDS] Found ${invalidRowElements.length} invalid row(s) in ${checkerName}`);
        totalInvalidCount += invalidRowElements.length;
        
        invalidRowElements.forEach(rowElement => {
          const cells = [];
          rowElement.querySelectorAll('td').forEach(td => {
            cells.push(td.textContent.trim());
          });
          
          // Extract Claim ID from data attribute first, fallback to first cell
          let claimId = rowElement.getAttribute('data-claim-id');
          
          if (!claimId || claimId === '') {
            // Fallback to first cell if data attribute not present
            claimId = cells.length > 0 ? cells[0] : 'Unknown';
          }
          
          // Ensure first cell has the Claim ID for export consistency
          if (cells.length > 0 && (!cells[0] || cells[0] === '')) {
            cells[0] = claimId;
          }
          
          invalidRows.push({
            checkerName,
            claimId,
            cells,
            originalHeaders: tableHeaders
          });
        });
      }
    });
    
    console.log(`[EXPORT-INVALIDS] Total invalid rows collected: ${totalInvalidCount}`);
    
    if (invalidRows.length === 0) {
      alert('No invalid entries found in any tables.');
      return;
    }
    
    // Step 4: Map rows to unified headers
    const exportData = [];
    
    invalidRows.forEach(row => {
      const rowObj = {};
      
      // Add Checker Source as first column
      rowObj['Checker Source'] = row.checkerName.toUpperCase();
      
      // Map each cell to its header
      unifiedHeaders.forEach(header => {
        let headerIndex = row.originalHeaders.indexOf(header);
        let value = '';
        
        // Handle merged Remark/Remarks columns
        if (header === 'Remarks') {
          const remarksIndex = row.originalHeaders.indexOf('Remarks');
          const remarkIndex = row.originalHeaders.indexOf('Remark');
          
          // Prioritize 'Remarks' if not blank, otherwise use 'Remark'
          if (remarksIndex >= 0 && remarksIndex < row.cells.length) {
            value = row.cells[remarksIndex];
          }
          if ((!value || value === '') && remarkIndex >= 0 && remarkIndex < row.cells.length) {
            value = row.cells[remarkIndex];
          }
        } else {
          // Normal header mapping, skip removed columns
          if (headerIndex >= 0 && headerIndex < row.cells.length) {
            value = row.cells[headerIndex];
          }
        }
        
        rowObj[header] = value;
      });
      
      exportData.push(rowObj);
    });
    
    console.log(`[EXPORT-INVALIDS] Export data prepared: ${exportData.length} row(s)`);
    
    // Step 5: Export to Excel
    const wb = XLSX.utils.book_new();
    
    // Ensure 'Checker Source' is the first column, followed by sorted unified headers
    const finalHeaders = ['Checker Source', ...unifiedHeaders];
    const ws = XLSX.utils.json_to_sheet(exportData, { header: finalHeaders });
    
    XLSX.utils.book_append_sheet(wb, ws, 'Invalid Entries');
    
    const filename = `invalid_entries_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    
    console.log('[EXPORT-INVALIDS] ✓ Invalid entries export complete:', filename);
    console.log(`[EXPORT-INVALIDS] Exported ${exportData.length} invalid row(s) with ${finalHeaders.length} column(s)`);
  }

  /**
   * Download comprehensive debug log as text file
   */
  function downloadDebugLog() {
    console.log('[DEBUG-LOG] downloadDebugLog() function called');
    console.log('[DEBUG-LOG] Debug log array length:', debugLog ? debugLog.length : 'undefined');
    console.log('[DEBUG-LOG] Debug log contents:', debugLog);
    
    if (!debugLog || debugLog.length === 0) {
      console.error('[DEBUG-LOG] Debug log is empty or undefined');
      alert('No debug log available. Please run Check All first.');
      return;
    }
    
    console.log('[DEBUG-LOG] Preparing debug log download...');
    
    try {
      // Build debug log text content
      const logLines = [];
      
      // Header
      logLines.push('='.repeat(80));
      logLines.push('UNIFIED CHECKER TOOL - DEBUG LOG');
      logLines.push('='.repeat(80));
      logLines.push('');
      logLines.push(`Generated: ${new Date().toISOString()}`);
      logLines.push(`Total Log Entries: ${debugLog.length}`);
      logLines.push('');
      logLines.push('='.repeat(80));
      logLines.push('');
      
      // Log entries
      debugLog.forEach((entry, index) => {
        logLines.push(`[${index + 1}] ${entry.timestamp}`);
        logLines.push(`Message: ${entry.message}`);
        
        if (entry.data) {
          logLines.push('Data:');
          try {
            const dataStr = JSON.stringify(entry.data, null, 2);
            // Indent each line of data
            dataStr.split('\n').forEach(line => {
              logLines.push(`  ${line}`);
            });
          } catch (e) {
            logLines.push(`  [Error serializing data: ${e.message}]`);
          }
        }
        
        logLines.push('-'.repeat(80));
        logLines.push('');
      });
      
      // Footer
      logLines.push('='.repeat(80));
      logLines.push('END OF DEBUG LOG');
      logLines.push('='.repeat(80));
      
      console.log('[DEBUG-LOG] Generated log text, length:', logLines.join('\n').length);
      
      // Create blob and download
      const logText = logLines.join('\n');
      const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      
      const filename = `check-all_debug_log_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
      
      // Create temporary link and click it
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      
      console.log('[DEBUG-LOG] Triggering download for:', filename);
      a.click();
      
      // Clean up
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log('[DEBUG-LOG] ✓ Download triggered and cleaned up');
      }, 100);
      
      logDebug('Debug Log Downloaded', { 
        filename: filename,
        entriesCount: debugLog.length,
        logSizeBytes: logText.length
      });
    } catch (error) {
      console.error('[DEBUG-LOG] Error during download:', error);
      alert(`Error downloading debug log: ${error.message}`);
    }
  }
  
  /**
   * Copy checker invalid results to clipboard in specified format
   * Format: CLAIM_ID\t\tRemark
   * Only copies invalid/unknown rows (table-danger or table-warning)
   * @param {string} checkerName - The name of the checker (e.g., 'elig', 'auths', 'pricing')
   */
  function copyCheckerInvalidResults(checkerName) {
    console.log(`[CLIPBOARD] Copying ${checkerName.toUpperCase()} checker invalid results...`);
    
    const button = document.querySelector(`.checker-copy-button[data-checker="${checkerName}"]`);
    
    // Helper function to show button feedback (uses textContent for security)
    const showButtonFeedback = (message, backgroundColor, duration = CLIPBOARD_FEEDBACK_DURATION_MS) => {
      if (!button) return;
      const originalText = button.textContent;
      button.textContent = message;
      button.style.backgroundColor = backgroundColor;
      button.style.color = 'white';
      
      setTimeout(() => {
        button.textContent = originalText;
        button.style.backgroundColor = '';
        button.style.color = '';
      }, duration);
    };
    
    // Find the checker results section
    const checkerSection = document.getElementById(`${checkerName}-results`);
    if (!checkerSection) {
      console.error(`[CLIPBOARD] ${checkerName} results section not found`);
      showButtonFeedback('⚠ Section Not Found', '#dc3545');
      return;
    }
    
    // Find the table in the checker section
    const table = checkerSection.querySelector('table');
    if (!table) {
      console.error(`[CLIPBOARD] ${checkerName} results table not found`);
      showButtonFeedback('⚠ Table Not Found', '#dc3545');
      return;
    }
    
    // Extract data from INVALID rows only (table-danger or table-warning)
    const invalidRows = table.querySelectorAll(INVALID_ROW_CLASSES);
    if (invalidRows.length === 0) {
      console.log(`[CLIPBOARD] No invalid rows found in ${checkerName}`);
      showButtonFeedback('⚠ No Invalids', '#ffc107');
      return;
    }
    
    // Use a Map to deduplicate: key = "ClaimID\t\tRemark", value = true
    const uniqueResults = new Map();
    
    // Determine the correct column offset based on checker
    // Timings checker has Remarks as the LAST column (no Details after it)
    // All other checkers have Remarks as second-to-last (Details/Compare is last)
    const remarksOffset = checkerName === 'timings' 
      ? REMARKS_COLUMN_OFFSET_TIMINGS 
      : REMARKS_COLUMN_OFFSET_DEFAULT;
    
    invalidRows.forEach(row => {
      // Get all cells in the row
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) return; // Skip if not enough cells
      
      // First cell is Claim ID (index 0)
      const claimID = cells[0].textContent.trim();
      
      // Skip empty claim IDs (can happen with merged/hidden cells in tables where
      // the Claim ID is visually hidden for consecutive activities of the same claim)
      if (!claimID) return;
      
      // Find the Remarks column using the appropriate offset for this checker
      // Table structure varies by checker:
      // - Most checkers: Claim ID, ..., Remarks, Details (remarksOffset = 2)
      // - Timings: Claim ID, ..., Excess, Remarks (remarksOffset = 1, Remarks is last)
      const remarksCell = cells[cells.length - remarksOffset];
      
      if (!remarksCell) return;
      
      // Get all remark divs from the cell
      const remarkDivs = remarksCell.querySelectorAll('div');
      
      // Only include rows that have remarks (not "No remarks")
      if (remarkDivs.length > 0) {
        remarkDivs.forEach(div => {
          const remarkText = div.textContent.trim();
          // Skip "No remarks" entries and source notes
          if (remarkText && remarkText !== 'No remarks' && !div.classList.contains('source-note')) {
            // Format: CLAIM_ID\t\tRemark - use as Map key to deduplicate
            const entry = `${claimID}\t\t${remarkText}`;
            uniqueResults.set(entry, true);
          }
        });
      } else {
        // If no divs, try getting text content directly (some checkers may use plain text)
        const remarkText = remarksCell.textContent.trim();
        if (remarkText && remarkText !== 'No remarks' && remarkText !== '') {
          const entry = `${claimID}\t\t${remarkText}`;
          uniqueResults.set(entry, true);
        }
      }
    });
    
    // Convert Map keys to array
    const results = Array.from(uniqueResults.keys());
    
    if (results.length === 0) {
      console.log(`[CLIPBOARD] Invalid rows found in ${checkerName} but no remarks to copy`);
      showButtonFeedback('⚠ No Remarks', '#ffc107');
      return;
    }
    
    // Join all results with newlines
    const textToCopy = results.join('\n');
    
    // Copy to clipboard
    navigator.clipboard.writeText(textToCopy).then(() => {
      console.log(`[CLIPBOARD] ✓ Copied ${results.length} invalid ${checkerName.toUpperCase()} results`);
      showButtonFeedback(`✓ Copied ${results.length}!`, '#198754');
    }).catch(err => {
      console.error(`[CLIPBOARD] Copy failed for ${checkerName}:`, err);
      // Use a safe, fixed error message instead of potentially unsafe error content
      const safeErrorMsg = err.name === 'NotAllowedError' 
        ? 'Permission denied' 
        : err.name === 'SecurityError'
        ? 'Security error'
        : 'Check console for details';
      showButtonFeedback(`❌ Copy Failed: ${safeErrorMsg}`, '#dc3545', CLIPBOARD_FEEDBACK_DURATION_MS * ERROR_FEEDBACK_DURATION_EXTENSION_FACTOR);
    });
  }
  
  // Bug #7 fix: Auto-table generation system removed (obsolete with persistent containers)
  // Bug #8 fix: Dead code in checkForExistingTable removed (lines after early return)

})();
