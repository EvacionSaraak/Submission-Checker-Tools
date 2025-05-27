// Elements
const xmlInput = document.getElementById('xmlFileInput');
const excelInput = document.getElementById('excelFileInput');
const resultsDiv = document.getElementById('results');
const processBtn = document.createElement('button');
processBtn.textContent = 'Process Files';
processBtn.disabled = true;
document.getElementById('fileInputs').appendChild(processBtn);

let xmlDoc = null;
let clinicianMap = null;
let loadingExcel = false;
let loadingXML = false;

xmlInput.addEventListener('change', async (e) => {
  loadingXML = true;
  updateStatus('Loading XML...');
  try {
    xmlDoc = await loadXMLFile(e.target.files[0]);
    console.log('XML loaded successfully.');
    loadingXML = false;
    updateStatus('');
    enableProcessIfReady();
  } catch (err) {
    loadingXML = false;
    updateStatus(`Error loading XML: ${err.message}`);
    console.error(err);
  }
});

excelInput.addEventListener('change', async (e) => {
  loadingExcel = true;
  updateStatus('Loading Excel...');
  try {
    clinicianMap = await loadExcelFile(e.target.files[0]);
    console.log('Excel loaded successfully. Clinician records:', Object.keys(clinicianMap).length);
    loadingExcel = false;
    updateStatus('');
    enableProcessIfReady();
  } catch (err) {
    loadingExcel = false;
    updateStatus(`Error loading Excel: ${err.message}`);
    console.error(err);
  }
});

processBtn.addEventListener('click', () => {
  if (!xmlDoc || !clinicianMap) {
    updateStatus('Both files must be loaded before processing.');
    return;
  }
  updateStatus('Processing claims...');
  const results = processClaims(xmlDoc, clinicianMap);
  renderResults(results);
  updateStatus(`Processing complete. Valid: ${results.validCount}, Invalid: ${results.invalidCount}`);
  console.log(`Processing complete. Valid: ${results.validCount}, Invalid: ${results.invalidCount}`);
  processBtn.disabled = true;
});

function updateStatus(msg) {
  resultsDiv.innerHTML = `<p>${msg}</p>`;
}

function enableProcessIfReady() {
  processBtn.disabled = !(xmlDoc && clinicianMap && !loadingExcel && !loadingXML);
}

// --- File loaders ---

function loadXMLFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(e.target.result, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('Invalid XML format');
        resolve(doc);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Error reading XML file'));
    reader.readAsText(file);
  });
}

function loadExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = ((e.loaded / e.total) * 100).toFixed(2);
        updateStatus(`Loading Excel: ${percent}%`);
      }
    };
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
        const map = buildClinicianMap(jsonData);
        resolve(map);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Error reading Excel file'));
    reader.readAsArrayBuffer(file);
  });
}

function buildClinicianMap(data) {
  // Expected columns: Clinician License, Clinician Name, Privileges, Category
  const map = {};
  data.forEach(row => {
    const license = (row['Clinician License'] || '').toString().trim();
    if (!license) return; // skip empty
    map[license] = {
      name: (row['Clinician Name'] || 'Unknown').toString().trim(),
      privileges: (row['Privileges'] || 'Unknown').toString().trim(),
      category: (row['Category'] || 'Unknown').toString().trim()
    };
  });
  return map;
}

// --- Main processing ---

function processClaims(xmlDoc, clinicianMap) {
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  const results = [];
  let validCount = 0, invalidCount = 0;

  for (const claim of claims) {
    const activities = Array.from(claim.getElementsByTagName('Activity'));
    for (const act of activities) {
      const orderingId = (act.querySelector('OrderingClinician')?.textContent || '').trim();
      const performingId = (act.querySelector('Clinician')?.textContent || '').trim();
      if (!orderingId && !performingId) continue; // skip if no clinicians

      const validation = validateClinicians(orderingId, performingId, clinicianMap);

      results.push({
        claimId: claim.querySelector('ID')?.textContent || 'N/A',
        activityId: act.querySelector('ID')?.textContent || 'N/A',
        orderingId,
        performingId,
        orderingName: validation.orderingData?.name || 'Unknown',
        performingName: validation.performingData?.name || 'Unknown',
        orderingPrivileges: validation.orderingData?.privileges || 'Unknown',
        performingPrivileges: validation.performingData?.privileges || 'Unknown',
        valid: validation.valid,
        remarks: validation.remarks || ''
      });

      if (validation.valid) validCount++;
      else invalidCount++;
    }
  }
  return { results, validCount, invalidCount };
}

function validateClinicians(orderingId, performingId, clinicianMap) {
  if (!orderingId || !performingId) {
    return {
      valid: false,
      remarks: 'Missing clinician ID(s)',
      orderingData: clinicianMap[orderingId] || null,
      performingData: clinicianMap[performingId] || null
    };
  }

  const orderingData = clinicianMap[orderingId] || { name: 'Unknown', privileges: 'Unknown', category: 'Unknown' };
  const performingData = clinicianMap[performingId] || { name: 'Unknown', privileges: 'Unknown', category: 'Unknown' };

  if (orderingId === performingId) {
    return {
      valid: true,
      remarks: '',
      orderingData,
      performingData
    };
  } else {
    if (orderingData.category === performingData.category && orderingData.category !== 'Unknown' && performingData.category !== 'Unknown') {
      return {
        valid: true,
        remarks: '',
        orderingData,
        performingData
      };
    } else {
      return {
        valid: false,
        remarks: `Category mismatch: Ordering(${orderingData.category}), Performing(${performingData.category})`,
        orderingData,
        performingData
      };
    }
  }
}

// --- Rendering ---

function renderResults({ results, validCount, invalidCount }) {
  if (results.length === 0) {
    resultsDiv.innerHTML = '<p>No clinician activity data found.</p>';
    return;
  }

  const rowsHtml = results.map(r => `
    <tr>
      <td>${escapeHtml(r.claimId)}</td>
      <td>${escapeHtml(r.activityId)}</td>
      <td>${escapeHtml(r.orderingId)}</td>
      <td>${escapeHtml(r.orderingName)}</td>
      <td>${escapeHtml(r.orderingPrivileges)}</td>
      <td>${escapeHtml(r.performingId)}</td>
      <td>${escapeHtml(r.performingName)}</td>
      <td>${escapeHtml(r.performingPrivileges)}</td>
      <td>${r.valid ? 'Valid' : '<span style="color:red;">Invalid</span>'}</td>
      <td>${escapeHtml(r.remarks)}</td>
    </tr>
  `).join('');

  resultsDiv.innerHTML = `
    <table class="shared-table" border="1" cellpadding="5" cellspacing="0">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Activity ID</th>
          <th>Ordering Clinician ID</th>
          <th>Ordering Clinician Name</th>
          <th>Ordering Privileges</th>
          <th>Performing Clinician ID</th>
          <th>Performing Clinician Name</th>
          <th>Performing Privileges</th>
          <th>Validity</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr>
          <td colspan="10" style="font-weight:bold;">
            Valid: ${validCount}, Invalid: ${invalidCount}
          </td>
        </tr>
      </tfoot>
    </table>
  `;
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}
