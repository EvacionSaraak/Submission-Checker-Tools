// VERKA 4 - Clinician Validation Tool

// Global variables
let openJetClinicianList = [];
let xmlDoc = null;
let clinicianMap = null;
const filesLoading = { xml: false, excel: false };

// DOM elements
const xmlInput = document.getElementById('xmlFileInput');
const excelInput = document.getElementById('excelFileInput');
const openJetInput = document.getElementById('openJetFileInput');
const resultsDiv = document.getElementById('results');
const processBtn = document.getElementById('processBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');

// Initialize event listeners
function initEventListeners() {
  // XML file input
  xmlInput.addEventListener('change', handleXmlInput);

  // Excel file input
  if (excelInput) {
    excelInput.addEventListener('change', handleExcelInput);
  }

  // Open Jet file input
  if (openJetInput) {
    openJetInput.addEventListener('change', handleOpenJetInput);
  }

  // Process button
  processBtn.addEventListener('click', () => {
    if (xmlDoc && clinicianMap) {
      processClaims(xmlDoc, clinicianMap);
    }
  });
}

// XML file handler
async function handleXmlInput() {
  resultsDiv.textContent = 'Loading XML...';
  filesLoading.xml = true;

  try {
    const file = xmlInput.files[0];
    if (!file) {
      throw new Error('No file selected');
    }

    const text = await file.text();
    if (!text.trim()) {
      throw new Error('Empty XML file');
    }

    xmlDoc = new DOMParser().parseFromString(text, 'application/xml');

    const errorNode = xmlDoc.querySelector('parsererror');
    if (errorNode) {
      throw new Error('Invalid XML format');
    }

    const claimCount = xmlDoc.getElementsByTagName('Claim').length;
    console.log('XML loaded:', claimCount, 'claims');
    resultsDiv.textContent = `XML loaded (${claimCount} claims).`;

  } catch (e) {
    xmlDoc = null;
    resultsDiv.textContent = `Error loading XML: ${e.message}`;
    console.error('XML Error:', e);
  } finally {
    filesLoading.xml = false;
    toggleProcessButton();
  }
}

// Excel file handler
async function handleExcelInput() {
  resultsDiv.textContent = 'Loading Excel...';
  filesLoading.excel = true;

  try {
    const file = excelInput.files[0];
    if (!file) {
      throw new Error('No file selected');
    }

    const data = new Uint8Array(await file.arrayBuffer());
    const workbook = XLSX.read(data, { type: 'array' });

    if (workbook.SheetNames.length < 2) {
      throw new Error('Excel file must contain at least 2 sheets');
    }

    const sheet = workbook.Sheets[workbook.SheetNames[1]];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    clinicianMap = new Map();
    json.forEach(row => {
      const id = row['Clinician ID']?.toString().trim();
      if (id) {
        clinicianMap.set(id, {
          name: row['Clinician Name'] || 'N/A',
          category: row['Clinician Category'] || 'N/A',
          privileges: row['Activity Group'] || 'N/A'
        });
      }
    });

    console.log('Excel loaded:', clinicianMap.size, 'entries');
    resultsDiv.textContent = 'Excel loaded.';
  } catch (e) {
    clinicianMap = null;
    resultsDiv.textContent = `Error loading Excel: ${e.message}`;
    console.error('Excel Error:', e);
  } finally {
    filesLoading.excel = false;
    toggleProcessButton();
  }
}

// Open Jet file handler
async function handleOpenJetInput() {
  resultsDiv.textContent = 'Loading Open Jet XLSX...';
  try {
    const file = openJetInput.files[0];
    if (!file) {
      throw new Error('No file selected');
    }

    openJetClinicianList = await readOpenJetExcel(file);
    console.log('Open Jet XLSX loaded:', openJetClinicianList.length, 'records');
    resultsDiv.textContent = 'Open Jet file loaded.';
  } catch (e) {
    openJetClinicianList = [];
    resultsDiv.textContent = `Error loading Open Jet XLSX: ${e.message}`;
    console.error('Open Jet Error:', e);
  } finally {
    toggleProcessButton();
  }
}

// Read Open Jet Excel file
async function readOpenJetExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });

        if (workbook.SheetNames.length === 0) {
          throw new Error('No sheets found in Excel file');
        }

        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: '', range: 1 });
        
        const cleaned = json.map(row => {
          const clinician = row['Clinician'];
          return clinician !== undefined ? clinician.toString().trim() : '';
        }).filter(Boolean);

        resolve(cleaned);
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

// Enable/disable process button based on file readiness
function toggleProcessButton() {
  const ready = !filesLoading.xml && 
                !filesLoading.excel && 
                xmlDoc && 
                clinicianMap && 
                openJetClinicianList.length > 0;

  processBtn.disabled = !ready;
  exportCsvBtn.disabled = !ready;

  if (ready) {
    resultsDiv.textContent = 'Ready to process. Click "Process Files".';
  }
}

