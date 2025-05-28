// VERKA 43 - Clinician Validation Tool (Final Version)

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
const validationDiv = document.createElement('div'); // New div for validation message
validationDiv.id = 'validation-message';
resultsDiv.parentNode.insertBefore(validationDiv, resultsDiv);
const processBtn = document.getElementById('processBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');

// Initialize event listeners
function initEventListeners() {
  xmlInput.addEventListener('change', handleXmlInput);
  if (excelInput) excelInput.addEventListener('change', handleExcelInput);
  if (openJetInput) openJetInput.addEventListener('change', handleOpenJetInput);
  processBtn.addEventListener('click', () => xmlDoc && clinicianMap && processClaims(xmlDoc, clinicianMap));
}

// XML file handler
async function handleXmlInput() {
  resultsDiv.textContent = 'Loading XML...';
  filesLoading.xml = true;
  try {
    const file = xmlInput.files[0];
    if (!file) throw new Error('No file selected');
    
    const text = await file.text();
    if (!text.trim()) throw new Error('Empty XML file');
    
    xmlDoc = new DOMParser().parseFromString(text, 'application/xml');
    if (xmlDoc.querySelector('parsererror')) throw new Error('Invalid XML format');
    
    const claimCount = xmlDoc.getElementsByTagName('Claim').length;
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
    if (!file) throw new Error('No file selected');
    
    const data = new Uint8Array(await file.arrayBuffer());
    const workbook = XLSX.read(data, { type: 'array' });
    
    const clinicianSheetName = workbook.SheetNames.find(name => 
      name.trim().toLowerCase() === 'clinicians'
    ) || workbook.SheetNames.find(name => 
      name.toLowerCase().includes('clinician')
    );
    
    if (!clinicianSheetName) throw new Error('No Clinicians sheet found');
    
    const sheet = workbook.Sheets[clinicianSheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    
    clinicianMap = new Map();
    json.forEach(row => {
      const id = (row['Clinician ID'] || row['ID'] || row['Clinician'] || '').toString().trim();
      if (id) {
        clinicianMap.set(id, {
          name: row['Clinician Name'] || row['Name'] || 'N/A',
          category: row['Clinician Category'] || row['Category'] || 'N/A',
          privileges: row['Activity Group'] || row['Privileges'] || 'N/A'
        });
      }
    });
    
    resultsDiv.textContent = `Excel loaded (${clinicianMap.size} clinicians).`;
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
    if (!file) throw new Error('No file selected');
    
    openJetClinicianList = await readOpenJetExcel(file);
    resultsDiv.textContent = `Open Jet loaded (${openJetClinicianList.length} eligibilities).`;
  } catch (e) {
    openJetClinicianList = [];
    resultsDiv.textContent = `Error loading Open Jet: ${e.message}`;
    console.error('Open Jet Error:', e);
  } finally {
    toggleProcessButton();
  }
}

// Helper: get text content of a tag
function getText(parent, tag) {
  const el = parent.getElementsByTagName(tag)[0];
  return el ? el.textContent.trim() : '';
}

// Helper: default clinician data
function defaultClinicianData() {
  return { name: 'Unknown', category: 'Unknown', privileges: 'Unknown' };
}

// NEW: Validate clinicians
function validateClinicians(orderingId, performingId, orderingData, performingData) {
  if (!orderingId || !performingId) return false;
  if (orderingId === performingId) return true;
  return orderingData.category === performingData.category;
}

// NEW: Generate remarks on mismatch
function generateRemarks(orderingData, performingData) {
  const remarks = [];
  if (orderingData.category !== performingData.category) {
    remarks.push(`Category mismatch (${orderingData.category} vs ${performingData.category})`);
  }
  return remarks.join('; ');
}

// Process claims with merged Claim ID cells
function processClaims(xmlDoc, clinicianMap) {
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
      if (performingId && !openJetClinicianList.includes(performingId)) {
        remarksList.push(`Performing Clinician (${performingId}) not in Open Jet`);
      }
      if (orderingId && !openJetClinicianList.includes(orderingId)) {
        remarksList.push(`Ordering Clinician (${orderingId}) not in Open Jet`);
      }
      
      const valid = validateClinicians(orderingId, performingId, orderingData, performingData);
      if (!valid) remarksList.push(generateRemarks(orderingData, performingData));
      
      results.push({
        claimId,
        activityId,
        clinicianInfo: `Ordering: ${orderingId} - ${orderingData.name}\nPerforming: ${performingId} - ${performingData.name}`,
        privilegesInfo: `Ordering: ${orderingData.privileges}\nPerforming: ${performingData.privileges}`,
        categoryInfo: `Ordering: ${orderingData.category}\nPerforming: ${performingData.category}`,
        valid,
        remarks: remarksList.join('; '),
        rowSpan: 1
      });
    });
  });

  for (let i = 0; i < results.length; i++) {
    if (i > 0 && results[i].claimId === results[i - 1].claimId) {
      results[i].rowSpan = 0;
      results[i - 1].rowSpan++;
    }
  }

  renderResults(results);
  setupExportHandler(results);
}

