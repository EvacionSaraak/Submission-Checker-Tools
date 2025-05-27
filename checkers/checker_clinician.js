document.addEventListener('DOMContentLoaded', init);

let excelData = null;
let xmlDoc = null;
let isExcelLoaded = false;
let isXmlLoaded = false;

function init() {
  const xmlInput = document.getElementById('xmlFileInput');
  const excelInput = document.getElementById('excelFileInput');

  xmlInput.addEventListener('change', handleXmlFile);
  excelInput.addEventListener('change', handleExcelFile);

  // Create and insert progress bar container after Excel input
  createExcelProgressBar(excelInput.parentNode);
}

function createExcelProgressBar(container) {
  const progressContainer = document.createElement('div');
  progressContainer.id = 'excelProgressContainer';
  progressContainer.style.cssText = `
    width: 100%; 
    background: #eee; 
    height: 20px; 
    margin-top: 5px; 
    display: none; 
    border-radius: 5px; 
    overflow: hidden;
  `;

  const progressBar = document.createElement('div');
  progressBar.id = 'excelProgressBar';
  progressBar.style.cssText = `
    height: 100%; 
    width: 0%; 
    background-color: #4caf50; 
    transition: width 0.2s;
  `;

  progressContainer.appendChild(progressBar);
  container.appendChild(progressContainer);
}

async function handleXmlFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  isXmlLoaded = false;
  setStatusMessage('Loading XML file...');
  try {
    const text = await file.text();
    xmlDoc = parseXML(text);
    isXmlLoaded = true;
    setStatusMessage('XML file loaded.');
    tryProcess();
  } catch (err) {
    setStatusMessage(`Error parsing XML: ${err.message}`, true);
    console.error('XML parse error:', err);
  }
}

function parseXML(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML');
  return doc;
}

function handleExcelFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  isExcelLoaded = false;
  setStatusMessage('Reading Excel file...');
  showProgressBar(true);
  readExcelFileWithProgress(file)
    .then(data => {
      excelData = data;
      isExcelLoaded = true;
      setStatusMessage('Excel file loaded.');
      showProgressBar(false);
      tryProcess();
    })
    .catch(err => {
      setStatusMessage(`Error reading Excel: ${err.message}`, true);
      showProgressBar(false);
      console.error('Excel read error:', err);
    });
}

function showProgressBar(show) {
  const container = document.getElementById('excelProgressContainer');
  if (container) container.style.display = show ? 'block' : 'none';
  if (!show) updateProgressBar(0);
}

function updateProgressBar(percentage) {
  const bar = document.getElementById('excelProgressBar');
  if (bar) bar.style.width = `${percentage}%`;
}

function readExcelFileWithProgress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onprogress = (evt) => {
      if (evt.lengthComputable) {
        const percentLoaded = Math.round((evt.loaded / evt.total) * 100);
        updateProgressBar(percentLoaded);
        console.log(`Excel read progress: ${percentLoaded}%`);
      }
    };

    reader.onerror = () => reject(new Error('Failed to read Excel file'));
    reader.onabort = () => reject(new Error('Excel file read aborted'));

    reader.onload = (evt) => {
      try {
        const data = evt.target.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        // json is array of arrays, row 1 is header row
        resolve(json);
      } catch (e) {
        reject(e);
      }
    };

    reader.readAsArrayBuffer(file);
  });
}

function tryProcess() {
  if (!isXmlLoaded || !isExcelLoaded) {
    console.log('Waiting for both files to load...');
    return;
  }
  console.log('Both files loaded. Starting validation...');
  processClaims(xmlDoc, excelData);
}

