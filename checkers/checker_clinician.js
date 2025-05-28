// VERKA 43 - Clinician Validation Tool (Final Version)

// Global variables
let openJetClinicianList = [];
let xmlDoc = null;
let clinicianMap = null;

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
  console.log('Loading Excel files...');
  resultsDiv.textContent = 'Loading Excel files...';
  try {
    if (excelInput.files[0]) {
      console.log('Attempting to load Clinician Excel:', excelInput.files[0].name);
      clinicianMap = await loadClinicianExcel(excelInput.files[0]);
      console.log('Clinician Excel loaded successfully');
    }
    if (openJetInput.files[0]) {
      console.log('Attempting to load Open Jet Excel:', openJetInput.files[0].name);
      openJetClinicianList = await loadOpenJetExcel(openJetInput.files[0]);
      console.log('Open Jet Excel loaded successfully');
    }
    resultsDiv.textContent = `Excel loaded: ${clinicianMap.size} clinicians, ${openJetClinicianList.length} Open Jet IDs.`;
  } catch (e) {
    console.error('Unified Excel loading error:', e);
    resultsDiv.textContent = `Error loading Excel files: ${e.message}`;
  } finally {
    toggleProcessButton();
  }
}

// Load clinician Excel: expects sheet named 'Clinicians'
async function loadClinicianExcel(file) {
  console.log('Parsing Clinicians Excel file');
  const data = new Uint8Array(await file.arrayBuffer());
  const workbook = XLSX.read(data, { type: 'array' });
  console.log('Workbook sheets for clinicians:', workbook.SheetNames);
  const sheetName = 'Clinicians';
  if (!workbook.SheetNames.includes(sheetName)) {
    console.error(`Sheet '${sheetName}' not found in clinician workbook`);
    throw new Error("Clinician sheet 'Clinicians' not found");
  }
  const sheet = workbook.Sheets[sheetName];
  // Log first few rows to debug header offset
  const preview = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0, defval: '' }).slice(0, 3);
  console.log('Clinician sheet preview rows:', preview);
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  console.log('Clinician JSON keys sample:', json.length ? Object.keys(json[0]) : 'No data');
  const map = new Map();
  json.forEach((row, index) => {
    const id = (row['Clinician ID'] || row['ID'] || row['Clinician'] || '').toString().trim();
    if (!id) console.warn(`Row ${index + 2}: missing Clinician ID`);
    if (id) {
      map.set(id, {
        name: row['Clinician Name'] || row['Name'] || 'N/A',
        category: row['Clinician Category'] || row['Category'] || 'N/A',
        privileges: row['Activity Group'] || row['Privileges'] || 'N/A'
      });
    }
  });
  console.log(`Loaded ${map.size} clinicians from sheet '${sheetName}'`);
  return map;
}

// Load OpenJet Excel: expects single sheet at index 0, header starts on row 2
async function loadOpenJetExcel(file) {
  console.log('Parsing Open Jet Excel file');
  const data = new Uint8Array(await file.arrayBuffer());
  const workbook = XLSX.read(data, { type: 'array' });
  console.log('Workbook sheets for Open Jet:', workbook.SheetNames);
  if (workbook.SheetNames.length < 1) {
    console.error('No sheets found in Open Jet workbook');
    throw new Error('Open Jet file has no sheets');
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  // Preview rows to check header offset
  const preview = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0, defval: '' }).slice(0, 4);
  console.log('Open Jet sheet preview (first 4 rows):', preview);
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  console.log('Open Jet JSON keys sample:', json.length ? Object.keys(json[0]) : 'No data');
  const licenses = new Set();
  json.forEach((row, index) => {
    const lic = row['Clinician License'] || row['License'] || '';
    if (!lic) console.warn(`Row ${index + 2}: missing Clinician License`);
    if (lic) licenses.add(lic.toString().trim());
  });
  console.log(`Loaded ${licenses.size} clinician licenses from Open Jet`);
  return Array.from(licenses);
}

// XML file handler
async function handleXmlInput() {
  console.log('Loading XML');
  resultsDiv.textContent = 'Loading XML...';
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
    toggleProcessButton();
  }
}

// Core processing and rendering logic (unchanged)...
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
  if (orderingData.category !== performingData.category) remarks.push(`Category mismatch (${orderingData.category} vs ${performingData.category})`);
  return remarks.join('; ');
}

