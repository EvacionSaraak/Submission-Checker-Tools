document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
});

// Shared state
const state = {
  xmlDoc: null,
  clinicianData: null
};

function setupEventListeners() {
  document.getElementById('xmlFileInput')
    .addEventListener('change', handleXmlUpload);

  document.getElementById('excelFileInput')
    .addEventListener('change', handleExcelUpload);
}

// ===== File Handlers =====

async function handleXmlUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return renderMessage('Please upload a valid XML file.');

  try {
    const xmlText = await file.text();
    state.xmlDoc = parseXml(xmlText);
    tryRenderResults();
  } catch (err) {
    state.xmlDoc = null;
    renderMessage(`Error parsing XML: ${err.message}`);
  }
}

async function handleExcelUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return renderMessage('Please upload a valid Excel file.');

  try {
    state.clinicianData = await parseExcel(file);
    tryRenderResults();
  } catch (err) {
    state.clinicianData = null;
    renderMessage(`Error parsing Excel: ${err.message}`);
  }
}

// ===== Parsing =====

function parseXml(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid XML format.');
  }
  return doc;
}

async function parseExcel(file) {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

// ===== Processing =====

function tryRenderResults() {
  if (!state.xmlDoc || !state.clinicianData) {
    renderMessage('Waiting for both XML and Excel files...');
    return;
  }

  const claims = extractClaimsFromXml(state.xmlDoc);
  const enrichedClaims = enrichClaimsWithClinicians(claims, state.clinicianData);
  renderResults(enrichedClaims);
}

function extractClaimsFromXml(xmlDoc) {
  return Array.from(xmlDoc.getElementsByTagName('Claim')).map(el => {
    const get = sel => el.querySelector(sel)?.textContent.trim() ?? 'N/A';
    return {
      id: get('ID'),
      patient: get('PatientID'),
      clinician: el.querySelector('Activity')?.querySelector('Clinician')?.textContent.trim() ?? 'N/A',
      amount: get('Net')
    };
  });
}

function enrichClaimsWithClinicians(claims, clinicians) {
  const map = {};
  clinicians.forEach(c => {
    const key = (c.ClinicianName || '').toLowerCase();
    if (key) map[key] = c;
  });

  return claims.map(claim => {
    const key = claim.clinician.toLowerCase();
    const clinicianInfo = map[key] || null;
    return {
      ...claim,
      clinicianInfo,
      clinicianValid: clinicianInfo ? 'Valid' : 'Not found in Excel'
    };
  });
}

// ===== UI Rendering =====

function renderResults(data) {
  if (!data.length) {
    renderMessage('No <Claim> entries found.');
    return;
  }

  const rows = data.map(d => `
    <tr>
      <td>${d.id}</td>
      <td>${d.patient}</td>
      <td>${d.clinician}</td>
      <td>${d.clinicianInfo?.Department || 'N/A'}</td>
      <td>${d.amount}</td>
      <td>${d.clinicianValid}</td>
    </tr>
  `).join('');

  document.getElementById('resultsContainer').innerHTML = `
    <table class="shared-table">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Patient ID</th>
          <th>Clinician</th>
          <th>Department</th>
          <th>Amount</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMessage(msg) {
  document.getElementById('resultsContainer').innerHTML = `<p style="color:red">${msg}</p>`;
}