function processClaims(xml, excel) {
  // Map Excel headers from first row
  const headers = excel[0];
  const dataRows = excel.slice(1);

  // Find column indexes for needed fields
  const colIndex = {};
  ['Clinician License', 'Clinician Name', 'Privilages', 'Category'].forEach(key => {
    const idx = headers.indexOf(key);
    if (idx === -1) {
      console.warn(`Warning: Column "${key}" not found in Excel`);
    }
    colIndex[key] = idx;
  });

  // Build clinician lookup by License
  const clinicianMap = new Map();
  dataRows.forEach(row => {
    const license = row[colIndex['Clinician License']];
    if (!license) return;
    clinicianMap.set(license.trim(), {
      name: row[colIndex['Clinician Name']] ?? 'N/A',
      privilages: row[colIndex['Privilages']] ?? 'N/A',
      category: row[colIndex['Category']] ?? 'N/A'
    });
  });

  // Extract claims and activities from XML (supports multiple <Claim>)
  const claims = Array.from(xml.getElementsByTagName('Claim'));

  let results = [];
  claims.forEach((claim, claimIndex) => {
    const activities = Array.from(claim.getElementsByTagName('Activity'));
    activities.forEach(activity => {
      const orderingClinician = activity.querySelector('OrderingClinician')?.textContent.trim() ?? 'N/A';
      const performingClinician = activity.querySelector('Clinician')?.textContent.trim() ?? 'N/A';

      // Lookup clinicians in Excel
      const orderingInfo = clinicianMap.get(orderingClinician);
      const performingInfo = clinicianMap.get(performingClinician);

      let validity = 'Valid';
      let remarks = '';

      if (orderingClinician === performingClinician) {
        // Same clinician, automatically valid
        if (!orderingInfo) {
          validity = 'Invalid';
          remarks = 'Ordering clinician not found in Excel';
        }
      } else {
        // Different clinicians - check categories
        if (!orderingInfo || !performingInfo) {
          validity = 'Invalid';
          remarks = 'Clinician(s) not found in Excel';
        } else if (orderingInfo.category !== performingInfo.category) {
          validity = 'Invalid';
          remarks = `Category mismatch: Ordering(${orderingInfo.category}) / Performing(${performingInfo.category})`;
        }
      }

      results.push({
        activityId: activity.querySelector('ID')?.textContent.trim() ?? 'N/A',
        orderingClinician,
        orderingName: orderingInfo?.name ?? 'N/A',
        orderingPrivilages: orderingInfo?.privilages ?? 'N/A',
        performingClinician,
        performingName: performingInfo?.name ?? 'N/A',
        performingPrivilages: performingInfo?.privilages ?? 'N/A',
        validity,
        remarks
      });
    });
  });

  renderResults(results);
  logSummary(results);
}

function renderResults(results) {
  if (results.length === 0) {
    setStatusMessage('No activities found in XML.');
    return;
  }

  const rowsHtml = results.map(r => `
    <tr class="${r.validity === 'Valid' ? 'valid' : 'invalid'}">
      <td>${r.activityId}</td>
      <td>${r.orderingClinician}</td>
      <td>${r.orderingName}</td>
      <td>${r.orderingPrivilages}</td>
      <td>${r.performingClinician}</td>
      <td>${r.performingName}</td>
      <td>${r.performingPrivilages}</td>
      <td>${r.validity}</td>
      <td>${r.remarks}</td>
    </tr>
  `).join('');

  const tableHtml = `
    <table>
      <thead>
        <tr>
          <th>Activity ID</th>
          <th>Ordering Clinician ID</th>
          <th>Ordering Clinician Name</th>
          <th>Ordering Privilages</th>
          <th>Performing Clinician ID</th>
          <th>Performing Clinician Name</th>
          <th>Performing Privilages</th>
          <th>Validity</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  document.getElementById('results').innerHTML = tableHtml;
}

function setStatusMessage(msg, isError = false) {
  const results = document.getElementById('results');
  results.innerHTML = `<p style="color:${isError ? 'red' : 'black'};">${msg}</p>`;
}

function logSummary(results) {
  const total = results.length;
  const validCount = results.filter(r => r.validity === 'Valid').length;
  const invalidCount = total - validCount;

  console.log(`Validation Summary:`);
  console.log(`Total activities checked: ${total}`);
  console.log(`Valid activities: ${validCount}`);
  console.log(`Invalid activities: ${invalidCount}`);

  if (invalidCount > 0) {
    console.log('Invalid activity details:');
    results.filter(r => r.validity === 'Invalid').forEach(r => {
      console.log(`Activity ID ${r.activityId}: ${r.remarks}`);
    });
  }
}
