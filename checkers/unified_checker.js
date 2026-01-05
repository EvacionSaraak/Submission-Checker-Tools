// unified_checker.js - Simplified controller that works with existing checker scripts

(function() {
  'use strict';

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
  function saveFileInfo(key, fileName) {
    try {
      localStorage.setItem(`checker_file_${key}`, fileName);
    } catch (e) {
      console.error('Failed to save to localStorage:', e);
    }
  }

  function loadFileInfo(key) {
    try {
      return localStorage.getItem(`checker_file_${key}`);
    } catch (e) {
      console.error('Failed to load from localStorage:', e);
      return null;
    }
  }

  function clearFileInfo(key) {
    try {
      localStorage.removeItem(`checker_file_${key}`);
    } catch (e) {
      console.error('Failed to clear from localStorage:', e);
    }
  }

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

    // File input event listeners
    elements.xmlInput.addEventListener('change', (e) => handleFileChange(e, 'xml', elements.xmlStatus));
    elements.clinicianInput.addEventListener('change', (e) => handleFileChange(e, 'clinician', elements.clinicianStatus));
    elements.eligibilityInput.addEventListener('change', (e) => handleFileChange(e, 'eligibility', elements.eligibilityStatus));
    elements.authInput.addEventListener('change', (e) => handleFileChange(e, 'auth', elements.authStatus));
    elements.statusInput.addEventListener('change', (e) => handleFileChange(e, 'status', elements.statusStatus));
    elements.pricingInput.addEventListener('change', (e) => handleFileChange(e, 'pricing', elements.pricingStatus));

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

    // Restore file information from localStorage
    restoreFileStates();

    updateButtonStates();
  }

  function restoreFileStates() {
    const fileKeys = ['xml', 'clinician', 'eligibility', 'auth', 'status', 'pricing'];
    const statusElements = {
      xml: elements.xmlStatus,
      clinician: elements.clinicianStatus,
      eligibility: elements.eligibilityStatus,
      auth: elements.authStatus,
      status: elements.statusStatus,
      pricing: elements.pricingStatus
    };

    fileKeys.forEach(key => {
      const fileName = loadFileInfo(key);
      if (fileName) {
        statusElements[key].textContent = `✓ ${fileName}`;
        statusElements[key].style.color = 'green';
        // Note: We can't restore actual File objects, but we show the filename
        // User will need to re-upload if they want to process again
      }
    });
  }

  function handleFileChange(event, fileKey, statusElement) {
    const file = event.target.files[0];
    if (file) {
      files[fileKey] = file;
      statusElement.textContent = `✓ ${file.name}`;
      statusElement.style.color = '#0f5132';
      statusElement.style.backgroundColor = '#d1e7dd';
      statusElement.style.fontWeight = 'bold';
      
      // Save to localStorage
      saveFileInfo(fileKey, file.name);
    } else {
      files[fileKey] = null;
      statusElement.textContent = '';
      statusElement.style.backgroundColor = '';
      
      // Clear from localStorage
      clearFileInfo(fileKey);
    }
    updateButtonStates();
  }

  function updateButtonStates() {
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
        button.disabled = !reqs.every(req => files[req] !== null);
      }
    }

    if (elements.btnCheckAll) {
      elements.btnCheckAll.disabled = !files.xml;
    }
  }

  async function runChecker(checkerName) {
    try {
      elements.uploadStatus.innerHTML = `<div class="status-message info">Running ${checkerName} checker...</div>`;
      
      setActiveButton(checkerName);
      activeChecker = checkerName;

      // Create minimal checker interface
      createCheckerInterface(checkerName);

      // Sync global claim type with timings checker if applicable
      if (checkerName === 'timings') {
        syncClaimType();
      }

      // Load and run the checker script
      await loadAndExecuteChecker(checkerName);

      elements.uploadStatus.innerHTML = `<div class="status-message success">${checkerName.charAt(0).toUpperCase() + checkerName.slice(1)} checker ready.</div>`;
      elements.exportBtn.disabled = false;

    } catch (error) {
      console.error('Error running checker:', error);
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
        <input type="file" id="xmlFileInput" accept=".xml" style="display:none" />
        <input type="file" id="eligibilityFileInput" accept=".xlsx" style="display:none" />
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
        <div id="results-container"></div>
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
        setTimeout(() => {
          setFilesAndTrigger(checkerName);
          resolve();
        }, 500);
      };
      script.onerror = () => reject(new Error(`Failed to load ${scriptName}`));
      document.body.appendChild(script);
    });
  }

  function setFilesAndTrigger(checkerName) {
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
    if (!inputMap) return;

    // Set files in hidden inputs
    for (const [inputId, fileKey] of Object.entries(inputMap)) {
      const input = elements.resultsContainer.querySelector(`#${inputId}`);
      if (input && files[fileKey]) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(files[fileKey]);
        input.files = dataTransfer.files;
        
        // Trigger change event
        const event = new Event('change', { bubbles: true });
        input.dispatchEvent(event);
      }
    }

    // For checkers that auto-process on file change, manually call their processing functions
    // since DOMContentLoaded has already fired
    setTimeout(() => {
      try {
        if (checkerName === 'schema' && typeof validateXmlSchema === 'function') {
          validateXmlSchema();
        } else if (checkerName === 'timings' && typeof onFileChange === 'function') {
          const xmlInput = elements.resultsContainer.querySelector('#xmlFileInput');
          if (xmlInput && xmlInput.files.length > 0) {
            onFileChange({ target: xmlInput });
          }
        } else if (checkerName === 'teeth' && typeof parseXML === 'function') {
          // Teeth checker has parseXML function
          parseXML();
        } else if (checkerName === 'clinician') {
          // Clinician checker: set up event listeners and call validateClinicians
          if (typeof validateClinicians === 'function') {
            // Manually set up required elements if they exist globally
            const setupGlobals = () => {
              window.xmlInput = elements.resultsContainer.querySelector('#xmlFileInput');
              window.clinicianInput = elements.resultsContainer.querySelector('#clinicianFileInput');
              window.statusInput = elements.resultsContainer.querySelector('#statusFileInput');
              window.processBtn = elements.resultsContainer.querySelector('#processBtn');
              window.csvBtn = elements.resultsContainer.querySelector('#csvBtn');
              window.resultsDiv = elements.resultsContainer.querySelector('#results');
              window.uploadDiv = elements.resultsContainer.querySelector('#uploadStatus');
            };
            setupGlobals();
            validateClinicians();
          }
        } else if (checkerName === 'elig') {
          // Elig checker needs to initialize first then process
          if (typeof initializeEventListeners === 'function') {
            // Set up global elements first
            window.xmlInput = elements.resultsContainer.querySelector('#xmlFileInput');
            window.reportInput = elements.resultsContainer.querySelector('#reportFileInput');
            window.eligInput = elements.resultsContainer.querySelector('#eligibilityFileInput');
            window.processBtn = elements.resultsContainer.querySelector('#processBtn');
            window.exportInvalidBtn = elements.resultsContainer.querySelector('#exportInvalidBtn');
            window.resultsDiv = elements.resultsContainer.querySelector('#results');
            window.statusDiv = elements.resultsContainer.querySelector('#status');
            
            initializeEventListeners();
            setTimeout(() => {
              const processBtn = elements.resultsContainer.querySelector('#processBtn');
              if (processBtn) processBtn.click();
            }, 100);
          }
        } else if (checkerName === 'auths' && typeof handleRun === 'function') {
          // Auth checker has handleRun function
          handleRun();
        } else if (checkerName === 'pricing' && typeof handleRun === 'function') {
          // Pricing checker has handleRun function
          handleRun();
        } else if (checkerName === 'modifiers' && typeof handleRun === 'function') {
          // Modifiers checker has handleRun function
          handleRun();
        }
      } catch (error) {
        console.error(`Error triggering ${checkerName}:`, error);
      }
    }, 200);
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

    tables.forEach(table => {
      const rows = table.querySelectorAll('tbody tr');
      rows.forEach(row => {
        if (filterEnabled) {
          const hasInvalid = row.classList.contains('invalid') ||
                            row.innerHTML.toLowerCase().includes('invalid') ||
                            row.innerHTML.toLowerCase().includes('error');
          row.style.display = hasInvalid ? '' : 'none';
        } else {
          row.style.display = '';
        }
      });
    });
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
