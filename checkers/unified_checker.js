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

  let activeChecker = null;

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
      filterInvalid: document.getElementById('filterInvalid'),
      
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

    // Filter checkbox
    elements.filterInvalid.addEventListener('change', applyFilter);

    // Export button
    elements.exportBtn.addEventListener('click', exportResults);

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

      // Apply filter if checkbox is checked (works on already-rendered tables)
      if (elements.filterInvalid.checked) {
        setTimeout(() => applyFilter(), 100); // Small delay to ensure table is fully rendered
      }

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
    elements.uploadStatus.innerHTML = '<div class="status-message info">Check All functionality is experimental and coming soon!</div>';
  }

  function applyFilter() {
    const filterEnabled = elements.filterInvalid.checked;
    const tables = elements.resultsContainer.querySelectorAll('table');

    console.log('[FILTER] Applying filter, enabled:', filterEnabled);

    tables.forEach(table => {
      const rows = table.querySelectorAll('tbody tr');
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
          row.style.display = hasInvalid ? '' : 'none';
        } else {
          row.style.display = '';
        }
      });
    });

    console.log('[FILTER] Filter applied to', tables.length, 'tables');
  }

  function exportResults() {
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
  }

})();
