// checker_elig.js

window.addEventListener('DOMContentLoaded', () => {
  // Input and group selectors
  const xmlInput = document.getElementById('xmlFileInput');
  const xlsxInput = document.getElementById('xlsxFileInput');
  const xmlGroup = document.getElementById('xmlReportInputGroup');
  const xlsxGroup = document.getElementById('xlsxReportInputGroup');
  const processBtn = document.getElementById('processBtn');
  const status = document.getElementById('uploadStatus');
  const resultContainer = document.getElementById('results');

  // Radio selectors
  const xmlRadio = document.querySelector('input[name="reportSource"][value="xml"]');
  const xlsxRadio = document.querySelector('input[name="reportSource"][value="xlsx"]');

  // Data holders
  let xmlData = null;
  let xlsxData = null;
  let insuranceLicenses = null;

  // Only these columns from the report upload are relevant
  const REPORT_RELEVANT_COLUMNS = [
    "ClaimID",
    "ClaimDate",
    "OrderDoctor",
    "Clinic",
    "Insurance Company",
    "PatientCardID",
    "FileNo",
    "Clinician License",
    "Opened by/Registration Staff name"
  ];

  function filterReportRow(row) {
    const filtered = {};
    REPORT_RELEVANT_COLUMNS.forEach(col => filtered[col] = row[col] || "");
    return filtered;
  }

  // Swap input groups based on radio button
  function swapInputGroups() {
    if (xmlRadio.checked) {
      xmlGroup.style.display = '';
      xlsxGroup.style.display = 'none';
    } else {
      xmlGroup.style.display = 'none';
      xlsxGroup.style.display = '';
    }
    updateStatus();
  }
  xmlRadio.addEventListener('change', swapInputGroups);
  xlsxRadio.addEventListener('change', swapInputGroups);

  // Load insurance_licenses.json (if present)
  fetch('insurance_licenses.json')
    .then(r => r.json())
    .then(json => {
      insuranceLicenses = json;
      updateStatus();
    })
    .catch(() => {
      insuranceLicenses = null;
    });

  // XLSX parsing
  async function parseExcel(file) {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = e => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          if (!worksheet) throw new Error('No worksheet found in uploaded file.');
          const json = XLSX.utils.sheet_to_json(worksheet, { defval: '', range: 1 });
          resolve(json);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  // XML parsing
  function parseXML(file) {
    return file.text().then(xmlText => {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, "application/xml");
      const claimNodes = xmlDoc.querySelectorAll('Claim');
      const claims = Array.from(claimNodes).map(claim => {
        const claimID = claim.querySelector('ID')?.textContent.trim() || '';
        const memberID = claim.querySelector('MemberID')?.textContent.trim() || '';
        const payerID = claim.querySelector('PayerID')?.textContent.trim() || '';
        const providerID = claim.querySelector('ProviderID')?.textContent.trim() || '';
        const encounterNodes = claim.querySelectorAll('Encounter');
        const encounters = Array.from(encounterNodes).map(enc => ({
          claimID,
          memberID,
          payerID,
          providerID,
          encounterStart: enc.querySelector('Start')?.textContent.trim() || '',
          clinician: enc.querySelector('Clinician')?.textContent.trim() || ''
        }));
        return { claimID, memberID, payerID, providerID, encounters };
      });
      const allEncounters = claims.flatMap(c => c.encounters);
      return { claimsCount: claims.length, encounters: allEncounters };
    });
  }

  // --- XML Mode Validation ---
  function validateEncounters(xmlPayload, insuranceLicenses) {
    const { encounters } = xmlPayload;
    return encounters.map(encounter => {
      const remarks = [];
      // Example checks (expand as needed)
      if (!encounter.claimID) remarks.push('Missing ClaimID');
      if (!encounter.memberID) remarks.push('Missing MemberID');
      // Add more XML-specific validations here

      // Compose details (customize for your XML structure if needed)
      const details = formatXmlDetailsModal(encounter);

      return {
        claimID: encounter.claimID,
        memberID: encounter.memberID,
        payerID: encounter.payerID,
        affiliatedPlan: '', // not available directly
        encounterStart: encounter.encounterStart,
        details,
        eligibilityRequestNumber: null,
        status: '',
        remarks,
        match: encounter,
        matches: [encounter]
      };
    });
  }

  function formatXmlDetailsModal(encounter) {
    const fields = [
      { label: "ClaimID", value: encounter.claimID },
      { label: "MemberID", value: encounter.memberID },
      { label: "PayerID", value: encounter.payerID },
      { label: "ProviderID", value: encounter.providerID },
      { label: "Encounter Start", value: encounter.encounterStart },
      { label: "Clinician", value: encounter.clinician }
    ];
    let table = '<table class="shared-table details-table"><tbody>';
    fields.forEach(f => {
      table += `<tr><th>${f.label}</th><td>${f.value}</td></tr>`;
    });
    table += '</tbody></table>';
    return table;
  }

  // --- XLSX Mode Validation & Output ---
  function validateReportRows(reportRows) {
    // Filter only dental and insurance relevant rows
    const filtered = reportRows.filter(row => {
      const clinic = (row["Clinic"] || "").toUpperCase();
      const insurance = (row["Insurance Company"] || "").toUpperCase();
      return clinic.includes("DENTAL") && (insurance.includes("THIQA") || insurance.includes("DAMAN"));
    });

    return filtered.map((row, idx) => {
      const remarks = [];
      if (!row.ClaimID) remarks.push("Missing ClaimID");
      if (!row.PatientCardID) remarks.push("Missing PatientCardID");
      if (!row["Clinician License"]) remarks.push("Missing Clinician License");
      // ... add other validation as needed

      // Output in similar format as XML output
      return {
        claimID: row.ClaimID,
        memberID: row.PatientCardID,
        payerID: row["Insurance Company"],
        affiliatedPlan: "", // Not available in report
        encounterStart: row.ClaimDate,
        details: formatReportDetailsModal(row),
        eligibilityRequestNumber: row.FileNo || null,
        status: "", // Not available in report
        remarks,
        match: row,
        matches: [row]
      };
    });
  }

  function formatReportDetailsModal(row) {
    const fields = [
      { label: "ClaimID", value: row.ClaimID },
      { label: "ClaimDate", value: row.ClaimDate },
      { label: "OrderDoctor", value: row.OrderDoctor },
      { label: "Clinic", value: row.Clinic },
      { label: "Insurance Company", value: row["Insurance Company"] },
      { label: "PatientCardID", value: row.PatientCardID },
      { label: "FileNo", value: row.FileNo },
      { label: "Clinician License", value: row["Clinician License"] },
      { label: "Opened by/Registration Staff name", value: row["Opened by/Registration Staff name"] }
    ];
    let table = '<table class="shared-table details-table"><tbody>';
    fields.forEach(f => {
      table += `<tr><th>${f.label}</th><td>${f.value}</td></tr>`;
    });
    table += '</tbody></table>';
    return table;
  }

  // --- Table/Modal Rendering ---
  function buildTableContainer(containerId = 'results') {
    const c = document.getElementById(containerId);
    c.innerHTML = `<table class="shared-table">
        <thead><tr>
          <th>#</th>
          <th>ID</th>
          <th>MemberID</th>
          <th>PayerID & Plan</th>
          <th>Encounter Start</th>
          <th>Details</th>
          <th>Status</th>
          <th>Remarks</th>
        </tr></thead>
        <tbody></tbody>
      </table>`;
    return c.querySelector('tbody');
  }

  function setupModal(containerId = 'results') {
    const c = document.getElementById(containerId);
    if (!c.querySelector('#eligibilityModal')) {
      c.insertAdjacentHTML('beforeend', `
        <div id="eligibilityModal" class="modal" style="display:none;">
          <div class="modal-content">
            <span class="close">&times;</span>
            <div id="modalContent" style="white-space: normal;"></div>
          </div>
        </div>
      `);
    }
    const modal = c.querySelector('#eligibilityModal');
    const modalContent = modal.querySelector('#modalContent');
    const closeBtn = modal.querySelector('.close');
    closeBtn.addEventListener('click', () => modal.style.display = 'none');
    window.addEventListener('click', e => {
      if (e.target === modal) modal.style.display = 'none';
    });
    return { modal, modalContent };
  }

  function createRow(r, index, { modal, modalContent }) {
    const row = document.createElement('tr');
    row.classList.add(r.remarks.length ? 'invalid' : 'valid');
    const btn = document.createElement('button');
    btn.textContent = r.eligibilityRequestNumber || 'No Request';
    btn.disabled = !r.eligibilityRequestNumber;
    btn.className = 'details-btn';
    btn.addEventListener('click', () => {
      if (!r.eligibilityRequestNumber) return;
      modalContent.innerHTML = r.details;
      modal.style.display = 'block';
    });
    const tdBtn = document.createElement('td');
    tdBtn.appendChild(btn);

    let payerIDPlan = r.payerID || '';
    if (r.affiliatedPlan) {
      payerIDPlan += ` (${r.affiliatedPlan})`;
    }

    row.innerHTML = `
      <td>${index + 1}</td>
      <td class="wrap-col">${r.claimID}</td>
      <td class="wrap-col">${r.memberID}</td>
      <td class="wrap-col">${payerIDPlan}</td>
      <td>${r.encounterStart}</td>
      <td></td>
      <td>${r.status || ''}</td>
      <td style="white-space: pre-line;">${r.remarks.join('\n')}</td>
    `;
    row.querySelector('td:nth-child(6)').replaceWith(tdBtn);
    return row;
  }

  function renderResults(results, containerId = 'results') {
    const tbody = buildTableContainer(containerId);
    const modalElements = setupModal(containerId);
    results.forEach((r, i) => {
      const row = createRow(r, i, modalElements);
      tbody.appendChild(row);
    });
  }

  function updateStatus() {
    const usingXml = xmlRadio.checked;
    const xmlLoaded = !!xmlData;
    const xlsxLoaded = !!xlsxData;
    const licensesLoaded = !!insuranceLicenses;
    const msgs = [];
    if (usingXml && xmlLoaded) {
      const count = xmlData.claimsCount || 0;
      msgs.push(`${count} Claim${count !== 1 ? 's' : ''} loaded`);
    }
    if (!usingXml && xlsxLoaded) {
      const count = xlsxData.length || 0;
      msgs.push(`${count} XLSX Report row${count !== 1 ? 's' : ''} loaded`);
    }
    if (licensesLoaded) msgs.push('Insurance Licenses loaded');
    status.textContent = msgs.join(', ');
    processBtn.disabled = !((usingXml && xmlLoaded) || (!usingXml && xlsxLoaded));
  }

  // --- File input change handlers ---
  xmlInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading XML…';
    processBtn.disabled = true;
    try {
      xmlData = await parseXML(e.target.files[0]);
    } catch (err) {
      status.textContent = `XML Error: ${err.message}`;
      xmlData = null;
    }
    updateStatus();
  });

  xlsxInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading XLSX…';
    processBtn.disabled = true;
    try {
      let raw = await parseExcel(e.target.files[0]);
      xlsxData = raw.map(filterReportRow);
    } catch (err) {
      status.textContent = `XLSX Error: ${err.message}`;
      xlsxData = null;
    }
    updateStatus();
  });

  // --- Process Button ---
  processBtn.addEventListener('click', async () => {
    if (xmlRadio.checked) {
      if (!xmlData) {
        alert('Please upload an XML report file.');
        return;
      }
      processBtn.disabled = true;
      status.textContent = 'Validating…';
      try {
        const results = validateEncounters(xmlData, insuranceLicenses);
        renderResults(results);
        const validCount = results.filter(r => r.remarks.length === 0).length;
        const totalCount = results.length;
        const percent = totalCount > 0 ? Math.round((validCount / totalCount) * 100) : 0;
        status.textContent = `Valid: ${validCount} / ${totalCount} (${percent}%)`;
      } catch (err) {
        status.textContent = `Validation error: ${err.message}`;
      }
      processBtn.disabled = false;
    } else {
      if (!xlsxData) {
        alert('Please upload an XLSX report file.');
        return;
      }
      processBtn.disabled = true;
      status.textContent = 'Validating…';
      try {
        const results = validateReportRows(xlsxData);
        renderResults(results);
        const validCount = results.filter(r => r.remarks.length === 0).length;
        const totalCount = results.length;
        const percent = totalCount > 0 ? Math.round((validCount / totalCount) * 100) : 0;
        status.textContent = `Valid: ${validCount} / ${totalCount} (${percent}%)`;
      } catch (err) {
        status.textContent = `Validation error: ${err.message}`;
      }
      processBtn.disabled = false;
    }
  });

  // Initial swap
  swapInputGroups();
});
