// checker_elig.js

window.addEventListener('DOMContentLoaded', () => {
  const xmlInput = document.getElementById('xmlFileInput');
  const openjetInput = document.getElementById('eligibilityFileInput');
  const reportInput = document.getElementById('reportFileInput');
  const processBtn = document.getElementById('processBtn');
  const resultContainer = document.getElementById('results');
  const status = document.getElementById('uploadStatus');

  // Radio buttons and file input groups
  const eligRadio = document.querySelector('input[name="eligSource"][value="openjet"]');
  const reportRadio = document.querySelector('input[name="eligSource"][value="report"]');
  const openjetGroup = document.getElementById('openjetXLSXInputGroup');
  const reportGroup = document.getElementById('reportXLSXInputGroup');

  let xmlData = null;
  let eligData = null;    // Openjet XLSX
  let reportData = null;  // Report XLSX
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

  // Load insurance_licenses.json from the same folder
  fetch('insurance_licenses.json')
    .then(r => r.json())
    .then(json => {
      insuranceLicenses = json;
      updateStatus();
    })
    .catch(err => {
      console.error('Could not load insurance_licenses.json:', err);
      insuranceLicenses = null;
    });

  // Parses the uploaded Excel file and returns JSON representation
  async function parseExcel(file) {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = e => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          // For report we don't care about sheet name, just get the first
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          if (!worksheet) {
            throw new Error('No worksheet found in uploaded file.');
          }
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

  // Parses the uploaded XML file and extracts all claims and encounters
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

  // Returns all eligibility rows matching the card number (ignores date)
  function findEligibilityMatchesByCard(memberID, eligRows) {
    const cardCol = 'Card Number / DHA Member ID';
    return eligRows.filter(row => {
      const xlsCard = (row[cardCol] || '').replace(/-/g, '').trim();
      return xlsCard === memberID.replace(/-/g, '').trim();
    });
  }

  // Finds the affiliated Plan for a given payerID and Payer Name using insuranceLicenses
  function getAffiliatedPlan(payerID, payerName, insuranceLicenses) {
    if (!insuranceLicenses || !payerID) return "";
    const possibleLicenses = insuranceLicenses.licenses.filter(l => l.PayerID === payerID);
    for (const lic of possibleLicenses) {
      if (payerName.includes(lic.Plan)) {
        return lic.Plan;
      }
    }
    return "";
  }

  // Validates encounters against eligibility data (ignoring date, returns all matches)
  function validateEncounters(xmlPayload, eligRows, insuranceLicenses) {
    const { encounters } = xmlPayload;
    const usedEligibilityIndices = new Set();

    return encounters.map(encounter => {
      const matches = findEligibilityMatchesByCard(encounter.memberID, eligRows)
        .filter(match => !usedEligibilityIndices.has(eligRows.indexOf(match)));

      const remarks = [];
      let status = '';
      let match = null;
      let affiliatedPlan = "";

      // --- MemberID error checks ---
      const memberIdRaw = encounter.memberID || '';
      if (/^\s+|\s+$/.test(memberIdRaw)) { remarks.push('MemberID has leading or trailing whitespace'); }
      if (/^0\d+/.test(memberIdRaw)) { remarks.push('MemberID has leading zeroes'); }
      if (matches.length === 0) {
        remarks.push('No eligibility rows found for card number');
      } else {
        match = matches[0];
        usedEligibilityIndices.add(eligRows.indexOf(match));

        status = match['Status'] || '';
        if ((status || '').toLowerCase() !== 'eligible') remarks.push(`Status not eligible (${status})`);
        const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/-/g, '').trim();
        if (excelCard && encounter.memberID.replace(/-/g, '').trim() !== excelCard) {
          remarks.push('Card Number mismatch between XML and Excel');
        }

        // --- Clinician match check ---
        const encounterClinician = (encounter.clinician || '').trim();
        const eligClinician = (match['Clinician'] || match['Clinician Name'] || '').trim();
        if (encounterClinician && eligClinician && encounterClinician !== eligClinician) {
          remarks.push(`Clinician mismatch (XML: "${encounterClinician}", Excel: "${eligClinician}")`);
        }

        // --- ProviderID match check ---
        const excelProviderLicense = (match['Provider License'] || '').trim();
        const claimProviderID = (encounter.providerID || '').trim();
        if (claimProviderID && excelProviderLicense && claimProviderID !== excelProviderLicense) {
          remarks.push(`ProviderID does not match Provider License in eligibility (XML: "${claimProviderID}", Excel: "${excelProviderLicense}")`);
        }
      }

      // Insurance license validation
      let foundLicense = null;
      if (insuranceLicenses && match) {
        const payerID = encounter.payerID || '';
        const payerName = match['Payer Name'] || '';
        const possibleLicenses = insuranceLicenses.licenses.filter(l => l.PayerID === payerID);
        for (const lic of possibleLicenses) {
          if (payerName.includes(lic.Plan)) {
            foundLicense = lic;
            affiliatedPlan = lic.Plan;
            break;
          }
        }
        if (!possibleLicenses.length) {
          remarks.push(`No matching license for PayerID: ${payerID}`);
        } else if (!foundLicense) {
          remarks.push(
            `No license Plan for PayerID "${payerID}" matches Payer Name "${payerName}". (Tried: ${possibleLicenses.map(l=>l.Plan).join(", ")})`
          );
        }
      }

      const details = match ? formatEligibilityDetailsModal(match) : '';
      return {
        claimID: encounter.claimID,
        memberID: encounter.memberID,
        payerID: encounter.payerID,
        affiliatedPlan,
        encounterStart: encounter.encounterStart,
        details,
        eligibilityRequestNumber: match?.['Eligibility Request Number'] || null,
        status,
        remarks,
        match,
        matches
      };
    });
  }

  // -- Report Mode: Compare Report XLSX to itself (row validation) --
  // Here we apply: filter to Dental clinic and THIQA/DAMAN insurance, then same result format.
  function validateReportRows(reportRows) {
    // Filter only dental and insurance relevant rows
    const filtered = reportRows.filter(row => {
      const clinic = (row["Clinic"] || "").toUpperCase();
      const insurance = (row["Insurance Company"] || "").toUpperCase();
      return clinic.includes("DENTAL") && (insurance.includes("THIQA") || insurance.includes("DAMAN"));
    });

    return filtered.map((row, idx) => {
      const remarks = [];
      // Example checks: (add more as needed)
      if (!row.ClaimID) remarks.push("Missing ClaimID");
      if (!row.PatientCardID) remarks.push("Missing PatientCardID");
      if (!row.Clinician License) remarks.push("Missing Clinician License");
      // ... add other validation as needed

      // Compose details table as for eligibility
      const details = formatReportDetailsModal(row);

      // Try to mimic the XML result format
      return {
        claimID: row.ClaimID,
        memberID: row.PatientCardID,
        payerID: row["Insurance Company"],
        affiliatedPlan: "", // not available in report
        encounterStart: row.ClaimDate,
        details,
        eligibilityRequestNumber: row.FileNo || null,
        status: "", // not available in report
        remarks,
        match: row,
        matches: [row] // retain structure
      };
    });
  }

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
    fields.forEach(f => {
      table += `<tr><th>${f.label}</th><td>${f.value}</td></tr>`;
    });
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
    fields.forEach(f => {
      table += `<tr><th>${f.label}</th><td>${f.value}</td></tr>`;
    });
    table += '</tbody></table>';
    return table;
  }

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
      if (!r.eligibilityRequestNumber) return;
      modalContent.innerHTML = r.details;
      modal.style.display = 'block';
    });
    const tdBtn = document.createElement('td');
    tdBtn.appendChild(btn);

    // Compose payerID and affiliatedPlan in the same column
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
    const claimsCount = xmlData?.claimsCount || 0;
    const openjetCount = eligData?.length || 0;
    const reportCount = reportData?.length || 0;
    const licensesLoaded = !!insuranceLicenses;
    const usingReport = reportRadio.checked;

    const msgs = [];
    if (claimsCount) msgs.push(`${claimsCount} Claim${claimsCount !== 1 ? 's' : ''} loaded`);
    if (usingReport) {
      if (reportCount) msgs.push(`${reportCount} Report row${reportCount !== 1 ? 's' : ''} loaded`);
    } else {
      if (openjetCount) msgs.push(`${openjetCount} Eligibilit${openjetCount !== 1 ? 'ies' : 'y'} loaded`);
    }
    if (licensesLoaded) msgs.push('Insurance Licenses loaded');

    status.textContent = msgs.join(', ');

    processBtn.disabled = !(
      (usingReport ? reportCount : claimsCount && openjetCount)
      && licensesLoaded
    );
  }

  // File input change handlers
  xmlInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading Claims…';
    processBtn.disabled = true;
    try {
      xmlData = await parseXML(e.target.files[0]);
    } catch (err) {
      status.textContent = `XML Error: ${err.message}`;
      xmlData = null;
    }
    updateStatus();
  });

  openjetInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading Eligibilities…';
    processBtn.disabled = true;
    try {
      eligData = await parseExcel(e.target.files[0]);
    } catch (err) {
      status.textContent = `XLSX Error: ${err.message}`;
      eligData = null;
    }
    updateStatus();
  });

  reportInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading Report XLSX…';
    processBtn.disabled = true;
    try {
      let raw = await parseExcel(e.target.files[0]);
      // Only keep the relevant columns
      reportData = raw.map(filterReportRow);
    } catch (err) {
      status.textContent = `XLSX Error: ${err.message}`;
      reportData = null;
    }
    updateStatus();
  });

  // Radio swap: show/hide file input groups
  document.querySelectorAll('input[name="eligSource"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (reportRadio.checked) {
        reportGroup.style.display = '';
        openjetGroup.style.display = 'none';
      } else {
        reportGroup.style.display = 'none';
        openjetGroup.style.display = '';
      }
      updateStatus();
    });
  });

  processBtn.addEventListener('click', async () => {
    if (reportRadio.checked) {
      // Only need reportData
      if (!reportData) {
        alert('Please upload the required Report XLSX file.');
        return;
      }
      processBtn.disabled = true;
      status.textContent = 'Validating…';
      try {
        const results = validateReportRows(reportData);
        renderResults(results);

        // Validity summary
        const validCount = results.filter(r => r.remarks.length === 0).length;
        const totalCount = results.length;
        const percent = totalCount > 0 ? Math.round((validCount / totalCount) * 100) : 0;
        status.textContent = `Valid: ${validCount} / ${totalCount} (${percent}%)`;
      } catch (err) {
        status.textContent = `Validation error: ${err.message}`;
      }
      processBtn.disabled = false;
    } else {
      // XML + Openjet mode
      if (!xmlData || !eligData || !insuranceLicenses) {
        alert('Please upload both XML Claims, Eligibility XLSX files, and ensure insurance_licenses.json is present');
        return;
      }
      processBtn.disabled = true;
      status.textContent = 'Validating…';
      try {
        const results = validateEncounters(xmlData, eligData, insuranceLicenses);
        renderResults(results);

        // Validity summary
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
});
