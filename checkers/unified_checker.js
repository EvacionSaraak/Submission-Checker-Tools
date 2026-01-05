// unified_checker.js - Controller for unified checker interface

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

  // Current active checker
  let activeChecker = null;
  let lastResults = [];
  let filterInvalidOnly = false;

  // DOM elements
  let elements = {};

  // Initialize on DOM load
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    // Get all DOM elements
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

    // Attach event listeners for file inputs
    elements.xmlInput.addEventListener('change', (e) => handleFileChange(e, 'xml', elements.xmlStatus));
    elements.clinicianInput.addEventListener('change', (e) => handleFileChange(e, 'clinician', elements.clinicianStatus));
    elements.eligibilityInput.addEventListener('change', (e) => handleFileChange(e, 'eligibility', elements.eligibilityStatus));
    elements.authInput.addEventListener('change', (e) => handleFileChange(e, 'auth', elements.authStatus));
    elements.statusInput.addEventListener('change', (e) => handleFileChange(e, 'status', elements.statusStatus));
    elements.pricingInput.addEventListener('change', (e) => handleFileChange(e, 'pricing', elements.pricingStatus));
    elements.drugsInput.addEventListener('change', (e) => handleFileChange(e, 'drugs', elements.drugsStatus));

    // Attach event listeners for checker buttons
    elements.btnClinician.addEventListener('click', () => runChecker('clinician'));
    elements.btnElig.addEventListener('click', () => runChecker('elig'));
    elements.btnAuths.addEventListener('click', () => runChecker('auths'));
    elements.btnTimings.addEventListener('click', () => runChecker('timings'));
    elements.btnTeeth.addEventListener('click', () => runChecker('teeth'));
    elements.btnSchema.addEventListener('click', () => runChecker('schema'));
    elements.btnPricing.addEventListener('click', () => runChecker('pricing'));
    elements.btnDrugs.addEventListener('click', () => runChecker('drugs'));
    elements.btnModifiers.addEventListener('click', () => runChecker('modifiers'));
    elements.btnCheckAll.addEventListener('click', runAllCheckers);

    // Filter checkbox
    elements.filterInvalid.addEventListener('change', (e) => {
      filterInvalidOnly = e.target.checked;
      applyFilter();
    });

    // Export button
    elements.exportBtn.addEventListener('click', exportResults);

    // Initial button state update
    updateButtonStates();
  }

  function handleFileChange(event, fileKey, statusElement) {
    const file = event.target.files[0];
    if (file) {
      files[fileKey] = file;
      statusElement.textContent = `✓ ${file.name}`;
      statusElement.style.color = 'green';
    } else {
      files[fileKey] = null;
      statusElement.textContent = '';
    }
    updateButtonStates();
  }

  function updateButtonStates() {
    // Define requirements for each checker
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

    // Update each button
    for (const [checker, reqs] of Object.entries(requirements)) {
      const button = elements[`btn${checker.charAt(0).toUpperCase() + checker.slice(1)}`];
      if (button) {
        const allFilesPresent = reqs.every(req => files[req] !== null);
        button.disabled = !allFilesPresent;
      }
    }

    // Check All button - requires at least XML
    elements.btnCheckAll.disabled = !files.xml;
  }

  async function runChecker(checkerName) {
    try {
      // Clear previous results
      elements.resultsContainer.innerHTML = '<p>Processing...</p>';
      elements.uploadStatus.textContent = `Running ${checkerName} checker...`;
      elements.uploadStatus.style.color = '#0074D9';
      
      // Set active button
      setActiveButton(checkerName);
      activeChecker = checkerName;

      // Load checker in hidden iframe and run it
      const results = await loadAndRunChecker(checkerName);
      
      // Display results
      displayResults(results, checkerName);
      
      elements.uploadStatus.textContent = `${checkerName} checker completed.`;
      elements.exportBtn.disabled = false;
      
    } catch (error) {
      elements.uploadStatus.textContent = `Error running ${checkerName} checker: ${error.message}`;
      elements.uploadStatus.style.color = 'red';
      elements.resultsContainer.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
    }
  }

  async function loadAndRunChecker(checkerName) {
    // Create a hidden iframe
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.id = `checker-iframe-${checkerName}`;
    document.body.appendChild(iframe);

    // Map checker names to their HTML files
    const checkerFiles = {
      clinician: 'checker_clinician.html',
      elig: 'checker_elig.html',
      auths: 'checker_auths.html',
      timings: 'checker_timings.html',
      teeth: 'checker_tooths.html',
      schema: 'checker_schema.html',
      pricing: 'checker_pricing.html',
      drugs: 'checker_drugquantities.html',
      modifiers: 'checker_modifiers.html'
    };

    return new Promise((resolve, reject) => {
      iframe.onload = async () => {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          
          // Wait a bit for scripts to initialize
          await new Promise(res => setTimeout(res, 500));
          
          // Set the files in the iframe
          await setFilesInIframe(iframeDoc, checkerName);
          
          // Trigger processing
          await triggerProcessing(iframeDoc, checkerName);
          
          // Wait for results
          await new Promise(res => setTimeout(res, 1000));
          
          // Extract results
          const results = extractResults(iframeDoc, checkerName);
          
          // Clean up
          document.body.removeChild(iframe);
          
          resolve(results);
        } catch (error) {
          document.body.removeChild(iframe);
          reject(error);
        }
      };

      iframe.onerror = () => {
        document.body.removeChild(iframe);
        reject(new Error(`Failed to load ${checkerFiles[checkerName]}`));
      };

      iframe.src = checkerFiles[checkerName];
    });
  }

  async function setFilesInIframe(iframeDoc, checkerName) {
    // This function sets the files in the iframe's file inputs
    // The specific inputs depend on the checker
    
    const fileInputMap = {
      clinician: {
        xmlFileInput: 'xml',
        clinicianFileInput: 'clinician',
        statusFileInput: 'status'
      },
      elig: {
        xmlFileInput: 'xml',
        eligibilityFileInput: 'eligibility'
      },
      auths: {
        xmlInput: 'xml',
        xlsxInput: 'auth'
      },
      timings: {
        xmlFileInput: 'xml'
      },
      teeth: {
        xmlFile: 'xml'
      },
      schema: {
        xmlFile: 'xml'
      },
      pricing: {
        'xml-file': 'xml',
        'xlsx-file': 'pricing'
      },
      drugs: {
        xmlFile: 'xml',
        xlsxFile: 'drugs'
      },
      modifiers: {
        'xml-file': 'xml',
        'xlsx-file': 'eligibility'
      }
    };

    const inputMap = fileInputMap[checkerName];
    if (!inputMap) {
      throw new Error(`Unknown checker: ${checkerName}`);
    }

    for (const [inputId, fileKey] of Object.entries(inputMap)) {
      const input = iframeDoc.getElementById(inputId);
      if (input && files[fileKey]) {
        // Create a new DataTransfer object to set files
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(files[fileKey]);
        input.files = dataTransfer.files;
        
        // Trigger change event
        const event = new Event('change', { bubbles: true });
        input.dispatchEvent(event);
      }
    }
  }

  async function triggerProcessing(iframeDoc, checkerName) {
    // Find and click the process button
    const buttonSelectors = {
      clinician: '#processBtn',
      elig: '#processBtn',
      auths: '#processBtn',
      timings: null, // Auto-processes on file upload
      teeth: null, // Auto-processes on file upload
      schema: null, // Auto-processes on file upload
      pricing: '#run-button',
      drugs: '#processBtn',
      modifiers: '#run-button'
    };

    const selector = buttonSelectors[checkerName];
    if (selector) {
      const button = iframeDoc.querySelector(selector);
      if (button && !button.disabled) {
        button.click();
      }
    }
  }

  function extractResults(iframeDoc, checkerName) {
    // Extract the results from the iframe
    const resultsDiv = iframeDoc.getElementById('results') || 
                      iframeDoc.getElementById('results-container') ||
                      iframeDoc.getElementById('outputTableContainer');
    
    if (resultsDiv) {
      return {
        html: resultsDiv.innerHTML,
        text: resultsDiv.textContent,
        checker: checkerName
      };
    }
    
    return {
      html: '<p>No results found</p>',
      text: 'No results found',
      checker: checkerName
    };
  }

  function displayResults(results, checkerName) {
    elements.resultsContainer.innerHTML = `
      <h3>${checkerName.charAt(0).toUpperCase() + checkerName.slice(1)} Checker Results</h3>
      ${results.html}
    `;
    
    lastResults = [results];
    applyFilter();
  }

  function setActiveButton(checkerName) {
    // Remove active class from all buttons
    const buttons = [
      elements.btnClinician, elements.btnElig, elements.btnAuths,
      elements.btnTimings, elements.btnTeeth, elements.btnSchema,
      elements.btnPricing, elements.btnDrugs, elements.btnModifiers,
      elements.btnCheckAll
    ];
    
    buttons.forEach(btn => {
      if (btn) btn.classList.remove('active');
    });
    
    // Add active class to current button
    const currentBtn = elements[`btn${checkerName.charAt(0).toUpperCase() + checkerName.slice(1)}`];
    if (currentBtn) {
      currentBtn.classList.add('active');
    }
  }

  async function runAllCheckers() {
    try {
      elements.resultsContainer.innerHTML = '<p>Running all available checkers...</p>';
      elements.uploadStatus.textContent = 'Running all checkers...';
      elements.uploadStatus.style.color = '#0074D9';
      
      setActiveButton('checkAll');
      
      const checkers = ['timings', 'teeth', 'schema'];
      
      // Add optional checkers if files are available
      if (files.clinician && files.status) checkers.push('clinician');
      if (files.eligibility) checkers.push('elig');
      if (files.auth) checkers.push('auths');
      if (files.pricing) checkers.push('pricing');
      if (files.drugs) checkers.push('drugs');
      if (files.eligibility) checkers.push('modifiers');
      
      const allResults = [];
      
      for (const checker of checkers) {
        elements.uploadStatus.textContent = `Running ${checker} checker...`;
        const results = await loadAndRunChecker(checker);
        allResults.push(results);
      }
      
      // Display unified results
      displayUnifiedResults(allResults);
      
      elements.uploadStatus.textContent = 'All checkers completed.';
      elements.exportBtn.disabled = false;
      
    } catch (error) {
      elements.uploadStatus.textContent = `Error running checkers: ${error.message}`;
      elements.uploadStatus.style.color = 'red';
      elements.resultsContainer.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
    }
  }

  function displayUnifiedResults(allResults) {
    let html = '<h3>Unified Checker Results (All Checkers)</h3>';
    
    for (const result of allResults) {
      html += `
        <div class="checker-result-section">
          <h4>${result.checker.charAt(0).toUpperCase() + result.checker.slice(1)} Checker</h4>
          ${result.html}
        </div>
        <hr style="margin: 20px 0;">
      `;
    }
    
    elements.resultsContainer.innerHTML = html;
    lastResults = allResults;
    applyFilter();
  }

  function applyFilter() {
    if (!filterInvalidOnly) {
      // Show all rows
      const allRows = elements.resultsContainer.querySelectorAll('tr');
      allRows.forEach(row => {
        row.style.display = '';
      });
      return;
    }
    
    // Hide rows that don't have invalid class or indication
    const tables = elements.resultsContainer.querySelectorAll('table');
    tables.forEach(table => {
      const rows = table.querySelectorAll('tbody tr');
      rows.forEach(row => {
        // Check if row has invalid class or contains error indicators
        const hasInvalid = row.classList.contains('invalid') ||
                          row.innerHTML.toLowerCase().includes('invalid') ||
                          row.innerHTML.toLowerCase().includes('error');
        
        row.style.display = hasInvalid ? '' : 'none';
      });
    });
  }

  function exportResults() {
    if (lastResults.length === 0) {
      alert('No results to export');
      return;
    }
    
    // Create a simple export of the results
    const wb = XLSX.utils.book_new();
    
    lastResults.forEach((result, index) => {
      const tables = elements.resultsContainer.querySelectorAll('table');
      if (tables[index]) {
        const ws = XLSX.utils.table_to_sheet(tables[index]);
        XLSX.utils.book_append_sheet(wb, ws, result.checker.substring(0, 31));
      }
    });
    
    XLSX.writeFile(wb, `checker_results_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

})();
