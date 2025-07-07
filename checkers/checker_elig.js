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

  // Excel date number to DD/MM/YYYY string
  function excelDateToDDMMYYYY(excelDate) {
    if (!excelDate) return '';
    if (typeof excelDate === 'string') {
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(excelDate)) {
        return excelDate.replace(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/, (m, d, mth, y) => {
          const dd = d.padStart(2, '0');
          const mm = mth.padStart(2, '0');
          let yyyy = y.length === 2 ? ('20' + y) : y;
          if (yyyy.length === 4 && yyyy[0] === '0') yyyy = yyyy.slice(1);
          return `${dd}/${mm}/${yyyy}`;
        });
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(excelDate)) {
        const [yyyy, mm, dd] = excelDate.split('-');
        return `${dd}/${mm}/${yyyy}`;
      }
      return excelDate;
    }
    const date = new Date(Math.round((excelDate - 25569) * 86400 * 1000));
    const userTimezoneOffset = date.getTimezoneOffset() * 60000;
    const dateUTC = new Date(date.getTime() + userTimezoneOffset);
    const dd = String(dateUTC.getDate()).padStart(2, '0');
    const mm = String(dateUTC.getMonth() + 1).padStart(2, '0');
    const yyyy = dateUTC.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

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

  eligGroup.style.display = '';

  fetch('insurance_licenses.json')
    .then(r => r.json())
    .then(json => {
      insuranceLicenses = json;
      updateStatus();
    })
    .catch(() => {
      insuranceLicenses = null;
    });

  async function parseExcel(file, range = 0) {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = e => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          if (!worksheet) throw new Error('No worksheet found in uploaded file.');
          const json = XLSX.utils.sheet_to_json(worksheet, { defval: '', range });
          if (json.length > 0) {
            console.log(`Parsed (range: ${range}) headers:`, Object.keys(json[0]));
            console.log("First parsed row:", json[0]);
          } else {
            console.log("No data rows found in XLS/XLSX.");
          }
          resolve(json);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

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

  function stripLeadingZero(x) {
    x = (x || '').replace(/[-\s]/g, '').trim();
    return x.startsWith('0') ? x.substring(1) : x;
  }
  function findEligibilityMatchesByCard(memberID, eligRows) {
    const cardCol = 'Card Number / DHA Member ID';
    const checkID = stripLeadingZero(memberID);
    return eligRows.filter(row => {
      let xlsCard = (row[cardCol] || '').replace(/[-\s]/g, '').trim();
      if (xlsCard.startsWith('0')) xlsCard = xlsCard.substring(1);
      return xlsCard && xlsCard === checkID;
    });
  }

  // --- XLS Validator ---
  function validateXlsWithEligibility(reportRows, eligRows) {
    if (reportRows.length > 0) {
      console.log("Parsed headers (xls):", Object.keys(reportRows[0]));
      console.log("First parsed row (xls):", reportRows[0]);
    } else {
      console.log("No rows to parse in XLS.");
    }

    const filtered = reportRows.filter(row => {
      const clinic = (row["Clinic"] || "").toUpperCase().replace(/\s+/g, '');
      const insurance = (row["Insurance Company"] || "").toUpperCase().replace(/\s+/g, '');
      return clinic.includes("DENTAL") && (insurance.includes("THIQA") || insurance.includes("DAMAN"));
    });

    console.log(`Filtered to ${filtered.length} dental/THIQA/DAMAN rows`);

    return filtered.map(row => {
      const remarks = [];
      let match = null;
      let status = '';
      let affiliatedPlan = '';
      let clinicianMismatch = false;
      let clinicianMismatchMsg = "";
      let memberID = (row["PatientCardID"] || '').toString().trim();

      // If memberID starts with zero, it's invalid
      if (memberID.startsWith('0')) {
        remarks.push("Member ID starts with 0 (invalid)");
      }

      const matches = eligRows.filter(erow => {
        let xlsCard = (erow['Card Number / DHA Member ID'] || '').replace(/[-\s]/g, '').trim();
        if (xlsCard.startsWith('0')) xlsCard = xlsCard.substring(1);
        return xlsCard && xlsCard === stripLeadingZero(memberID);
      });

      if (!row["ClaimID"]) remarks.push("Missing ClaimID");
      if (!row["PatientCardID"]) remarks.push("Missing PatientCardID");
      if (!row["Clinician License"]) remarks.push("Missing Clinician License");

      if (matches.length === 0) {
        remarks.push('No eligibility rows found for card number');
      } else {
        match = matches[0];
        status = match['Status'] || '';
        if ((status || '').toLowerCase() !== 'eligible') remarks.push(`Status not eligible (${status})`);
        const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/[-\s]/g, '').trim();
        if (excelCard && stripLeadingZero(row["PatientCardID"] || '') !== stripLeadingZero(excelCard)) {
          remarks.push('Card Number mismatch between XLS and Eligibility');
        }

        // Clinician name mismatch
        const reportClinicianName = (row["OrderDoctor"] || '').trim();
        const eligClinicianName = (match['Clinician Name'] || match['Clinician'] || '').trim();
        if (reportClinicianName && eligClinicianName && reportClinicianName !== eligClinicianName) {
          clinicianMismatch = true;
          clinicianMismatchMsg = buildClinicianMismatchMsg(
            reportClinicianName,
            eligClinicianName,
            'XLSX',
            'Eligibility'
          );
        }
      }

      const formattedDate = excelDateToDDMMYYYY(row["ClaimDate"]);

      return {
        claimID: row["ClaimID"],
        memberID: row["PatientCardID"],
        payerID: row["Insurance Company"],
        affiliatedPlan,
        encounterStart: formattedDate,
        details: match ? formatEligibilityDetailsModal(match, row["PatientCardID"]) : formatReportDetailsModal(row, formattedDate),
        eligibilityRequestNumber: match?.['Eligibility Request Number'] || row["FileNo"] || null,
        status,
        remarks,
        match,
        matches,
        unknown: clinicianMismatch && remarks.length === 0,
        clinicianMismatchMsg: clinicianMismatchMsg
      };
    });
  }

  // --- XML Validator ---
  function validateXmlWithEligibility(xmlPayload, eligRows, insuranceLicenses) {
    const { encounters } = xmlPayload;
    return encounters.map(encounter => {
      const remarks = [];
      let match = null;
      let status = '';
      let affiliatedPlan = '';
      let clinicianMismatch = false;
      let clinicianMismatchMsg = "";
      let memberID = (encounter.memberID || '').toString().trim();

      if (memberID.startsWith('0')) {
        remarks.push("Member ID starts with 0 (invalid)");
      }

      const matches = eligRows.filter(erow => {
        let xlsCard = (erow['Card Number / DHA Member ID'] || '').replace(/[-\s]/g, '').trim();
        if (xlsCard.startsWith('0')) xlsCard = xlsCard.substring(1);
        return xlsCard && xlsCard === stripLeadingZero(memberID);
      });

      if (matches.length === 0) {
        remarks.push('No eligibility rows found for card number');
      } else {
        match = matches[0];
        status = match['Status'] || '';
        if ((status || '').toLowerCase() !== 'eligible') remarks.push(`Status not eligible (${status})`);
        const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/[-\s]/g, '').trim();
        if (excelCard && stripLeadingZero(encounter.memberID || '') !== stripLeadingZero(excelCard)) {
          remarks.push('Card Number mismatch between XML and Eligibility');
        }

        // Clinician name mismatch
        const reportClinicianName = (encounter.clinician || '').trim();
        const eligClinicianName = (match['Clinician Name'] || match['Clinician'] || '').trim();
        if (reportClinicianName && eligClinicianName && reportClinicianName !== eligClinicianName) {
          clinicianMismatch = true;
          clinicianMismatchMsg = buildClinicianMismatchMsg(
            reportClinicianName,
            eligClinicianName,
            'XML',
            'Eligibility'
          );
        }

        const excelProviderLicense = (match['Provider License'] || '').trim();
        const claimProviderID = (encounter.providerID || '').trim();
        if (claimProviderID && excelProviderLicense && claimProviderID !== excelProviderLicense) {
          remarks.push(`ProviderID does not match Provider License in eligibility (XML: "${claimProviderID}", Excel: "${excelProviderLicense}")`);
        }
      }

      return {
        claimID: encounter.claimID,
        memberID: encounter.memberID,
        payerID: encounter.payerID,
        affiliatedPlan,
        encounterStart: encounter.encounterStart,
        details: match ? formatEligibilityDetailsModal(match, encounter.memberID) : '',
        eligibilityRequestNumber: match?.['Eligibility Request Number'] || null,
        status,
        remarks,
        match,
        matches,
        unknown: clinicianMismatch && remarks.length === 0,
        clinicianMismatchMsg: clinicianMismatchMsg
      };
    });
  }

  /**
   * Returns HTML for a clinician‐mismatch message showing two name badges
   * with tooltips that indicate their origin.
   *
   * @param {string} reportClinicianName  – the clinician name from the report (XML or XLSX)
   * @param {string} eligClinicianName    – the clinician name from the eligibility file
   * @param {string} reportSourceLabel    – e.g. 'XML' or 'XLSX'
   * @param {string} eligSourceLabel      – e.g. 'Eligibility'
   */
  function buildClinicianMismatchMsg(
    reportClinicianName,
    eligClinicianName,
    reportSourceLabel,
    eligSourceLabel
  ) {
    const sanitize = str => str || 'Unknown';

    const rName = sanitize(reportClinicianName);
    const eName = sanitize(eligClinicianName);

    const reportBadge = `
      <span class="tooltip-parent">
        <span class="license-badge">${rName}</span>
        <span class="tooltip-text">${reportSourceLabel}: ${rName}</span>
      </span>
    `.trim();

    const eligBadge = `
      <span class="tooltip-parent">
        <span class="license-badge">${eName}</span>
        <span class="tooltip-text">${eligSourceLabel}: ${eName}</span>
      </span>
    `.trim();

    return `Clinician mismatch: ${reportBadge} vs. ${eligBadge}`;
  }

  function formatEligibilityDetailsModal(match, memberID) {
    const fields = [
      { label: 'Member ID', value: memberID || '' },
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

  function formatReportDetailsModal(row, formattedDate) {
    const fields = [
      { label: "Institution", value: row["Institution"] },
      { label: "ClaimID", value: row["ClaimID"] },
      { label: "ClaimDate", value: formattedDate || row["ClaimDate"] },
      { label: "OrderDoctor", value: row["OrderDoctor"] },
      { label: "Clinic", value: row["Clinic"] },
      { label: "Insurance Company", value: row["Insurance Company"] },
      { label: "PatientCardID", value: row["PatientCardID"] },
      { label: "FileNo", value: row["FileNo"] },
      { label: "Clinician License", value: row["Clinician License"] },
      { label: "Opened by/Registration Staff name", value: row["Opened by/Registration Staff name"] }
    ];
    let table = '<table class="shared-table details-table"><tbody>';
    fields.forEach(f => { table += `<tr><th>${f.label}</th><td>${f.value}</td></tr>`; });
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

  function renderResults(results, containerId = 'results') {
    const tbody = buildTableContainer(containerId);
    const modalElements = setupModal(containerId);
    if (results.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#888;">No matching rows found.</td></tr>`;
      return;
    }
    results.forEach((r, i) => {
      const row = createRow(r, i, modalElements);
      tbody.appendChild(row);
    });
  }

  function createRow(r, index, { modal, modalContent }) {
    const row = document.createElement('tr');
    if (r.unknown) {
      row.classList.add('unknown');
    } else if (r.remarks.length) {
      row.classList.add('invalid');
    } else {
      row.classList.add('valid');
    }
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

    let remarksCellHtml;
    if (r.unknown && r.clinicianMismatchMsg) {
      remarksCellHtml = r.clinicianMismatchMsg + '<br><span style="font-size:90%;color:#888;">(treated as unknown, marked valid)</span>';
    } else if (r.clinicianMismatchMsg) {
      remarksCellHtml = r.remarks.join('\n') + '<br>' + r.clinicianMismatchMsg;
    } else {
      remarksCellHtml = r.unknown
        ? 'Clinician mismatch (treated as unknown, marked valid)'
        : r.remarks.join('\n');
    }

    row.innerHTML = `
      <td>${index + 1}</td>
      <td class="wrap-col">${r.claimID}</td>
      <td class="wrap-col">${r.memberID}</td>
      <td class="wrap-col">${payerIDPlan}</td>
      <td>${r.encounterStart || ''}</td>
      <td></td>
      <td>${r.status || ''}</td>
      <td style="white-space: pre-line;">${remarksCellHtml}</td>
    `;
    row.querySelector('td:nth-child(6)').replaceWith(tdBtn);
    return row;
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
      xlsData = await parseExcel(e.target.files[0], 0);
      if (xlsData.length > 0) {
        console.log("Detected headers:", Object.keys(xlsData[0]));
        console.log("First row:", xlsData[0]);
      } else {
        console.log("No rows detected in XLS upload.");
      }
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
      eligData = await parseExcel(e.target.files[0], 1);
      if (eligData && eligData.length > 0) {
        console.log("Eligibility: Detected headers:", Object.keys(eligData[0]));
        console.log("Eligibility: First row:", eligData[0]);
      }
    } catch (err) {
      status.textContent = `Eligibility XLSX Error: ${err.message}`;
      eligData = null;
    }
    updateStatus();
  });

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
        const validCount = results.filter(r => r.unknown || r.remarks.length === 0).length;
        const totalCount = results.length;
        const percent = totalCount > 0 ? Math.round((validCount / totalCount) * 100) : 0;
        status.textContent = `Valid: ${validCount} / ${totalCount} (${percent}%)`;
        console.log(`Results: ${validCount} valid out of ${totalCount}`);
      } catch (err) {
        status.textContent = `Validation error: ${err.message}`;
        console.error(err);
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
        const validCount = results.filter(r => r.unknown || r.remarks.length === 0).length;
        const totalCount = results.length;
        const percent = totalCount > 0 ? Math.round((validCount / totalCount) * 100) : 0;
        status.textContent = `Valid: ${validCount} / ${totalCount} (${percent}%)`;
        console.log(`Results: ${validCount} valid out of ${totalCount}`);
      } catch (err) {
        status.textContent = `Validation error: ${err.message}`;
        console.error(err);
      }
      processBtn.disabled = false;
    }
  });

  swapInputGroups();
});
