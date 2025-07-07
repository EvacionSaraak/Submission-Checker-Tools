window.addEventListener('DOMContentLoaded', () => {
  // Input/group selectors
  const xmlInput = document.getElementById('xmlFileInput');
  const xlsxInput = document.getElementById('xlsxFileInput');
  const eligInput = document.getElementById('eligibilityFileInput');
  const xmlGroup = document.getElementById('xmlReportInputGroup');
  const xlsxGroup = document.getElementById('xlsxReportInputGroup');
  const eligGroup = document.getElementById('eligibilityInputGroup');
  const processBtn = document.getElementById('processBtn');
  const status = document.getElementById('uploadStatus');

  // Radio selectors
  const xmlRadio = document.querySelector('input[name="reportSource"][value="xml"]');
  const xlsxRadio = document.querySelector('input[name="reportSource"][value="xlsx"]');

  // Data holders
  let xmlData = null;
  let xlsxData = null;
  let eligData = null;
  let insuranceLicenses = null;

  const REPORT_RELEVANT_COLUMNS = [
    "ClaimID","ClaimDate","OrderDoctor","Clinic","Insurance Company",
    "PatientCardID","FileNo","Clinician License","Opened by/Registration Staff name"
  ];

  function filterReportRow(row) {
    const filtered = {};
    REPORT_RELEVANT_COLUMNS.forEach(col => filtered[col] = row[col] || "");
    return filtered;
  }

  // Swap input groups based on report radio
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

  // Find in eligibility by card number (ignoring date)
  function findEligibilityMatchesByCard(memberID, eligRows) {
    const cardCol = 'Card Number / DHA Member ID';
    return eligRows.filter(row => {
      const xlsCard = (row[cardCol] || '').replace(/-/g, '').trim();
      return xlsCard === memberID.replace(/-/g, '').trim();
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
        const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/-/g, '').trim();
        if (excelCard && encounter.memberID.replace(/-/g, '').trim() !== excelCard) {
          remarks.push('Card Number mismatch between XML and Excel');
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

  // Validation for XLSX mode
  function validateXlsxWithEligibility(reportRows, eligRows) {
    // Only dental and insurance relevant rows
    const filtered = reportRows.filter(row => {
      const clinic = (row["Clinic"] || "").toUpperCase();
      const insurance = (row["Insurance Company"] || "").toUpperCase();
      return clinic.includes("DENTAL") && (insurance.includes("THIQA") || insurance.includes("DAMAN"));
    });

    return filtered.map(row => {
      const matches = findEligibilityMatchesByCard(row.PatientCardID, eligRows);
      const remarks = [];
      let match = null;
      let status = '';
      let affiliatedPlan = '';

      if (!row.ClaimID) remarks.push("Missing ClaimID");
      if (!row.PatientCardID) remarks.push("Missing PatientCardID");
      if (!row["Clinician License"]) remarks.push("Missing Clinician License");

      if (matches.length === 0) {
        remarks.push('No eligibility rows found for card number');
      } else {
        match = matches[0];
        status = match['Status'] || '';
        if ((status || '').toLowerCase() !== 'eligible') remarks.push(`Status not eligible (${status})`);
        const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/-/g, '').trim();
        if (excelCard && row.PatientCardID.replace(/-/g, '').trim() !== excelCard) {
          remarks.push('Card Number mismatch between XLSX and Eligibility');
        }
        const reportClinician = (row["Clinician License"] || '').trim();
        const eligClinician = (match['Clinician'] || match['Clinician Name'] || '').trim();
        if (reportClinician && eligClinician && reportClinician !== eligClinician) {
          remarks.push(`Clinician mismatch (XLSX: "${reportClinician}", Eligibility: "${eligClinician}")`);
        }
      }

      return {
        claimID: row.ClaimID,
        memberID: row.PatientCardID,
        payerID: row["Insurance Company"],
        affiliatedPlan,
        encounterStart: row.ClaimDate,
        details: match ? formatEligibilityDetailsModal(match) : formatReportDetailsModal(row),
        eligibilityRequestNumber: match?.['Eligibility Request Number'] || row.FileNo || null,
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
    btn.disabled = !r.eligibilityRequestNumber;
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
    const eligLoaded = !!eligData;
    const licensesLoaded = !!insuranceLicenses;
    const msgs = [];
    if (usingXml && xmlLoaded) {
      const count = xmlData.encounters ? xmlData.encounters.length : 0;
      msgs.push(`${count} Claim${count !== 1 ? 's' : ''} loaded`);
    }
    if (!usingXml && xlsxLoaded) {
      const count = xlsxData.length || 0;
      msgs.push(`${count} XLSX Report row${count !== 1 ? 's' : ''} loaded`);
    }
    if (eligLoaded) {
      const count = eligData.length || 0;
      msgs.push(`${count} Eligibility row${count !== 1 ? 's' : ''} loaded`);
    }
    if (licensesLoaded) msgs.push('Insurance Licenses loaded');
    status.textContent = msgs.join(', ');
    processBtn.disabled = !((usingXml && xmlLoaded && eligLoaded) || (!usingXml && xlsxLoaded && eligLoaded));
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
      if (!xlsxData || !eligData) {
        alert('Please upload both XLSX report and Eligibility XLSX.');
        return;
      }
      processBtn.disabled = true;
      status.textContent = 'Validating…';
      try {
        const results = validateXlsxWithEligibility(xlsxData, eligData);
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
