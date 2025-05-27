// checker_clinician.js

let xmlContent = null;
let excelData = null;
let xmlReady = false;
let excelReady = false;

document.addEventListener('DOMContentLoaded', () => {
  const xmlInput = document.getElementById('xmlFileInput');
  const excelInput = document.getElementById('excelFileInput');
  const processBtn = document.getElementById('processButton');
  const uploadStatus = document.getElementById('uploadStatus');

  xmlInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    uploadStatus.textContent = 'Uploading XML file...';
    xmlReady = false;
    processBtn.disabled = true;
    try {
      xmlContent = await readFileAsText(file);
      // Validate XML parse
      parseXML(xmlContent);
      xmlReady = true;
      uploadStatus.textContent = 'XML file ready.';
      maybeEnableProcess();
    } catch (err) {
      uploadStatus.textContent = 'Error reading or parsing XML: ' + err.message;
      console.error('XML file error:', err);
    }
  });

  excelInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    uploadStatus.textContent = 'Uploading Excel file...';
    excelReady = false;
    processBtn.disabled = true;
    try {
      excelData = await readExcel(file);
      excelReady = true;
      uploadStatus.textContent = 'Excel file ready.';
      maybeEnableProcess();
    } catch (err) {
      uploadStatus.textContent = 'Error reading Excel file: ' + err.message;
      console.error('Excel file error:', err);
    }
  });

  processBtn.addEventListener('click', () => {
    uploadStatus.textContent = 'Processing files...';
    console.log('Processing started...');
    try {
      const xmlDoc = parseXML(xmlContent);
      const claims = extractAllClaims(xmlDoc);
      const cliniciansMap = mapClinicians(excelData);
      const validationResults = validateClaims(claims, cliniciansMap);
      renderResults(validationResults);
      printSummary(validationResults);
      uploadStatus.textContent = 'Processing completed.';
    } catch (err) {
      uploadStatus.textContent = 'Error during processing: ' + err.message;
      console.error('Processing error:', err);
    }
  });

  function maybeEnableProcess() {
    if (xmlReady && excelReady) {
      processBtn.disabled = false;
      uploadStatus.textContent = 'Files are ready. Click "Process Files" to continue.';
    }
  }
});

// Utility: Read file as text
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = e => reject(e.target.error);
    reader.readAsText(file);
  });
}

// Utility: Read Excel using XLSX library
function readExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, {type: 'array'});
        resolve(workbook);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = e => reject(e.target.error);
    reader.readAsArrayBuffer(file);
  });
}

// Parse XML string to document, throw if invalid
function parseXML(xmlString) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, 'application/xml');
  if (xmlDoc.querySelector('parsererror')) {
    throw new Error('Invalid XML format');
  }
  return xmlDoc;
}

// Recursively extract all <Claim> elements (depth-first)
function extractAllClaims(xmlDoc) {
  const claims = [];
  function recurse(node) {
    if (!node) return;
    if (node.nodeName === 'Claim') {
      claims.push(node);
    }
    for (const child of node.children) {
      recurse(child);
    }
  }
  recurse(xmlDoc.documentElement);
  return claims;
}

// Map clinicians from Excel workbook:
function mapClinicians(workbook) {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  let data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  console.log('Excel rows parsed:', data.length);
  console.log('First row data sample:', data[0]);

  function findKey(row, possibles) {
    for (const k of Object.keys(row)) {
      const norm = k.trim().toLowerCase();
      if (possibles.includes(norm)) return k;
    }
    return null;
  }

  // We want to find the "Clinician License" column to map keys by license ID
  const licenseKey = findKey(data[0], ['clinician license', 'license', 'license id', 'clinicianlicense']);
  const nameKey = findKey(data[0], ['clinicianname', 'clinician name', 'name']);
  const categoryKey = findKey(data[0], ['category']);
  const privilegesKey = findKey(data[0], ['privileges']);

  if (!licenseKey || !nameKey || !categoryKey || !privilegesKey) {
    console.warn('Could not find all expected columns in Excel. Found keys:', Object.keys(data[0]));
  }

  const map = new Map();
  data.forEach(row => {
    const licenseVal = row[licenseKey]?.toString().trim();
    if (!licenseVal) return; // skip rows without license
    map.set(licenseVal, {
      name: row[nameKey]?.toString().trim() || 'N/A',
      category: row[categoryKey]?.toString().trim() || 'N/A',
      privileges: row[privilegesKey]?.toString().trim() || 'N/A',
    });
  });

  console.log('Clinicians mapped by License:', map.size);
  return map;
}

