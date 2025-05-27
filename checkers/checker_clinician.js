// Globals to hold uploaded data
let xmlDoc = null;
let clinicianMap = null;
let xmlUploaded = false;
let excelUploaded = false;

// HTML Elements
const resultsDiv = document.getElementById('results');
const xmlInput = document.getElementById('xmlFileInput');
const excelInput = document.getElementById('excelFileInput');

// Initialize event listeners
function init() {
  xmlInput.addEventListener('change', handleXmlUpload);
  excelInput.addEventListener('change', handleExcelUpload);
  
  // Create a process button dynamically after both files uploaded
  resultsDiv.innerHTML = '<p>Upload both XML and Excel files to enable processing.</p>';
}

// === XML Upload & Parse ===
function handleXmlUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  xmlUploaded = false;
  displayStatus('Loading XML file...');

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parser = new DOMParser();
      xmlDoc = parser.parseFromString(reader.result, 'application/xml');

      // Simple error check for XML parsing errors
      if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
        displayStatus('Error parsing XML file.', true);
        console.error('XML parsing error:', xmlDoc.getElementsByTagName('parsererror')[0].textContent);
        return;
      }

      xmlUploaded = true;
      displayStatus('XML file loaded successfully.');
      checkReadyToProcess();
    } catch (e) {
      displayStatus('Error reading XML file.', true);
      console.error(e);
    }
  };
  reader.readAsText(file);
}

// === Excel Upload & Parse with Progress ===
function handleExcelUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  excelUploaded = false;
  displayStatus('Loading Excel file...');

  const reader = new FileReader();

  // Optional: Show progress (if supported)
  reader.onprogress = (e) => {
    if (e.lengthComputable) {
      const percent = Math.round((e.loaded / e.total) * 100);
      displayStatus(`Reading Excel file: ${percent}%`);
    }
  };

  reader.onload = () => {
    try {
      const data = new Uint8Array(reader.result);
      const workbook = XLSX.read(data, { type: 'array' });
      clinicianMap = parseClinicianExcel(workbook);
      excelUploaded = true;
      displayStatus('Excel file loaded successfully.');
      checkReadyToProcess();
    } catch (e) {
      displayStatus('Error parsing Excel file.', true);
      console.error(e);
    }
  };

  reader.onerror = (e) => {
    displayStatus('Error reading Excel file.', true);
    console.error(e);
  };

  reader.readAsArrayBuffer(file);
}

// === Parse Excel into clinicianMap keyed by License ===
function parseClinicianExcel(workbook) {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  // Expecting columns: Clinician License, Name, Privileges, Category
  const map = {};
  jsonData.forEach(row => {
    const license = row['Clinician License']?.toString().trim();
    if (license) {
      map[license] = {
        name: row['Name'] || 'Unknown',
        privileges: row['Privileges'] || 'Unknown',
        category: row['Category'] || 'Unknown'
      };
    }
  });
  console.log('Clinician map built:', map);
  return map;
}

// === Check if both files uploaded to enable processing ===
function checkReadyToProcess() {
  if (xmlUploaded && excelUploaded) {
    showProcessButton();
  }
}

// === Show process button to start validation ===
function showProcessButton() {
  resultsDiv.innerHTML = `
    <button id="processBtn">Process Clinician Validation</button>
    <div id="validationResults"></div>
  `;

  document.getElementById('processBtn').addEventListener('click', () => {
    processClinicianValidation();
  });
}

// === Main processing: validate all activities ===
function processClinicianValidation() {
  console.log('Starting clinician validation...');
  const validationResultsDiv = document.getElementById('validationResults');

  if (!xmlDoc || !clinicianMap) {
    validationResultsDiv.textContent = 'XML or Excel data missing.';
    return;
  }

  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  if (claims.length === 0) {
    validationResultsDiv.textContent = 'No Claim elements found in XML.';
    return;
  }

  const table = createResultsTable();
  let validCount = 0;
  let invalidCount = 0;

  claims.forEach((claim, claimIndex) => {
    const activities = Array.from(claim.getElementsByTagName('Activity'));
    activities.forEach((activity, activityIndex) => {
      const orderingId = getTextContent(activity, 'OrderingClinician');
      const performingId = getTextContent(activity, 'Clinician');

      const validation = validateClinicians(orderingId, performingId, clinicianMap);

      addResultRow(table, {
        claimId: getTextContent(claim, 'ID'),
        activityId: getTextContent(activity, 'ID'),
        orderingId,
        performingId,
        orderingName: validation.orderingName,
        orderingPrivileges: validation.orderingPrivileges,
        performingName: validation.performingName,
        performingPrivileges: validation.performingPrivileges,
        valid: validation.valid,
        remarks: validation.remarks
      });

      validation.valid ? validCount++ : invalidCount++;
    });
  });

  validationResultsDiv.innerHTML = '';
  validationResultsDiv.appendChild(table);
  validationResultsDiv.insertAdjacentHTML('beforeend', `
    <p><strong>Validation Summary:</strong> Valid: ${validCount}, Invalid: ${invalidCount}</p>
  `);

  console.log(`Validation completed: ${validCount} valid, ${invalidCount} invalid.`);
}

