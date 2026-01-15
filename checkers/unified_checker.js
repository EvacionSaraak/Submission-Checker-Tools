// unified_checker.js - Simplified controller that works with existing checker scripts

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
  
  // Auto-table generation state
  let autoTableGeneration = {
    enabled: false,
    attemptCount: 0,
    maxAttempts: 5,
    intervalId: null,
    retryDelayMs: 3000
  };

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

    // Debug log download button
    if (elements.downloadDebugLogBtn) {
      elements.downloadDebugLogBtn.addEventListener('click', downloadDebugLog);
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
    
    // Trigger auto-table generation on file change
    startAutoTableGeneration();
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

      console.log(`[DEBUG] Creating ${checkerName} interface...`);
      // Create minimal checker interface
      createCheckerInterface(checkerName);

      // Sync global claim type with timings checker if applicable
      if (checkerName === 'timings') {
        console.log('[DEBUG] Syncing claim type for timings');
        syncClaimType();
      }

      // Load and run the checker script
      console.log(`[DEBUG] Loading and executing ${checkerName} checker...`);
      await loadAndExecuteChecker(checkerName);

      elements.uploadStatus.innerHTML = ''; // Clear status message
      if (elements.exportBtn) {
        elements.exportBtn.disabled = false;
      }
      console.log(`[DEBUG] ${checkerName} checker completed successfully`);

      // Apply filter if button is active (works on already-rendered tables)
      if (filterActive) {
        setTimeout(() => applyFilter(), 100); // Small delay to ensure table is fully rendered
      }
      
      // Stop auto-generation after manual run to prevent duplicate processing
      stopAutoTableGeneration();

    } catch (error) {
      console.error('[DEBUG] Error running checker:', error);
      console.error(error.stack);
      elements.uploadStatus.innerHTML = `<div class="status-message error">Error: ${error.message}</div>`;
      elements.resultsContainer.innerHTML = `<div class="alert alert-danger" role="alert"><strong>Error:</strong> ${error.message}</div>`;
    }
  }

  function createCheckerInterface(checkerName) {
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

    elements.resultsContainer.innerHTML = interfaces[checkerName] || '<div id="results"></div>';
  }

  function syncClaimType() {
    // Get the global claim type selection
    const globalDental = document.getElementById('claimTypeDental');
    const globalMedical = document.getElementById('claimTypeMedical');
    
    if (!globalDental || !globalMedical) return;
    
    const selectedType = globalDental.checked ? 'DENTAL' : 'MEDICAL';
    
    // Set the hidden radio buttons in the timings checker to match
    const timingsRadios = elements.resultsContainer.querySelectorAll('input[name="claimType"]');
    timingsRadios.forEach(radio => {
      radio.checked = (radio.value === selectedType);
    });
  }

  async function loadAndExecuteChecker(checkerName) {
    const fileMap = {
      clinician: 'clinician',
      elig: 'elig',
      auths: 'auths',
      timings: 'timings',
      teeth: 'tooths',
      schema: 'schema',
      pricing: 'pricing',
      modifiers: 'modifiers'
    };

    const scriptName = `checker_${fileMap[checkerName]}.js`;

    // Remove any existing checker script
    const existing = document.getElementById('dynamic-checker-script');
    if (existing) {
      existing.remove();
    }

    // Load the checker script
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.id = 'dynamic-checker-script';
      script.src = scriptName;
      script.onload = () => {
        // After script loads, set files and trigger processing
        setTimeout(async () => {
          await setFilesAndTrigger(checkerName);
          resolve();
        }, 500);
      };
      script.onerror = () => reject(new Error(`Failed to load ${scriptName}`));
      document.body.appendChild(script);
    });
  }

  async function setFilesAndTrigger(checkerName) {
    console.log(`[DEBUG] setFilesAndTrigger called for: ${checkerName}`);
    
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

    // Set files in hidden inputs
    console.log(`[DEBUG] Setting files for ${checkerName}:`, inputMap);
    for (const [inputId, fileKey] of Object.entries(inputMap)) {
      const input = elements.resultsContainer.querySelector(`#${inputId}`);
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

    // For checkers that auto-process on file change, manually call their processing functions
    // since DOMContentLoaded has already fired
    setTimeout(async () => {
      try {
        console.log(`[DEBUG] Attempting to trigger ${checkerName} processing...`);
        
        if (checkerName === 'schema' && typeof validateXmlSchema === 'function') {
          console.log('[DEBUG] Calling validateXmlSchema()');
          validateXmlSchema();
        } else if (checkerName === 'timings' && typeof validateTimingsAsync === 'function') {
          console.log('[DEBUG] Calling validateTimingsAsync()');
          await validateTimingsAsync();
        } else if (checkerName === 'teeth') {
          console.log('[DEBUG] Processing teeth checker');
          if (typeof parseXML === 'function') {
            console.log('[DEBUG] Calling parseXML() for teeth');
            parseXML();
          } else {
            console.error('[DEBUG] parseXML function not found for teeth checker');
          }
        } else if (checkerName === 'clinician') {
          if (typeof runClinicianCheck === 'function') {
            console.log('[DEBUG] Calling runClinicianCheck()');
            await runClinicianCheck();
            console.log('[DEBUG] runClinicianCheck() completed');
          } else {
            console.error('[DEBUG] runClinicianCheck function not found');
          }
        } else if (checkerName === 'elig') {
          console.log('[DEBUG] Processing elig checker');
          if (typeof runEligCheck === 'function') {
            console.log('[DEBUG] Calling runEligCheck()');
            await runEligCheck();
            console.log('[DEBUG] runEligCheck() completed');
          } else {
            console.error('[DEBUG] runEligCheck function not found');
          }
        } else if (checkerName === 'auths') {
          console.log('[DEBUG] Processing auths checker');
          if (typeof runAuthsCheck === 'function') {
            console.log('[DEBUG] Calling runAuthsCheck()');
            await runAuthsCheck();
            console.log('[DEBUG] runAuthsCheck() completed');
          } else {
            console.error('[DEBUG] runAuthsCheck function not found');
          }
        } else if (checkerName === 'pricing') {
          if (typeof runPricingCheck === 'function') {
            console.log('[DEBUG] Calling runPricingCheck()');
            await runPricingCheck();
            console.log('[DEBUG] runPricingCheck() completed');
          } else {
            console.error('[DEBUG] runPricingCheck function not found');
          }
        } else if (checkerName === 'modifiers') {
          if (typeof runModifiersCheck === 'function') {
            console.log('[DEBUG] Calling runModifiersCheck()');
            await runModifiersCheck();
            console.log('[DEBUG] runModifiersCheck() completed');
          } else {
            console.error('[DEBUG] runModifiersCheck function not found');
          }
        } else {
          console.warn(`[DEBUG] No trigger function found for ${checkerName}`);
        }
      } catch (error) {
        console.error(`[DEBUG] Error triggering ${checkerName}:`, error);
        console.error(error.stack);
      }
    }, 500); // Fixed: increased delay from 200ms to 500ms for consistency
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
    
    // Reset debug log
    debugLog = [];
    logDebug('Check All Started', { timestamp: new Date().toISOString() });
    
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
    
    // Clear previous results
    elements.resultsContainer.innerHTML = '<div id="results"></div>';
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
        elements.uploadStatus.innerHTML = `<div class="status-message info">Running ${checkerName} checker (${successCount + errorCount + 1}/${availableCheckers.length})...</div>`;
        
        // Create a section for this checker's results
        const sectionDiv = document.createElement('div');
        sectionDiv.id = `${checkerName}-section`;
        sectionDiv.style.marginBottom = '30px';
        sectionDiv.innerHTML = `<h3 style="color:#0d6efd;border-bottom:2px solid #0d6efd;padding-bottom:10px;margin-top:20px;">${checkerName.toUpperCase()} Checker Results</h3><div id="${checkerName}-results"></div>`;
        elements.resultsContainer.appendChild(sectionDiv);
        
        logDebug(`Created Results Section: ${checkerName}`);
        
        // Temporarily override resultsContainer to point to this section
        const originalContainer = elements.resultsContainer;
        const sectionResults = document.getElementById(`${checkerName}-results`);
        
        // Load and execute the checker
        logDebug(`Loading Checker Script: ${checkerName}`);
        await loadAndExecuteChecker(checkerName, sectionResults);
        logDebug(`Checker Script Loaded: ${checkerName}`);
        
        // Wait a moment for table to render
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Check if table was generated
        const table = sectionResults.querySelector('table');
        const checkerEndTime = performance.now();
        const executionTime = (checkerEndTime - checkerStartTime).toFixed(2);
        
        if (table) {
          successCount++;
          const rowCount = table.querySelectorAll('tbody tr').length;
          console.log(`[CHECK-ALL] ✓ ${checkerName} checker completed successfully`);
          
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
          sectionResults.innerHTML = '<div class="alert alert-warning">No results or checker did not complete</div>';
          
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
    elements.uploadStatus.innerHTML = `<div class="status-message success">Check All complete: ${successCount} successful, ${errorCount} failed out of ${totalRun} checker(s)</div>`;
    
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
  
  /**
   * Modified loadAndExecuteChecker to accept custom results container
   */
  async function loadAndExecuteCheckerOriginal(checkerName, customResultsDiv) {
    return loadAndExecuteChecker(checkerName, customResultsDiv);
  }

  function applyFilter() {
    const filterEnabled = filterActive;
    const tables = elements.resultsContainer.querySelectorAll('table');

    console.log('[FILTER] Applying filter, enabled:', filterEnabled);

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
    
    // Regular single checker export
    const tables = elements.resultsContainer.querySelectorAll('table');
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
   * Start auto-table generation monitoring
   * Triggered when:
   * 1. File is uploaded
   * 2. Checker button is clicked
   */
  function startAutoTableGeneration() {
    console.log('[AUTO-TABLE] Starting auto-table generation monitoring...');
    
    // Reset state
    stopAutoTableGeneration();
    autoTableGeneration.attemptCount = 0;
    autoTableGeneration.enabled = true;
    
    // Immediate first attempt
    attemptTableGeneration();
    
    // Start interval for retry attempts
    autoTableGeneration.intervalId = setInterval(() => {
      attemptTableGeneration();
    }, autoTableGeneration.retryDelayMs);
  }
  
  /**
   * Stop auto-table generation monitoring
   */
  function stopAutoTableGeneration() {
    if (autoTableGeneration.intervalId) {
      clearInterval(autoTableGeneration.intervalId);
      autoTableGeneration.intervalId = null;
      console.log('[AUTO-TABLE] Stopped monitoring');
    }
    autoTableGeneration.enabled = false;
  }
  
  /**
   * Attempt to generate table for active checker
   */
  async function attemptTableGeneration() {
    autoTableGeneration.attemptCount++;
    
    console.log(`[AUTO-TABLE] Attempt ${autoTableGeneration.attemptCount}/${autoTableGeneration.maxAttempts}`);
    
    // Check if we've exceeded max attempts
    if (autoTableGeneration.attemptCount > autoTableGeneration.maxAttempts) {
      console.log('[AUTO-TABLE] Max attempts reached, stopping...');
      stopAutoTableGeneration();
      return;
    }
    
    // Check if there's an active checker
    if (!activeChecker) {
      console.log('[AUTO-TABLE] No active checker, skipping generation');
      return;
    }
    
    // Check if table already exists
    const existingTable = checkForExistingTable();
    if (existingTable) {
      console.log('[AUTO-TABLE] Table already exists, stopping monitoring');
      stopAutoTableGeneration();
      return;
    }
    
    // Check if required files are available for active checker
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
    
    const requiredFiles = requirements[activeChecker];
    if (!requiredFiles) {
      console.log(`[AUTO-TABLE] Unknown checker: ${activeChecker}`);
      stopAutoTableGeneration();
      return;
    }
    
    const hasAllFiles = requiredFiles.every(req => files[req] !== null);
    if (!hasAllFiles) {
      const missingFiles = requiredFiles.filter(req => !files[req]);
      console.log(`[AUTO-TABLE] Missing required files: ${missingFiles.join(', ')}`);
      return;
    }
    
    // Attempt to run the checker directly without triggering runChecker to avoid recursion
    console.log(`[AUTO-TABLE] Generating table for ${activeChecker} checker...`);
    
    try {
      // Temporarily stop monitoring to prevent recursion
      const wasEnabled = autoTableGeneration.enabled;
      stopAutoTableGeneration();
      
      // Execute checker function directly
      await loadAndExecuteChecker(activeChecker);
      
      console.log('[AUTO-TABLE] Table generation completed');
      
      // Check if table was generated, if not and we were enabled, restart monitoring
      if (wasEnabled && !checkForExistingTable()) {
        autoTableGeneration.enabled = true;
        autoTableGeneration.intervalId = setInterval(() => {
          attemptTableGeneration();
        }, autoTableGeneration.retryDelayMs);
      }
    } catch (err) {
      console.error('[AUTO-TABLE] Error during table generation:', err);
    }
  }
  
  /**
   * Check if a table already exists in the results container or any iframes
   * Returns true if table exists, false otherwise
   */
  function checkForExistingTable() {
    // Check main results container for any tables (including nested)
    if (elements.resultsContainer) {
      const allTables = elements.resultsContainer.querySelectorAll('table');
      if (allTables && allTables.length > 0) {
        console.log(`[AUTO-TABLE] Found ${allTables.length} table(s) in main container`);
        return true;
      }
    }
    
    // Also check the #results div specifically (used by most checkers)
    const resultsDiv = document.getElementById('results');
    if (resultsDiv) {
      const resultsTables = resultsDiv.querySelectorAll('table');
      if (resultsTables && resultsTables.length > 0) {
        console.log(`[AUTO-TABLE] Found ${resultsTables.length} table(s) in #results div`);
        return true;
      }
    }
    
    // Check #outputTableContainer (used by pricing/modifiers)
    const outputContainer = document.getElementById('outputTableContainer');
    if (outputContainer) {
      const outputTables = outputContainer.querySelectorAll('table');
      if (outputTables && outputTables.length > 0) {
        console.log(`[AUTO-TABLE] Found ${outputTables.length} table(s) in #outputTableContainer`);
        return true;
      }
    }
    
    // Check for tables in any iframes
    const iframes = document.querySelectorAll('iframe');
    for (let iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        const iframeTables = iframeDoc && iframeDoc.querySelectorAll('table');
        if (iframeTables && iframeTables.length > 0) {
          console.log(`[AUTO-TABLE] Found ${iframeTables.length} table(s) in iframe`);
          return true;
        }
      } catch (e) {
        // Cross-origin iframe, can't access
        console.log('[AUTO-TABLE] Cannot access iframe (cross-origin)');
      }
    }
    
    return false;
  }

})();
