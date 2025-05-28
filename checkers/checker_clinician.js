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
const validationDiv = document.createElement('div');
validationDiv.id = 'validation-message';
resultsDiv.parentNode.insertBefore(validationDiv, resultsDiv);
const processBtn = document.getElementById('processBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');

// Initialize event listeners
function initEventListeners() {
  console.log('Initializing event listeners');
  xmlInput.addEventListener('change', handleXmlInput);
  if (excelInput) excelInput.addEventListener('change', handleUnifiedExcelInput);
  if (openJetInput) openJetInput.addEventListener('change', handleUnifiedExcelInput);
  processBtn.addEventListener('click', () => {
    console.log('Process button clicked');
    if (xmlDoc && clinicianMap && openJetClinicianList.length > 0) {
      processClaims(xmlDoc, clinicianMap);
    } else {
      console.warn('Missing required files or data for processing');
    }
  });
}

// Unified Excel handler
async function handleUnifiedExcelInput() {
  resultsDiv.textContent = 'Loading Excel files...';
  try {
    if (excelInput.files[0]) {
      console.log('Loading clinician Excel');
      clinicianMap = await loadClinicianExcel(excelInput.files[0]);
    }
    if (openJetInput.files[0]) {
      console.log('Loading Open Jet Excel');
      openJetClinicianList = await loadOpenJetExcel(openJetInput.files[0]);
    }
    resultsDiv.textContent = `Excel loaded: ${clinicianMap?.size || 0} clinicians, ${openJetClinicianList?.length || 0} Open Jet IDs.`;
  } catch (e) {
    resultsDiv.textContent = `Error loading Excel files: ${e.message}`;
    console.error('Excel Error:', e);
  } finally {
    toggleProcessButton();
  }
}

async function loadClinicianExcel(file) {
  console.log('Parsing clinician Excel file');
  const data = new Uint8Array(await file.arrayBuffer());
  const workbook = XLSX.read(data, { type: 'array' });
  const sheetName = workbook.SheetNames.find(n => n.toLowerCase().includes('clinician'));
  if (!sheetName) throw new Error('No sheet with clinician data found');

  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const map = new Map();

  json.forEach(row => {
    const id = (row['Clinician ID'] || row['ID'] || row['Clinician'] || '').toString().trim();
    if (id) {
      map.set(id, {
        name: row['Clinician Name'] || row['Name'] || 'N/A',
        category: row['Clinician Category'] || row['Category'] || 'N/A',
        privileges: row['Activity Group'] || row['Privileges'] || 'N/A'
      });
    }
  });

  console.log(`Loaded ${map.size} clinicians from Excel`);
  return map;
}

async function loadOpenJetExcel(file) {
  console.log('Parsing Open Jet Excel file');
  const data = new Uint8Array(await file.arrayBuffer());
  const workbook = XLSX.read(data, { type: 'array' });
  if (workbook.SheetNames.length < 2) throw new Error('Open Jet file must have at least two sheets.');

  const secondSheet = workbook.Sheets[workbook.SheetNames[1]];
  const json = XLSX.utils.sheet_to_json(secondSheet, { defval: '' });

  const licenses = new Set();
  json.forEach(row => {
    const license = row['Clinician License'];
    if (license) {
      licenses.add(license.toString().trim());
    }
  });

  console.log(`Loaded ${licenses.size} clinician licenses from Open Jet Excel`);
  return Array.from(licenses);
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
    console.log(`XML loaded with ${claimCount} claims`);
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

function getText(parent, tag) {
  const el = parent.getElementsByTagName(tag)[0];
  return el ? el.textContent.trim() : '';
}

function defaultClinicianData() {
  return { name: 'Unknown', category: 'Unknown', privileges: 'Unknown' };
}

function validateClinicians(orderingId, performingId, orderingData, performingData) {
  if (!orderingId || !performingId) return false;
  if (orderingId === performingId) return true;
  return orderingData.category === performingData.category;
}

function generateRemarks(orderingData, performingData) {
  const remarks = [];
  if (orderingData.category !== performingData.category) {
    remarks.push(`Category mismatch (${orderingData.category} vs ${performingData.category})`);
  }
  return remarks.join('; ');
}

function processClaims(xmlDoc, clinicianMap) {
  console.log('Processing claims');
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

  console.log(`Processed ${results.length} activities`);
  renderResults(results);
  setupExportHandler(results);
}

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
  console.log(`Validation summary: ${validCount}/${total} valid (${percentage}%)`);

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

  results.forEach(r => {
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

function toggleProcessButton() {
  const ready = xmlDoc && clinicianMap && openJetClinicianList.length > 0;
  console.log(`Toggle process button: ready = ${ready}`);
  processBtn.disabled = !ready;
}

function setupExportHandler(results) {
  exportCsvBtn.onclick = () => {
    console.log('Exporting results to CSV');
    const headers = ['Claim ID', 'Activity ID', 'Clinicians', 'Privileges', 'Categories', 'Valid', 'Remarks'];
    const rows = results.map(r => [
      r.claimId,
      r.activityId,
      r.clinicianInfo,
      r.privilegesInfo,
      r.categoryInfo,
      r.valid ? 'Yes' : 'No',
      r.remarks
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(value => `"${value.replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'validation_results.csv');
    link.click();
  };
}

// Initialize app
document.addEventListener('DOMContentLoaded', initEventListeners);