function processClaims(xmlDoc, clinicianMap) {
  console.log('Processing claims');
  resultsDiv.textContent = 'Processing...';
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  const results = [];
  claims.forEach(claim => {
    const claimId = getText(claim, 'ID') || 'N/A';
    Array.from(claim.getElementsByTagName('Activity')).forEach(activity => {
      const activityId = getText(activity, 'ID') || 'N/A';
      const orderingId = getText(activity, 'OrderingClinician') || '';
      const performingId = getText(activity, 'Clinician') || '';
      const orderingData = clinicianMap.get(orderingId) || defaultClinicianData();
      const performingData = clinicianMap.get(performingId) || defaultClinicianData();
      const remarksList = [];
      if (performingId && !openJetClinicianList.includes(performingId)) remarksList.push(`Performing Clinician (${performingId}) not in Open Jet`);
      if (orderingId && !openJetClinicianList.includes(orderingId)) remarksList.push(`Ordering Clinician (${orderingId}) not in Open Jet`);
      const valid = validateClinicians(orderingId, performingId, orderingData, performingData);
      if (!valid) remarksList.push(generateRemarks(orderingData, performingData));
      results.push({ claimId, activityId, clinicianInfo: `Ordering: ${orderingId} - ${orderingData.name}\nPerforming: ${performingId} - ${performingData.name}`, privilegesInfo: `Ordering: ${orderingData.privileges}\nPerforming: ${performingData.privileges}`, categoryInfo: `Ordering: ${orderingData.category}\nPerforming: ${performingData.category}`, valid, remarks: remarksList.join('; '), rowSpan: 1 });
    });
  });
  for (let i = 1; i < results.length; i++) {
    if (results[i].claimId === results[i-1].claimId) { results[i].rowSpan = 0; results[i-1].rowSpan++; }
  }
  console.log(`Processed ${results.length} activities`);
  renderResults(results);
  setupExportHandler(results);
}

function renderResults(results) {
  resultsDiv.innerHTML = '';
  validationDiv.innerHTML = '';
  if (!results.length) { resultsDiv.textContent = 'No results found'; return; }
  const validCount = results.filter(r => r.valid).length;
  const total = results.length;
  const percentage = Math.round((validCount/total)*100);
  console.log(`Validation summary: ${validCount}/${total} valid (${percentage}%)`);
  validationDiv.textContent = `Validation completed: ${validCount}/${total} valid (${percentage}%)`;
  validationDiv.className = percentage>90 ? 'valid-message' : percentage>70 ? 'warning-message' : 'error-message';
  const table = document.createElement('table'); const thead = document.createElement('thead'); const headerRow = document.createElement('tr'); ['Claim ID','Activity ID','Clinicians','Privileges','Categories','Valid','Remarks'].forEach(text => { const th = document.createElement('th'); th.textContent = text; headerRow.appendChild(th); }); thead.appendChild(headerRow); table.appendChild(thead); const tbody = document.createElement('tbody'); results.forEach(r => { if (r.rowSpan===0) return; const tr = document.createElement('tr'); tr.className = r.valid ? 'valid':'invalid'; const claimTd = document.createElement('td'); claimTd.textContent = r.claimId; if(r.rowSpan>1){claimTd.rowSpan=r.rowSpan;claimTd.style.verticalAlign='top';} tr.appendChild(claimTd); [r.activityId, r.clinicianInfo, r.privilegesInfo, r.categoryInfo, r.valid? '✔️':'❌', r.remarks].forEach(text=>{ const td=document.createElement('td'); td.style.whiteSpace = text.includes('\n')?'pre-line':'nowrap'; td.textContent=text; tr.appendChild(td); }); tbody.appendChild(tr); }); table.appendChild(tbody); resultsDiv.appendChild(table);
}

function setupExportHandler(results) {
  exportCsvBtn.disabled = false;
  exportCsvBtn.onclick = () => {
    console.log('Exporting results to CSV');
    const headers = ['Claim ID','Activity ID','Clinicians','Privileges','Categories','Valid','Remarks'];
    const rows = results.map(r=>[r.claimId,r.activityId,r.clinicianInfo,r.privilegesInfo,r.categoryInfo,r.valid?'Yes':'No',r.remarks]);
    const csv = [headers,...rows].map(row=>row.map(v=>`"${v.replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const link = document.createElement('a'); link.href=URL.createObjectURL(blob); link.setAttribute('download','validation_results.csv'); link.click();
  };
}

function toggleProcessButton() {
  const ready = xmlDoc && clinicianMap && openJetClinicianList.length>0;
  console.log(`Toggle process button: ready = ${ready}`);
  processBtn.disabled = !ready;
}

// Initialize app
document.addEventListener('DOMContentLoaded', initEventListeners);
