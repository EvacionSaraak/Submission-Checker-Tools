// unified_checker.js - Simple no-iframe controller

(function() {
  'use strict';

  // File storage
  const files = {
    xml: null,
    clinician: null,
    eligibility: null,
    auth: null,
    status: null,
    pricing: null,
    drugs: null
  };

  let activeChecker = null;
  let currentResults = null;

  // DOM elements
  let elements = {};

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    elements = {
      // File inputs
      xmlInput: document.getElementById('xmlFileInput'),
      clinicianInput: document.getElementById('clinicianFileInput'),
      eligibilityInput: document.getElementById('eligibilityFileInput'),
      authInput: document.getElementById('authFileInput'),
      statusInput: document.getElementById('statusFileInput'),
      pricingInput: document.getElementById('pricingFileInput'),
      drugsInput: document.getElementById('drugsFileInput'),
      
      // Status spans
      xmlStatus: document.getElementById('xmlStatus'),
      clinicianStatus: document.getElementById('clinicianStatus'),
      eligibilityStatus: document.getElementById('eligibilityStatus'),
      authStatus: document.getElementById('authStatus'),
      statusStatus: document.getElementById('statusStatus'),
      pricingStatus: document.getElementById('pricingStatus'),
      drugsStatus: document.getElementById('drugsStatus'),
      
      // Buttons
      btnClinician: document.getElementById('btn-clinician'),
      btnElig: document.getElementById('btn-elig'),
      btnAuths: document.getElementById('btn-auths'),
      btnTimings: document.getElementById('btn-timings'),
      btnTeeth: document.getElementById('btn-teeth'),
      btnSchema: document.getElementById('btn-schema'),
      btnPricing: document.getElementById('btn-pricing'),
      btnDrugs: document.getElementById('btn-drugs'),
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
    elements.drugsInput.addEventListener('change', (e) => handleFileChange(e, 'drugs', elements.drugsStatus));

    // Checker button event listeners
    elements.btnTimings.addEventListener('click', () => runChecker('timings'));
    elements.btnTeeth.addEventListener('click', () => runChecker('teeth'));
    elements.btnSchema.addEventListener('click', () => runChecker('schema'));
    elements.btnClinician.addEventListener('click', () => runChecker('clinician'));
    elements.btnElig.addEventListener('click', () => runChecker('elig'));
    elements.btnAuths.addEventListener('click', () => runChecker('auths'));
    elements.btnPricing.addEventListener('click', () => runChecker('pricing'));
    elements.btnDrugs.addEventListener('click', () => runChecker('drugs'));
    elements.btnModifiers.addEventListener('click', () => runChecker('modifiers'));
    elements.btnCheckAll.addEventListener('click', runAllCheckers);

    // Filter checkbox
    elements.filterInvalid.addEventListener('change', applyFilter);

    // Export button
    elements.exportBtn.addEventListener('click', exportResults);

    updateButtonStates();
  }

  function handleFileChange(event, fileKey, statusElement) {
    const file = event.target.files[0];
    if (file) {
      files[fileKey] = file;
      statusElement.textContent = `✓ ${file.name}`;
      statusElement.style.color = 'green';
      statusElement.style.fontWeight = 'bold';
    } else {
      files[fileKey] = null;
      statusElement.textContent = '';
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
      drugs: ['xml', 'drugs'],
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
      elements.uploadStatus.textContent = `Running ${checkerName} checker...`;
      elements.uploadStatus.style.color = '#0074D9';
      
      setActiveButton(checkerName);
      activeChecker = checkerName;

      // Clear previous results
      elements.resultsContainer.innerHTML = '<div style="padding: 20px; text-align: center;">Processing...</div>';

      // Load the checker HTML content
      const response = await fetch(`checker_${getCheckerFileName(checkerName)}.html`);
      if (!response.ok) {
        throw new Error(`Failed to load checker: ${response.status}`);
      }
      
      const html = await response.text();
      
      // Parse HTML to extract body content
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      
      // Get the body content and inject it
      const content = doc.body.innerHTML;
      elements.resultsContainer.innerHTML = content;

      // Load the checker script dynamically
      await loadScript(`checker_${getCheckerFileName(checkerName)}.js`);

      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 500));

      // Set files programmatically
      setFilesInPage(checkerName);

      // Wait a bit more for file handlers to process
      await new Promise(resolve => setTimeout(resolve, 500));

      // Trigger processing if there's a button
      triggerProcessing(checkerName);

      elements.uploadStatus.textContent = `${checkerName} checker completed.`;
      elements.uploadStatus.style.color = 'green';
      elements.exportBtn.disabled = false;

    } catch (error) {
      console.error('Error running checker:', error);
      elements.uploadStatus.textContent = `Error: ${error.message}`;
      elements.uploadStatus.style.color = 'red';
      elements.resultsContainer.innerHTML = `<div style="color: red; padding: 20px;">Error: ${error.message}</div>`;
    }
  }

  function getCheckerFileName(checkerName) {
    const fileMap = {
      clinician: 'clinician',
      elig: 'elig',
      auths: 'auths',
      timings: 'timings',
      teeth: 'tooths',
      schema: 'schema',
      pricing: 'pricing',
      drugs: 'drugquantities',
      modifiers: 'modifiers'
    };
    return fileMap[checkerName] || checkerName;
  }

  async function loadScript(scriptName) {
    return new Promise((resolve, reject) => {
      // Remove any existing dynamic script
      const existing = document.getElementById('dynamic-checker-script');
      if (existing) {
        existing.remove();
      }

      const script = document.createElement('script');
      script.id = 'dynamic-checker-script';
      script.src = scriptName;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load ${scriptName}`));
      document.body.appendChild(script);
    });
  }

  function setFilesInPage(checkerName) {
    const fileInputMap = {
      clinician: { xmlFileInput: 'xml', clinicianFileInput: 'clinician', statusFileInput: 'status' },
      elig: { xmlFileInput: 'xml', eligibilityFileInput: 'eligibility' },
      auths: { xmlInput: 'xml', xlsxInput: 'auth' },
      timings: { xmlFileInput: 'xml' },
      teeth: { xmlFile: 'xml' },
      schema: { xmlFile: 'xml' },
      pricing: { 'xml-file': 'xml', 'xlsx-file': 'pricing' },
      drugs: { xmlFile: 'xml', xlsxFile: 'drugs' },
      modifiers: { 'xml-file': 'xml', 'xlsx-file': 'eligibility' }
    };

    const inputMap = fileInputMap[checkerName];
    if (!inputMap) return;

    for (const [inputId, fileKey] of Object.entries(inputMap)) {
      const input = elements.resultsContainer.querySelector(`#${inputId}`);
      if (input && files[fileKey]) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(files[fileKey]);
        input.files = dataTransfer.files;
        
        const event = new Event('change', { bubbles: true });
        input.dispatchEvent(event);
      }
    }
  }

  function triggerProcessing(checkerName) {
    const buttonSelectors = {
      clinician: '#processBtn',
      elig: '#processBtn',
      auths: '#processBtn',
      pricing: '#run-button',
      drugs: '#processBtn',
      modifiers: '#run-button'
    };

    const selector = buttonSelectors[checkerName];
    if (selector) {
      setTimeout(() => {
        const button = elements.resultsContainer.querySelector(selector);
        if (button && !button.disabled) {
          button.click();
        }
      }, 100);
    }
  }

  function setActiveButton(checkerName) {
    const allButtons = [
      elements.btnClinician, elements.btnElig, elements.btnAuths,
      elements.btnTimings, elements.btnTeeth, elements.btnSchema,
      elements.btnPricing, elements.btnDrugs, elements.btnModifiers,
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
    try {
      elements.uploadStatus.textContent = 'Running all available checkers...';
      elements.uploadStatus.style.color = '#0074D9';
      setActiveButton('checkAll');

      const checkers = ['timings', 'teeth', 'schema'];
      if (files.clinician && files.status) checkers.push('clinician');
      if (files.eligibility) checkers.push('elig');
      if (files.auth) checkers.push('auths');
      if (files.pricing) checkers.push('pricing');
      if (files.drugs) checkers.push('drugs');
      if (files.eligibility) checkers.push('modifiers');

      let allResultsHTML = '<h3>Combined Results from All Checkers</h3>';

      for (const checker of checkers) {
        elements.uploadStatus.textContent = `Running ${checker}...`;
        
        // This is a simplified version - for a full implementation,
        // we would need to run each checker and collect results
        allResultsHTML += `<div class="checker-section">
          <h4>${checker.charAt(0).toUpperCase() + checker.slice(1)} Checker</h4>
          <p>Processing ${checker}... (Full implementation pending)</p>
        </div><hr>`;
      }

      elements.resultsContainer.innerHTML = allResultsHTML;
      elements.uploadStatus.textContent = 'All checkers completed (experimental mode).';
      elements.uploadStatus.style.color = 'green';

    } catch (error) {
      elements.uploadStatus.textContent = `Error: ${error.message}`;
      elements.uploadStatus.style.color = 'red';
    }
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