// Process claims data
function processClaims(xmlDoc, clinicianMap) {
  if (!xmlDoc || !clinicianMap) {
    resultsDiv.textContent = 'Error: Required files not loaded';
    return;
  }

  resultsDiv.textContent = 'Processing...';
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  const results = [];

  claims.forEach(claim => {
    const claimId = getText(claim, 'ID') || 'N/A';
    const activities = Array.from(claim.getElementsByTagName('Activity'));

    activities.forEach(activity => {
      const activityId = getText(activity, 'ID') || 'N/A';
      const orderingId = getText(activity, 'OrderingClinician') || '';
      const performingId = getText(activity, 'Clinician') || '';

      const orderingData = clinicianMap.get(orderingId) || defaultClinicianData();
      const performingData = clinicianMap.get(performingId) || defaultClinicianData();

      const remarksList = [];

      // Check Open Jet list
      if (performingId && !openJetClinicianList.includes(performingId)) {
        remarksList.push(`Performing Clinician (${performingId}) not in Open Jet list`);
      }
      if (orderingId && !openJetClinicianList.includes(orderingId)) {
        remarksList.push(`Ordering Clinician (${orderingId}) not in Open Jet list`);
      }

      // Validate clinician relationships
      const valid = validateClinicians(orderingId, performingId, orderingData, performingData);
      if (!valid) {
        remarksList.push(generateRemarks(orderingId, performingId, orderingData, performingData));
      }

      results.push({
        claimId,
        activityId,
        clinicianInfo: `Ordering: ${orderingId} - ${orderingData.name}\nPerforming: ${performingId} - ${performingData.name}`,
        privilegesInfo: `Ordering: ${orderingData.privileges}\nPerforming: ${performingData.privileges}`,
        categoryInfo: `Ordering: ${orderingData.category}\nPerforming: ${performingData.category}`,
        valid,
        remarks: remarksList.join('; ')
      });
    });
  });

  renderResults(results);
  logSummary(results);
  exportCsvBtn.disabled = false;
  setupExportHandler(results);
}

// Helper functions
function getText(parent, tag) {
  const el = parent.getElementsByTagName(tag)[0];
  return el ? el.textContent.trim() : '';
}

function defaultClinicianData() {
  return { name: 'N/A', category: 'N/A', privileges: 'N/A' };
}

function validateClinicians(orderingId, performingId, orderingData, performingData) {
  return orderingId === performingId || orderingData.category === performingData.category;
}

function generateRemarks(orderingId, performingId, orderingData, performingData) {
  return `Category mismatch: Ordering (${orderingData.category}) vs Performing (${performingData.category})`;
}

// Results rendering
function renderResults(results) {
  // Clear previous results
  resultsDiv.innerHTML = '';
  
  if (results.length === 0) {
    resultsDiv.textContent = 'No results found';
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');

  // Create header row
  const headerRow = document.createElement('tr');
  ['Claim ID', 'Activity ID', 'Clinicians', 'Privileges', 'Categories', 'Valid', 'Remarks'].forEach(text => {
    const th = document.createElement('th');
    th.textContent = text;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Create data rows
  results.forEach(r => {
    const tr = document.createElement('tr');
    
    // Claim ID
    const claimTd = document.createElement('td');
    claimTd.textContent = r.claimId;
    tr.appendChild(claimTd);
    
    // Activity ID
    const activityTd = document.createElement('td');
    activityTd.textContent = r.activityId;
    tr.appendChild(activityTd);
    
    // Clinicians (with pre-line formatting)
    const clinicianTd = document.createElement('td');
    clinicianTd.style.whiteSpace = 'pre-line';
    clinicianTd.textContent = r.clinicianInfo;
    tr.appendChild(clinicianTd);
    
    // Privileges (with pre-line formatting)
    const privTd = document.createElement('td');
    privTd.style.whiteSpace = 'pre-line';
    privTd.textContent = r.privilegesInfo;
    tr.appendChild(privTd);
    
    // Categories (with pre-line formatting)
    const catTd = document.createElement('td');
    catTd.style.whiteSpace = 'pre-line';
    catTd.textContent = r.categoryInfo;
    tr.appendChild(catTd);
    
    // Validation status
    const validTd = document.createElement('td');
    validTd.textContent = r.valid ? '✔️' : '❌';
    tr.appendChild(validTd);
    
    // Remarks
    const remarksTd = document.createElement('td');
    remarksTd.textContent = r.remarks;
    tr.appendChild(remarksTd);
    
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  resultsDiv.appendChild(table);
}

// Export to CSV
function setupExportHandler(results) {
  exportCsvBtn.onclick = () => {
    const rows = [['Claim ID', 'Activity ID', 'Clinicians', 'Privileges', 'Categories', 'Valid', 'Remarks']];
    
    results.forEach(r => {
      rows.push([
        r.claimId,
        r.activityId,
        r.clinicianInfo.replace(/\n/g, ' | '),
        r.privilegesInfo.replace(/\n/g, ' | '),
        r.categoryInfo.replace(/\n/g, ' | '),
        r.valid ? 'Yes' : 'No',
        r.remarks
      ]);
    });

    const csvContent = rows.map(r => 
      r.map(field => `"${field.toString().replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'clinician_validation_results.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
}

// Log summary to console
function logSummary(results) {
  const validCount = results.filter(r => r.valid).length;
  const total = results.length;
  const message = `Validation completed: ${validCount}/${total} valid (${Math.round((validCount/total)*100)}%)`;
  console.log(message);
  resultsDiv.insertAdjacentHTML('beforeend', `<p>${message}</p>`);
}

// Initialize the application
document.addEventListener('DOMContentLoaded', initEventListeners);
