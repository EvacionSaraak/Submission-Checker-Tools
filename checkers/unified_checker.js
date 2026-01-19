// unified_checker.js - Unified controller for all checkers
// Refactored: Checkers return tables; rendering handled centrally

(function() {
  'use strict';

  // Initialize session counter immediately
  (function initSessionCounter() {
    let sessionCount = sessionStorage.getItem('checkerSessionCount');
    sessionCount = sessionCount ? parseInt(sessionCount) + 1 : 1;
    sessionStorage.setItem('checkerSessionCount', sessionCount);
    console.log(`[INIT] Unified Checker v1.0.0 - Session #${sessionCount}`);
    
    // Update DOM when ready
    document.addEventListener('DOMContentLoaded', () => {
      const sessionElement = document.getElementById('sessionCount');
      if (sessionElement) {
        sessionElement.textContent = `| Session #${sessionCount}`;
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
    if (elements.xmlInput) {
      elements.xmlInput.addEventListener('change', (e) => handleFileChange(e, 'xml', elements.xmlStatus));
    }
    if (elements.clinicianInput) {
      elements.clinicianInput.addEventListener('change', (e) => handleFileChange(e, 'clinician', elements.clinicianStatus));
    }
    if (elements.eligibilityInput) {
      elements.eligibilityInput.addEventListener('change', (e) => handleFileChange(e, 'eligibility', elements.eligibilityStatus));
    }
    if (elements.authInput) {
      elements.authInput.addEventListener('change', (e) => handleFileChange(e, 'auth', elements.authStatus));
    }
    if (elements.statusInput) {
      elements.statusInput.addEventListener('change', (e) => handleFileChange(e, 'status', elements.statusStatus));
    }
    if (elements.pricingInput) {
      elements.pricingInput.addEventListener('change', (e) => handleFileChange(e, 'pricing', elements.pricingStatus));
    }

    // Checker button event listeners
    elements.btnTimings.addEventListener('click', () => runChecker('timings'));
    elements.btnTeeth.addEventListener('click', () => runChecker('teeth'));
    elements.btnSchema.addEventListener('click', () => runChecker('schema'));
    elements.btnClinician.addEventListener('click', () => runChecker('clinician'));
    elements.btnElig.addEventListener('click', () => runChecker('elig'));
    elements.btnAuths.addEventListener('click', () => runChecker('auths'));
    elements.btnPricing.addEventListener('click', () => runChecker('pricing'));
    elements.btnModifiers.addEventListener('click', () => runChecker('modifiers'));
    elements.btnCheckAll.addEventListener('click', runAllCheckers);

    // Filter button - make it toggleable
    elements.floatingFilterBtn.addEventListener('click', () => {
      filterActive = !filterActive;
      elements.floatingFilterBtn.classList.toggle('active', filterActive);
      applyFilter();
    });

    // Export button
    elements.exportBtn.addEventListener('click', exportResults);
    
    // Export Invalids button
    if (elements.exportInvalidsBtn) {
      elements.exportInvalidsBtn.addEventListener('click', exportInvalids);
      console.log('[INIT] Export Invalids button found, attached event listener');
      // Set initial tooltip for disabled button
      updateExportInvalidsTooltip('no-tables');
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
    console.log('[BUTTON] Updating button states based on available files...');
    
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
      if (button) {
        const hasAll = reqs.every(req => files[req] !== null);
        button.disabled = !hasAll;
        
        const missingFiles = reqs.filter(req => !files[req]);
        if (hasAll) {
          console.log(`[BUTTON] ${checker}: ENABLED (has all required: ${reqs.join(', ')})`);
        } else {
          console.log(`[BUTTON] ${checker}: DISABLED (missing: ${missingFiles.join(', ')})`);
        }
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
    
    try {
      elements.uploadStatus.innerHTML = `<div class="status-message info">Running ${checkerName} checker...</div>`;
      
      setActiveButton(checkerName);
      activeChecker = checkerName;

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

    } catch (error) {
      console.error('[DEBUG] Error running checker:', error);
      console.error(error.stack);
      elements.uploadStatus.innerHTML = `<div class="status-message error">Error: ${error.message}</div>`;
      const container = document.getElementById(`checker-container-${checkerName}`);
      if (container) {
        container.innerHTML = `<div class="alert alert-danger" role="alert"><strong>Error:</strong> ${error.message}</div>`;
      }
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
      timings: `
        <div id="typeSelector" style="display:none;">
          <label><input type="radio" name="claimType" value="DENTAL" checked> Dental</label>
          <label><input type="radio" name="claimType" value="MEDICAL"> Medical</label>
        </div>
        <input type="file" id="xmlFileInput" accept=".xml" style="display:none" />
        <button id="exportBtn" class="btn btn-secondary" style="display:none;">Export Invalid Entries</button>
        <div id="resultsSummary" style="margin:10px;font-weight:bold;"></div>
        <div id="results"></div>
      `,
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

    container.innerHTML = interfaces[checkerName] || '<div id="results"></div>';
  }

  function syncClaimType(container) {
    // Get the global claim type selection
    const globalDental = document.getElementById('claimTypeDental');
    const globalMedical = document.getElementById('claimTypeMedical');
    
    if (!globalDental || !globalMedical) return;
    
    const selectedType = globalDental.checked ? 'DENTAL' : 'MEDICAL';
    
    // Set the hidden radio buttons in the timings checker to match
    const timingsRadios = container.querySelectorAll('input[name="claimType"]');
    timingsRadios.forEach(radio => {
      radio.checked = (radio.value === selectedType);
    });
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

  async function runAllCheckers() {
    console.log('[CHECK-ALL] Starting Check All functionality...');
    
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
        
        // Update status
        if (elements.uploadStatus) {
          elements.uploadStatus.innerHTML = `<div class="status-message info">Running ${checkerName} checker (${successCount + errorCount + 1}/${availableCheckers.length})...</div>`;
        }
        
        // Create a section for this checker's results
        const sectionDiv = document.createElement('div');
        sectionDiv.id = `${checkerName}-section`;
        sectionDiv.style.marginBottom = '30px';
        sectionDiv.innerHTML = `
          <h3 style="color:#0d6efd;border-bottom:2px solid #0d6efd;padding-bottom:10px;margin-top:20px;">
            ${checkerName.toUpperCase()} Checker Results
          </h3>
          <div id="${checkerName}-results"></div>
        `;
        if (checkAllContainer) {
          checkAllContainer.appendChild(sectionDiv);
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
            sectionResults.appendChild(table.cloneNode(true));
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
    
    console.log('[CHECK-ALL] ✓ Check All functionality complete');
    console.log('[CHECK-ALL] Results collected from', allResults.length, 'checkers');
    console.log('[CHECK-ALL] Debug log contains', debugLog.length, 'entries');
  }

  function updateExportInvalidsTooltip(reason = null) {
    if (!elements.exportInvalidsBtn) return;
    
    const bubble = document.getElementById('exportInvalidsBubble');
    const bubbleText = document.getElementById('exportInvalidsBubbleText');
    
    if (!bubble || !bubbleText) return;
    
    if (!elements.exportInvalidsBtn.disabled) {
      // Button is enabled, hide speech bubble
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
      
      // Check which checkers have tables but no invalid rows
      const allContainers = document.querySelectorAll('[id^="checker-container-"]');
      allContainers.forEach(container => {
        const tables = container.querySelectorAll('table');
        if (tables.length > 0) {
          const invalidRows = container.querySelectorAll('tr.table-danger, tr.table-warning, tr.invalid, tr.unknown');
          if (invalidRows.length === 0) {
            const checkerMatch = container.id.match(/checker-container-(.+)/);
            if (checkerMatch) {
              const name = checkerMatch[1].toUpperCase();
              checkersWithoutErrors.push(name);
            }
          }
        }
      });
      
      if (checkersWithoutErrors.length > 0) {
        tooltipMessage = `No errors found in the following checker(s): ${checkersWithoutErrors.join(', ')}`;
      } else {
        tooltipMessage = 'No invalid entries found. Please run a checker first.';
      }
    } else if (reason === 'error') {
      tooltipMessage = 'Error occurred during checker execution. Please download debug log for more details.';
    } else {
      tooltipMessage = 'No invalid entries found. Please run a checker first.';
    }
    
    // Update speech bubble text and show it
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
      
      // Track which Claim IDs have already been shown in this table
      // This prevents showing the same Claim ID multiple times in filtered view
      const shownClaimIds = new Set();
      
      rows.forEach(row => {
        if (filterEnabled) {
          // Check for invalid/error indicators:
          // 1. Bootstrap danger class (red rows)
          // 2. Bootstrap warning class (yellow rows - unknown/warning states)
          // 3. Old 'invalid' or 'unknown' class (backward compatibility)
          // 4. Text contains "invalid", "error", "warning", or "unknown"
          const hasInvalid = row.classList.contains('table-danger') ||
                            row.classList.contains('table-warning') ||
                            row.classList.contains('invalid') ||
                            row.classList.contains('unknown') ||
                            row.innerHTML.toLowerCase().includes('invalid') ||
                            row.innerHTML.toLowerCase().includes('error') ||
                            row.innerHTML.toLowerCase().includes('warning') ||
                            row.innerHTML.toLowerCase().includes('unknown') ||
                            row.innerHTML.includes('❌');
          
          if (hasInvalid) {
            // Get the Claim ID from this row (if it has one)
            const claimId = row.getAttribute('data-claim-id');
            
            if (claimId && shownClaimIds.has(claimId)) {
              // This Claim ID is already shown in the filtered results, hide this duplicate
              row.style.display = 'none';
              console.log('[FILTER] Hiding duplicate Claim ID:', claimId);
            } else {
              // Show this row and track its Claim ID
              row.style.display = '';
              if (claimId) {
                shownClaimIds.add(claimId);
              }
            }
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
   */
  function exportInvalids() {
    console.log('[EXPORT-INVALIDS] Exporting invalid rows...');
    console.log('[EXPORT-INVALIDS] Total invalid rows:', invalidRowsData.length);
    
    if (!invalidRowsData || invalidRowsData.length === 0) {
      alert('No invalid entries found. Please run a checker or Check All first.');
      return;
    }
    
    // Group invalid rows by checker to get their headers
    const checkerGroups = {};
    invalidRowsData.forEach(row => {
      if (!checkerGroups[row.checker]) {
        checkerGroups[row.checker] = [];
      }
      checkerGroups[row.checker].push(row);
    });
    
    console.log('[EXPORT-INVALIDS] Checkers with invalids:', Object.keys(checkerGroups));
    
    // Collect all unique headers from all checkers
    const allHeaders = new Set();
    const checkerHeaders = {};
    
    // Get headers from the actual tables in DOM
    Object.keys(checkerGroups).forEach(checkerName => {
      let table = null;
      
      // Try to find the table in the checker's container or check-all container
      const checkerContainer = document.getElementById(`checker-container-${checkerName}`);
      const checkAllContainer = document.getElementById('checker-container-check-all');
      
      if (checkerContainer) {
        table = checkerContainer.querySelector('table');
      }
      
      if (!table && checkAllContainer) {
        // Try to find this checker's table in Check All results
        const tables = checkAllContainer.querySelectorAll('table');
        tables.forEach(t => {
          const caption = t.querySelector('caption');
          if (caption && caption.textContent.toLowerCase().includes(checkerName.toLowerCase())) {
            table = t;
          }
        });
      }
      
      if (table) {
        const headers = [];
        table.querySelectorAll('thead th').forEach(th => {
          const headerText = th.textContent.trim();
          headers.push(headerText);
          allHeaders.add(headerText);
        });
        checkerHeaders[checkerName] = headers;
        console.log(`[EXPORT-INVALIDS] Headers for ${checkerName}:`, headers);
      } else {
        console.warn(`[EXPORT-INVALIDS] Could not find table for ${checkerName}`);
      }
    });
    
    // Convert Set to Array and sort for consistent column order
    const unifiedHeaders = Array.from(allHeaders).sort();
    console.log('[EXPORT-INVALIDS] Unified headers:', unifiedHeaders);
    
    // Build data rows with unified headers
    const exportData = [];
    
    invalidRowsData.forEach(row => {
      const rowObj = {};
      const checkerHeadersArr = checkerHeaders[row.checker] || [];
      
      // Map each cell to its header, filling in blanks for missing columns
      unifiedHeaders.forEach(header => {
        const headerIndex = checkerHeadersArr.indexOf(header);
        if (headerIndex >= 0 && headerIndex < row.cells.length) {
          rowObj[header] = row.cells[headerIndex];
        } else {
          rowObj[header] = ''; // Blank cell for headers not in this checker
        }
      });
      
      // Add checker source as first column
      rowObj['Checker Source'] = row.checker.toUpperCase();
      
      exportData.push(rowObj);
    });
    
    console.log('[EXPORT-INVALIDS] Export data prepared:', exportData.length, 'rows');
    
    // Create workbook with unified invalid rows
    const wb = XLSX.utils.book_new();
    
    // Ensure 'Checker Source' is the first column
    const finalHeaders = ['Checker Source', ...unifiedHeaders];
    const ws = XLSX.utils.json_to_sheet(exportData, { header: finalHeaders });
    
    XLSX.utils.book_append_sheet(wb, ws, 'Invalid Entries');
    
    const filename = `invalid_entries_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    console.log('[EXPORT-INVALIDS] ✓ Invalid entries export complete:', filename);
    console.log('[EXPORT-INVALIDS] Exported', invalidRowsData.length, 'invalid rows with', finalHeaders.length, 'columns');
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
  
  // Bug #7 fix: Auto-table generation system removed (obsolete with persistent containers)
  // Bug #8 fix: Dead code in checkForExistingTable removed (lines after early return)

})();
