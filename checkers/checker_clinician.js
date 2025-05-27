//VERKA 3

// Additional global variable to hold Open Jet XLSX clinician list
let openJetClinicianList = [];

// References to DOM elements
const xmlInput = document.getElementById('xmlFileInput');
const excelInput = document.getElementById('excelFileInput');
const openJetInput = document.getElementById('openJetFileInput');
const resultsDiv = document.getElementById('results');
const processBtn = document.getElementById('processBtn');

// File loading flags
const filesLoading = {
  xml: true,
  excel: true,
};

// Event listener: XML file
if (xmlInput) {
  xmlInput.addEventListener('change', async () => {
    resultsDiv.textContent = 'Loading XML...';
    try {
      const file = xmlInput.files[0];
      const text = await file.text();
      window.xmlDoc = new DOMParser().parseFromString(text, 'text/xml');
      filesLoading.xml = false;
      resultsDiv.textContent = 'XML loaded.';
    } catch (e) {
      resultsDiv.textContent = `Error loading XML: ${e.message}`;
      console.error(e);
    }
    toggleProcessButton();
  });
}

// Event listener: Excel file (clinician privileges)
if (excelInput) {
  excelInput.addEventListener('change', async () => {
    resultsDiv.textContent = 'Loading Excel...';
    try {
      const file = excelInput.files[0];
      const data = new Uint8Array(await file.arrayBuffer());
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[1]];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      window.clinicianMap = new Map();
      json.forEach(row => {
        const id = row['Clinician ID']?.toString().trim();
        if (id) {
          window.clinicianMap.set(id, {
            name: row['Clinician Name'] || '',
            category: row['Clinician Category'] || '',
            privileges: row['Activity Group'] || ''
          });
        }
      });

      filesLoading.excel = false;
      resultsDiv.textContent = 'Excel loaded.';
    } catch (e) {
      resultsDiv.textContent = `Error loading Excel: ${e.message}`;
      console.error(e);
    }
    toggleProcessButton();
  });
}

// Event listener: Open Jet file
if (openJetInput) {
  openJetInput.addEventListener('change', async () => {
    resultsDiv.textContent = 'Loading Open Jet XLSX...';
    try {
      openJetClinicianList = await readOpenJetExcel(openJetInput.files[0]);
      console.log('Open Jet XLSX loaded:', openJetClinicianList.length, 'records');
      resultsDiv.textContent = 'All files loaded. Ready to process.';
    } catch (e) {
      openJetClinicianList = [];
      resultsDiv.textContent = `Error loading Open Jet XLSX: ${e.message}`;
      console.error(e);
    }
    toggleProcessButton();
  });
}

// Enable process button when all inputs are loaded
function toggleProcessButton() {
  processBtn.disabled = filesLoading.xml || filesLoading.excel || !xmlDoc || !clinicianMap || openJetClinicianList.length === 0;
  if (!processBtn.disabled) resultsDiv.textContent = 'Ready to process. Click "Process Files".';
}

// Read Open Jet XLSX
async function readOpenJetExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read Open Jet Excel file.'));
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        resolve(json.map(row => row['Clinician']?.toString().trim()).filter(Boolean));
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

// Create default clinician data
function defaultClinicianData() {
  return { name: 'N/A', category: 'N/A', privileges: 'N/A' };
}

// Main validation logic
function processClaims(xmlDoc, clinicianMap) {
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

      if (!openJetClinicianList.includes(performingId)) {
        remarksList.push('Performing Clinician mismatch with XLSX');
      }
      if (!openJetClinicianList.includes(orderingId)) {
        remarksList.push('Ordering Clinician mismatch with XLSX');
      }

      const valid = validateClinicians(orderingId, performingId, orderingData, performingData);
      if (!valid && !remarksList.length) {
        remarksList.push(generateRemarks(orderingId, performingId, orderingData, performingData, valid));
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
}

// Helper to extract text content from tag
function getText(parent, tag) {
  const el = parent.getElementsByTagName(tag)[0];
  return el ? el.textContent.trim() : '';
}

// Validate clinician compatibility
function validateClinicians(orderingId, performingId, orderingData, performingData) {
  return orderingId === performingId || orderingData.category === performingData.category;
}

// Generate remarks
function generateRemarks(orderingId, performingId, orderingData, performingData, valid) {
  return `Category mismatch: Ordering (${orderingData.category}) vs Performing (${performingData.category})`;
}

// Render results in a table
function renderResults(results) {
  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>Claim ID</th>
        <th>Activity ID</th>
        <th>Clinicians</th>
        <th>Privileges</th>
        <th>Categories</th>
        <th>Valid</th>
        <th>Remarks</th>
      </tr>
    </thead>
    <tbody>
      ${results.map(r => `
        <tr>
          <td>${r.claimId}</td>
          <td>${r.activityId}</td>
          <td style="white-space: pre-line">${r.clinicianInfo}</td>
          <td style="white-space: pre-line">${r.privilegesInfo}</td>
          <td style="white-space: pre-line">${r.categoryInfo}</td>
          <td>${r.valid ? '✔️' : '❌'}</td>
          <td>${r.remarks}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
  resultsDiv.innerHTML = '';
  resultsDiv.appendChild(table);
}

// Log summary (optional)
function logSummary(results) {
  const validCount = results.filter(r => r.valid).length;
  const total = results.length;
  console.log(`Validation completed: ${validCount}/${total} valid.`);
}