// Render results table
function renderResults(results) {
  resultsDiv.innerHTML = '';
  validationDiv.innerHTML = '';
  
  if (results.length === 0) {
    resultsDiv.textContent = 'No results found';
    return;
  }
  
  const validCount = results.filter(r => r.valid).length;
  const total = results.length;
  const percentage = Math.round((validCount / total) * 100);
  validationDiv.textContent = `Validation completed: ${validCount}/${total} valid (${percentage}%)`;
  validationDiv.className = percentage > 90 ? 'valid-message' : percentage > 70 ? 'warning-message' : 'error-message';
  
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  
  const headerRow = document.createElement('tr');
  ['Claim ID', 'Activity ID', 'Clinicians', 'Privileges', 'Categories', 'Valid', 'Remarks'].forEach(text => {
    const th = document.createElement('th');
    th.textContent = text;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);
  
  results.forEach((r, index) => {
    if (r.rowSpan === 0) return;
    const tr = document.createElement('tr');
    tr.className = r.valid ? 'valid' : 'invalid';
    
    const claimTd = document.createElement('td');
    if (r.rowSpan > 1) {
      claimTd.rowSpan = r.rowSpan;
      claimTd.style.verticalAlign = 'top';
    }
    claimTd.textContent = r.claimId;
    tr.appendChild(claimTd);
    
    const activityTd = document.createElement('td');
    activityTd.textContent = r.activityId;
    tr.appendChild(activityTd);
    
    const clinicianTd = document.createElement('td');
    clinicianTd.style.whiteSpace = 'pre-line';
    clinicianTd.textContent = r.clinicianInfo;
    tr.appendChild(clinicianTd);
    
    const privTd = document.createElement('td');
    privTd.style.whiteSpace = 'pre-line';
    privTd.textContent = r.privilegesInfo;
    tr.appendChild(privTd);
    
    const catTd = document.createElement('td');
    catTd.style.whiteSpace = 'pre-line';
    catTd.textContent = r.categoryInfo;
    tr.appendChild(catTd);
    
    const validTd = document.createElement('td');
    validTd.textContent = r.valid ? '✔️' : '❌';
    tr.appendChild(validTd);
    
    const remarksTd = document.createElement('td');
    remarksTd.style.whiteSpace = 'nowrap';
    remarksTd.textContent = r.remarks;
    tr.appendChild(remarksTd);
    
    tbody.appendChild(tr);
  });
  
  table.appendChild(tbody);
  resultsDiv.appendChild(table);
}

// Enable or disable Process button
function toggleProcessButton() {
  const ready = xmlDoc && clinicianMap && openJetClinicianList.length > 0;
  processBtn.disabled = !ready;
}

// Placeholder: Export logic if needed
function setupExportHandler(results) {
  // You can implement CSV export logic here if needed
}

// Initialize app
document.addEventListener('DOMContentLoaded', initEventListeners);
