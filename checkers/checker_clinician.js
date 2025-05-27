//VERKA

document.addEventListener('DOMContentLoaded', () => {
  const xmlInput = document.getElementById('xmlFileInput');
  const excelInput = document.getElementById('excelFileInput');
  const processBtn = document.getElementById('processBtn') || createProcessButton();
  const resultsDiv = document.getElementById('results');
  
  let xmlDoc = null;
  let clinicianMap = null;
  let filesLoading = { xml: false, excel: false };

  // File upload listeners
  xmlInput.addEventListener('change', async () => {
    filesLoading.xml = true;
    resultsDiv.textContent = 'Loading XML...';
    try {
      xmlDoc = await readAndParseXML(xmlInput.files[0]);
      console.log('XML loaded');
      resultsDiv.textContent = 'XML loaded successfully.';
    } catch (e) {
      xmlDoc = null;
      resultsDiv.textContent = `Error loading XML: ${e.message}`;
      console.error(e);
    } finally {
      filesLoading.xml = false;
      toggleProcessButton();
    }
  });

  excelInput.addEventListener('change', async () => {
    filesLoading.excel = true;
    resultsDiv.textContent = 'Loading Excel...';
    try {
      clinicianMap = await readClinicianExcel(excelInput.files[0]);
      console.log('Excel loaded:', clinicianMap.size, 'records');
    } catch (e) {
      clinicianMap = null;
      resultsDiv.textContent = `Error loading Excel: ${e.message}`;
      console.error(e);
    }
    filesLoading.excel = false;
    toggleProcessButton();
  });

  // Enable process button only if both files loaded and not loading
  function toggleProcessButton() {
    processBtn.disabled = filesLoading.xml || filesLoading.excel || !xmlDoc || !clinicianMap;
    if (!processBtn.disabled) resultsDiv.textContent = 'Ready to process. Click "Process Files".';
  }

  processBtn.addEventListener('click', () => {
    if (!xmlDoc || !clinicianMap) {
      alert('Both XML and Excel files must be loaded before processing.');
      return;
    }
    processClaims(xmlDoc, clinicianMap);
  });

  // Read & parse XML
  async function readAndParseXML(file) {
    const text = await file.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid XML format.');
    return doc;
  }

  // Read Excel and map clinicians by License ID
  async function readClinicianExcel(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read Excel file.'));
      reader.onload = e => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });

          // Build Map keyed by Clinician License for quick lookup
          const map = new Map();
          json.forEach(row => {
            if (row['Clinician License']) {
              map.set(row['Clinician License'].toString().trim(), {
                name: row['Clinician Name'] || 'Unknown',
                privileges: row['Privileges'] || 'Unknown',
                category: row['Category'] || 'Unknown',
              });
            }
          });

          resolve(map);
        } catch (err) {
          reject(err);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Process claims from XML with clinician validation
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

        const valid = validateClinicians(orderingId, performingId, orderingData, performingData);
        const remarks = generateRemarks(orderingId, performingId, orderingData, performingData, valid);

        results.push({
          claimId, activityId,
          orderingId, orderingName: orderingData.name, orderingPrivileges: orderingData.privileges, orderingCategory: orderingData.category,
          performingId, performingName: performingData.name, performingPrivileges: performingData.privileges, performingCategory: performingData.category,
          valid, remarks
        });
      });
    });

    renderResults(results);
    logSummary(results);
  }

  // Extract text content helper
  function getText(parent, tag) {
    const el = parent.querySelector(tag);
    return el?.textContent?.trim() ?? '';
  }

  // Return default clinician data for missing entries
  function defaultClinicianData() {
    return { name: 'Unknown', privileges: 'Unknown', category: 'Unknown' };
  }

  // Validation per criteria
  function validateClinicians(orderingId, performingId, orderingData, performingData) {
    if (!orderingId || !performingId) return false;
    if (orderingId === performingId) return true; // same clinician

    // Different clinicians: categories must match
    if (orderingData.category !== performingData.category) return false;

    // Add additional specialization checks here if available
    return true;
  }

  // Generate remarks for invalid rows
  function generateRemarks(orderingId, performingId, orderingData, performingData, valid) {
    if (valid) return '';
    if (!orderingId || !performingId) return 'Missing clinician IDs.';
    if (orderingData.category !== performingData.category) {
      return `Category mismatch: Ordering(${orderingData.category}), Performing(${performingData.category})`;
    }
    return 'Invalid clinician data.';
  }

  // Render results table
 function renderResults(results) {
    const resultsDiv = document.getElementById('results');
    if (!results.length) {
      resultsDiv.innerHTML = '<p>No clinician activity found in the XML.</p>';
      return;
    }
  
    // Build table header
    let html = `
      <table>
        <thead>
          <tr>
            <th>Claim ID</th>
            <th>Activity ID</th>
            <th>Ordering Clinician ID</th>
            <th>Ordering Clinician Name</th>
            <th>Ordering Privileges</th>
            <th>Ordering Category</th>
            <th>Performing Clinician ID</th>
            <th>Performing Clinician Name</th>
            <th>Performing Privileges</th>
            <th>Performing Category</th>
            <th>Validation Status</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
    `;
  
    results.forEach(item => {
      const rowClass = item.valid ? 'valid' : 'invalid';
      html += `
        <tr class="${rowClass}">
          <td>${escapeHtml(item.claimId)}</td>
          <td>${escapeHtml(item.activityId)}</td>
          <td>${escapeHtml(item.orderingId)}</td>
          <td>${escapeHtml(item.orderingName)}</td>
          <td>${escapeHtml(item.orderingPrivileges)}</td>
          <td>${escapeHtml(item.orderingCategory)}</td>
          <td>${escapeHtml(item.performingId)}</td>
          <td>${escapeHtml(item.performingName)}</td>
          <td>${escapeHtml(item.performingPrivileges)}</td>
          <td>${escapeHtml(item.performingCategory)}</td>
          <td>${escapeHtml(item.valid ? 'Valid' : 'Invalid')}</td>
          <td>${escapeHtml(item.remarks)}</td>
        </tr>
      `;
    });
  
    html += `
        </tbody>
      </table>
    `;
  
    resultsDiv.innerHTML = html;
  }

  
  // Helper function to escape HTML entities to avoid XSS or rendering issues
  function escapeHtml(text) {
    if (!text) return '';
    return text
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  // Log summary counts
  function logSummary(results) {
    const total = results.length;
    const validCount = results.filter(r => r.valid).length;
    const invalidCount = total - validCount;
    console.log(`Processing complete. Total activities: ${total}, Valid: ${validCount}, Invalid: ${invalidCount}`);
  }

  // Create a process button if missing
  function createProcessButton() {
    const btn = document.createElement('button');
    btn.id = 'processBtn';
    btn.textContent = 'Process Files';
    btn.disabled = true;
    document.getElementById('fileInputs').appendChild(btn);
    return btn;
  }
});
