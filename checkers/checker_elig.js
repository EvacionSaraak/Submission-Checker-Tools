// checker_elig.js

window.addEventListener('DOMContentLoaded', () => {
  // Input/group selectors
  const xmlInput = document.getElementById('xmlFileInput');
  const xlsInput = document.getElementById('xlsxFileInput');
  const eligInput = document.getElementById('eligibilityFileInput');
  const xmlGroup = document.getElementById('xmlReportInputGroup');
  const xlsGroup = document.getElementById('xlsxReportInputGroup');
  const eligGroup = document.getElementById('eligibilityInputGroup');
  const processBtn = document.getElementById('processBtn');
  const status = document.getElementById('uploadStatus');

  // Radio selectors
  const xmlRadio = document.querySelector('input[name="reportSource"][value="xml"]');
  const xlsRadio = document.querySelector('input[name="reportSource"][value="xlsx"]');

  // Data holders
  let xmlData = null;
  let xlsData = null;
  let eligData = null;
  let insuranceLicenses = null;

  // Utility: Normalize row keys for robust XLS/XLSX compatibility
  function normalizeRow(row) {
    const normalized = {};
    Object.keys(row).forEach(k => {
      normalized[k.replace(/\s+/g, ' ').trim().toUpperCase()] = row[k];
    });
    return normalized;
  }

  // These are the normalized header names (all uppercase, spaces normalized)
  const CLINIC_KEY = "CLINIC";
  const INSCO_KEY = "INSURANCE COMPANY";
  const PATIENTCARD_KEY = "PATIENTCARDID";
  const CLAIMID_KEY = "CLAIMID";
  const CLINICIAN_KEY = "CLINICIAN LICENSE";
  const CLAIMDATE_KEY = "CLAIMDATE";
  const FILENO_KEY = "FILENO";

  // Swap input groups based on report radio
  function swapInputGroups() {
    if (xmlRadio.checked) {
      xmlGroup.style.display = '';
      xlsGroup.style.display = 'none';
    } else {
      xmlGroup.style.display = 'none';
      xlsGroup.style.display = '';
    }
    updateStatus();
  }
  xmlRadio.addEventListener('change', swapInputGroups);
  xlsRadio.addEventListener('change', swapInputGroups);

  // Always show eligibility group (never swaps)
  eligGroup.style.display = '';

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

  // XLS/XLSX parsing (SheetJS supports both)
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

  // Find in eligibility by card number (ignoring date, whitespace, dashes)
  function findEligibilityMatchesByCard(memberID, eligRows) {
    const cardCol = 'Card Number / DHA Member ID';
    return eligRows.filter(row => {
      const xlsCard = (row[cardCol] || '').replace(/[-\s]/g, '').trim();
      return xlsCard && xlsCard === (memberID || '').replace(/[-\s]/g, '').trim();
    });
  }

  // Validation for XML mode
  function validateXmlWithEligibility(xmlPayload, eligRows, insuranceLicenses) {
    const { encounters } = xmlPayload;
    return encounters.map(encounter => {
      const matches = findEligibilityMatchesByCard(encounter.memberID, eligRows);
      const remarks = [];
      let match = null;
      let status = '';
      let affiliatedPlan = '';

      if (matches.length === 0) {
        remarks.push('No eligibility rows found for card number');
      } else {
        match = matches[0];
        status = match['Status'] || '';
        if ((status || '').toLowerCase() !== 'eligible') remarks.push(`Status not eligible (${status})`);
        const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/[-\s]/g, '').trim();
        if (excelCard && (encounter.memberID || '').replace(/[-\s]/g, '').trim() !== excelCard) {
          remarks.push('Card Number mismatch between XML and Eligibility');
        }
        const encounterClinician = (encounter.clinician || '').trim();
        const eligClinician = (match['Clinician'] || match['Clinician Name'] || '').trim();
        if (encounterClinician && eligClinician && encounterClinician !== eligClinician) {
          remarks.push(`Clinician mismatch (XML: "${encounterClinician}", Excel: "${eligClinician}")`);
        }
        const excelProviderLicense = (match['Provider License'] || '').trim();
        const claimProviderID = (encounter.providerID || '').trim();
        if (claimProviderID && excelProviderLicense && claimProviderID !== excelProviderLicense) {
          remarks.push(`ProviderID does not match Provider License in eligibility (XML: "${claimProviderID}", Excel: "${excelProviderLicense}")`);
        }
      }

      // Optionally, add insurance license validation
      return {
        claimID: encounter.claimID,
        memberID: encounter.memberID,
        payerID: encounter.payerID,
        affiliatedPlan,
        encounterStart: encounter.encounterStart,
        details: match ? formatEligibilityDetailsModal(match) : '',
        eligibilityRequestNumber: match?.['Eligibility Request Number'] || null,
        status,
        remarks,
        match,
        matches
      };
    });
  }

  // Validation for XLS (XLSX) mode
  function validateXlsWithEligibility(reportRows, eligRows) {
    // Normalize all rows for robust header matching
    const normalizedRows = reportRows.map(normalizeRow);

    // Filter only dental and insurance relevant rows, robust to whitespace/casing
    const filtered = normalizedRows.filter(row => {
      const clinic = (row[CLINIC_KEY] || "").toUpperCase().replace(/\s+/g, '');
      const insurance = (row[INSCO_KEY] || "").toUpperCase().replace(/\s+/g, '');
      return clinic.includes("DENTAL") && (insurance.includes("THIQA") || insurance.includes("DAMAN"));
    });

    return filtered.map(row => {
      const matches = findEligibilityMatchesByCard(row[PATIENTCARD_KEY], eligRows);
      const remarks = [];
      let match = null;
      let status = '';
      let affiliatedPlan = '';

      if (!row[CLAIMID_KEY]) remarks.push("Missing ClaimID");
      if (!row[PATIENTCARD_KEY]) remarks.push("Missing PatientCardID");
      if (!row[CLINICIAN_KEY]) remarks.push("Missing Clinician License");

      if (matches.length === 0) {
        remarks.push('No eligibility rows found for card number');
      } else {
        match = matches[0];
        status = match['Status'] || '';
        if ((status || '').toLowerCase() !== 'eligible') remarks.push(`Status not eligible (${status})`);
        const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/[-\s]/g, '').trim();
        if (excelCard && (row[PATIENTCARD_KEY] || '').replace(/[-\s]/g, '').trim() !== excelCard) {
          remarks.push('Card Number mismatch between XLS and Eligibility');
        }
        const reportClinician = (row[CLINICIAN_KEY] || '').trim();
        const eligClinician = (match['Clinician'] || match['Clinician Name'] || '').trim();
        if (reportClinician && eligClinician && reportClinician !== eligClinician) {
          remarks.push(`Clinician mismatch (XLS: "${reportClinician}", Eligibility: "${eligClinician}")`);
        }
      }

      return {
        claimID: row[CLAIMID_KEY],
        memberID: row[PATIENTCARD_KEY],
        payerID: row[INSCO_KEY],
        affiliatedPlan,
        encounterStart: row[CLAIMDATE_KEY],
        details: match ? formatEligibilityDetailsModal(match) : formatReportDetailsModal(row),
        eligibilityRequestNumber: match?.['Eligibility Request Number'] || row[FILENO_KEY] || null,
        status,
        remarks,
        match,
        matches
      };
    });
  }

  // Details modal formatting
  function formatEligibilityDetailsModal(match) {
    const fields = [
      { label: 'Eligibility Request Number', value: match['Eligibility Request Number'] || '' },
      { label: 'Payer Name', value: match['Payer Name'] || '' },
      { label: 'Service Category', value: match['Service Category'] || '' },
      { label: 'Consultation Status', value: match['Consultation Status'] || '' },
      { label: 'Clinician', value: match['Clinician'] || '' },
      { label: 'Clinician Name', value: match['Clinician Name'] || '' },
      { label: 'Authorization Number', value: match['Authorization Number'] || '' },
      { label: 'EID', value: match['EID'] || '' },
      { label: 'Member Name', value: match['Member Name'] || '' },
      { label: 'Ordered On', value: match['Ordered On'] || '' },
      { label: 'Answered On', value: match['Answered On'] || '' },
      { label: 'EffectiveDate', value: match['EffectiveDate'] || match['Effective Date'] || '' },
      { label: 'ExpiryDate', value: match['ExpiryDate'] || match['Expiry Date'] || '' },
      { label: 'Package Name', value: match['Package Name'] || '' },
      { label: 'Network Billing Reference', value: match['Network Billing Reference'] || '' }
    ];
    let table = '<table class="shared-table details-table"><tbody>';
    fields.forEach(f => { table += `<tr><th>${f.label}</th><td>${f.value}</td></tr>`; });
    table += '</tbody></table>';
    return table;
  }

  function formatReportDetailsModal(row) {
    const fields = [
      { label: "ClaimID", value: row[CLAIMID_KEY] },
      { label: "ClaimDate", value: row[CLAIMDATE_KEY] },
      { label: "OrderDoctor", value: row["ORDERDOCTOR"] },
      { label: "Clinic", value: row[CLINIC_KEY] },
      { label: "Insurance Company", value: row[INSCO_KEY] },
      { label: "PatientCardID", value: row[PATIENTCARD_KEY] },
      { label: "FileNo", value: row[FILENO_KEY] },
      { label: "Clinician License", value: row[CLINICIAN_KEY] },
      { label: "Opened by/Registration Staff name", value: row["OPENED BY/REGISTRATION STAFF NAME"] }
    ];
    let table = '<table class="shared-table details-table"><tbody>';
    fields.forEach(f => { table += `<tr><th>${f.label}</th><td>${f.value}</td></tr>`; });
    table += '</tbody></table>';
    return table;
  }

  // Table/Modal rendering
  function buildTableContainer(containerId = 'results') {
    const c = document.getElementById(containerId);
    c.innerHTML = `<table class="shared-table">
        <thead><tr>
          <th>#</th>
          <th>ID</th>
          <th>MemberID</th>
          <th>PayerID & Plan</th>
          <th>Encounter Start</th>
          <th>Eligibility Details</th>
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
    btn.disabled = !r.eligibilityRequestNumber && !r.details;
    btn.className = 'details-btn';
    btn.addEventListener('click', () => {
      if (!r.details) return;
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
      <td>${r.encounterStart || ''}</td>
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
    const xlsLoaded = !!xlsData;
    const eligLoaded = !!eligData;
    const licensesLoaded = !!insuranceLicenses;
    const msgs = [];
    if (usingXml && xmlLoaded) {
      const count = xmlData.encounters ? xmlData.encounters.length : 0;
      msgs.push(`${count} Claim${count !== 1 ? 's' : ''} loaded`);
    }
    if (!usingXml && xlsLoaded) {
      const count = xlsData.length || 0;
      msgs.push(`${count} XLS Report row${count !== 1 ? 's' : ''} loaded`);
    }
    if (eligLoaded) {
      const count = eligData.length || 0;
      msgs.push(`${count} Eligibility row${count !== 1 ? 's' : ''} loaded`);
    }
    if (licensesLoaded) msgs.push('Insurance Licenses loaded');
    status.textContent = msgs.join(', ');
    processBtn.disabled = !((usingXml && xmlLoaded && eligLoaded) || (!usingXml && xlsLoaded && eligLoaded));
  }

  // File input handlers
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

  xlsInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading XLS…';
    processBtn.disabled = true;
    try {
      let raw = await parseExcel(e.target.files[0]);
      xlsData = raw;
    } catch (err) {
      status.textContent = `XLS Error: ${err.message}`;
      xlsData = null;
    }
    updateStatus();
  });

  eligInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading Eligibility XLSX…';
    processBtn.disabled = true;
    try {
      eligData = await parseExcel(e.target.files[0]);
    } catch (err) {
      status.textContent = `Eligibility XLSX Error: ${err.message}`;
      eligData = null;
    }
    updateStatus();
  });

  // Process
  processBtn.addEventListener('click', async () => {
    if (xmlRadio.checked) {
      if (!xmlData || !eligData) {
        alert('Please upload both XML report and Eligibility XLSX.');
        return;
      }
      processBtn.disabled = true;
      status.textContent = 'Validating…';
      try {
        const results = validateXmlWithEligibility(xmlData, eligData, insuranceLicenses);
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
      if (!xlsData || !eligData) {
        alert('Please upload both XLS report and Eligibility XLSX.');
        return;
      }
      processBtn.disabled = true;
      status.textContent = 'Validating…';
      try {
        const results = validateXlsWithEligibility(xlsData, eligData);
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