// Validate claims based on clinician IDs and excel data
function validateClaims(claims, cliniciansMap) {
  const results = [];

  for (const claimEl of claims) {
    // Extract Claim ID for reporting
    const claimID = claimEl.querySelector('ID')?.textContent.trim() || 'N/A';

    // Extract all activities in this claim
    const activities = Array.from(claimEl.querySelectorAll('Activity'));

    activities.forEach(activityEl => {
      const activityID = activityEl.querySelector('ID')?.textContent.trim() || 'N/A';

      const orderingClinID = activityEl.querySelector('OrderingClinician')?.textContent.trim() || 'N/A';
      const performingClinID = activityEl.querySelector('Clinician')?.textContent.trim() || 'N/A';

      // Get clinician details from map
      const orderingClin = cliniciansMap.get(orderingClinID) || {name:'Unknown', category:'Unknown', privileges:'Unknown'};
      const performingClin = cliniciansMap.get(performingClinID) || {name:'Unknown', category:'Unknown', privileges:'Unknown'};

      let validity = '';
      let remarks = '';

      if (orderingClinID === performingClinID) {
        validity = 'Valid';
        remarks = 'Ordering and performing clinicians are identical.';
      } else {
        // Different clinicians, check category
        if (orderingClin.category === performingClin.category) {
          validity = 'Valid';
          remarks = `Different clinicians but same category (${orderingClin.category}).`;
        } else {
          validity = 'Invalid';
          remarks = `Category mismatch: Ordering=${orderingClin.category}, Performing=${performingClin.category}`;
        }
      }

      results.push({
        claimID,
        activityID,
        orderingClinID,
        orderingClinName: orderingClin.name,
        orderingClinCategory: orderingClin.category,
        orderingClinPrivileges: orderingClin.privileges,
        performingClinID,
        performingClinName: performingClin.name,
        performingClinCategory: performingClin.category,
        performingClinPrivileges: performingClin.privileges,
        validity,
        remarks,
      });
    });
  }

  return results;
}

// Render results table in #results
function renderResults(results) {
  if (!results.length) {
    document.getElementById('results').innerHTML = '<p>No activities found in claims.</p>';
    return;
  }

  const rows = results.map(r => `
    <tr>
      <td>${escapeHTML(r.claimID)}</td>
      <td>${escapeHTML(r.activityID)}</td>
      <td>${escapeHTML(r.orderingClinID)}</td>
      <td>${escapeHTML(r.orderingClinName)}</td>
      <td>${escapeHTML(r.orderingClinCategory)}</td>
      <td>${escapeHTML(r.orderingClinPrivileges)}</td>
      <td>${escapeHTML(r.performingClinID)}</td>
      <td>${escapeHTML(r.performingClinName)}</td>
      <td>${escapeHTML(r.performingClinCategory)}</td>
      <td>${escapeHTML(r.performingClinPrivileges)}</td>
      <td>${escapeHTML(r.validity)}</td>
      <td>${escapeHTML(r.remarks)}</td>
    </tr>
  `).join('');

  document.getElementById('results').innerHTML = `
    <table border="1" cellpadding="5" cellspacing="0" class="shared-table">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Activity ID</th>
          <th>Ordering Clinician ID</th>
          <th>Ordering Clinician Name</th>
          <th>Ordering Clinician Category</th>
          <th>Ordering Clinician Privileges</th>
          <th>Performing Clinician ID</th>
          <th>Performing Clinician Name</th>
          <th>Performing Clinician Category</th>
          <th>Performing Clinician Privileges</th>
          <th>Validity</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Escape HTML special characters to avoid injection
function escapeHTML(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\'': return '&#39;';
      default: return m;
    }
  });
}

// Print summary of validation to console
function printSummary(results) {
  let validCount = 0;
  let invalidCount = 0;
  const invalidDetails = [];

  for (const r of results) {
    if (r.validity === 'Valid') validCount++;
    else {
      invalidCount++;
      invalidDetails.push({
        claimID: r.claimID,
        activityID: r.activityID,
        remarks: r.remarks
      });
    }
  }

  console.log(`Clinician License Validation Summary:`);
  console.log(`Total Activities Processed: ${results.length}`);
  console.log(`Valid: ${validCount}`);
  console.log(`Invalid: ${invalidCount}`);

  if (invalidCount) {
    console.log(`Invalid entries details:`);
    invalidDetails.forEach(d => {
      console.log(`- Claim ID: ${d.claimID}, Activity ID: ${d.activityID}, Reason: ${d.remarks}`);
    });
  }
}