// === Helper: get text content safely from an element ===
function getTextContent(parent, tagName) {
  const el = parent.getElementsByTagName(tagName)[0];
  return el ? el.textContent.trim() : '';
}

// === Create empty results table with headers ===
function createResultsTable() {
  const table = document.createElement('table');
  table.classList.add('results-table');
  const headers = [
    'Claim ID', 'Activity ID',
    'Ordering Clinician ID', 'Ordering Name', 'Ordering Privileges',
    'Performing Clinician ID', 'Performing Name', 'Performing Privileges',
    'Valid', 'Remarks'
  ];

  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  headers.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    headerRow.appendChild(th);
  });
  return table;
}

// === Add a row to results table ===
function addResultRow(table, data) {
  const row = table.insertRow();

  row.insertCell().textContent = data.claimId;
  row.insertCell().textContent = data.activityId;
  row.insertCell().textContent = data.orderingId;
  row.insertCell().textContent = data.orderingName;
  row.insertCell().textContent = data.orderingPrivileges;
  row.insertCell().textContent = data.performingId;
  row.insertCell().textContent = data.performingName;
  row.insertCell().textContent = data.performingPrivileges;
  row.insertCell().textContent = data.valid ? 'Yes' : 'No';
  row.insertCell().textContent = data.remarks;
}

// === Clinician Validation Functions ===

function lookupClinician(licenseId, clinicianMap) {
  if (!licenseId) return null;
  return clinicianMap[licenseId] || null;
}

function validateClinicianIdsEqual(orderingId, performingId) {
  return orderingId === performingId;
}

function checkCategoryMatch(orderingData, performingData) {
  if (!orderingData || !performingData) return false;
  return orderingData.category === performingData.category;
}

function validateClinicians(orderingId, performingId, clinicianMap) {
  const orderingData = lookupClinician(orderingId, clinicianMap);
  const performingData = lookupClinician(performingId, clinicianMap);

  if (validateClinicianIdsEqual(orderingId, performingId)) {
    const valid = orderingData != null;
    return {
      valid,
      remarks: valid ? '' : 'License not found for clinician',
      orderingName: orderingData?.name || 'Unknown',
      orderingPrivileges: orderingData?.privileges || 'Unknown',
      performingName: performingData?.name || 'Unknown',
      performingPrivileges: performingData?.privileges || 'Unknown'
    };
  }

  if (!orderingData || !performingData) {
    return {
      valid: false,
      remarks: 'License not found for one or both clinicians',
      orderingName: orderingData?.name || 'Unknown',
      orderingPrivileges: orderingData?.privileges || 'Unknown',
      performingName: performingData?.name || 'Unknown',
      performingPrivileges: performingData?.privileges || 'Unknown'
    };
  }

  if (checkCategoryMatch(orderingData, performingData)) {
    return {
      valid: true,
      remarks: '',
      orderingName: orderingData.name,
      orderingPrivileges: orderingData.privileges,
      performingName: performingData.name,
      performingPrivileges: performingData.privileges
    };
  } else {
    return {
      valid: false,
      remarks: `Category mismatch: Ordering (${orderingData.category}) / Performing (${performingData.category})`,
      orderingName: orderingData.name,
      orderingPrivileges: orderingData.privileges,
      performingName: performingData.name,
      performingPrivileges: performingData.privileges
    };
  }
}

// === Utility: display status messages (with optional error styling) ===
function displayStatus(message, isError = false) {
  resultsDiv.innerHTML = `<p style="color: ${isError ? 'red' : 'black'};">${message}</p>`;
  console.log(message);
}

// Initialize everything
init();
