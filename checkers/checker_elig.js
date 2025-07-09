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
  let filteredXlsData = null; // new cache variable

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


// --- Modified validateXlsWithEligibility ---
function validateXlsWithEligibility(reportRows, eligRows) {
  if (reportRows.length > 0) {
    console.log("Parsed headers (xls):", Object.keys(reportRows[0]));
    console.log("First parsed row (xls):", reportRows[0]);
  } else {
    console.log("No rows to parse in XLS.");
  }

  console.log(`Processing ${reportRows.length} XLS report row(s)`);

  const seenClaimIDs = new Set();

  return reportRows
    .map(row => {
      const claimID = row["ClaimID"];
      if (seenClaimIDs.has(claimID)) return null;
      seenClaimIDs.add(claimID);

      const remarks = [];
      let match = null;
      let status = '';
      let affiliatedPlan = '';
      let clinicianMismatch = false;
      let clinicianMismatchMsg = "";
      let memberID = (row["PatientCardID"] || '').toString().trim();

      if (memberID.startsWith('0')) {
        remarks.push("Member ID starts with 0 (invalid)");
      }

      if (/VVIP/i.test(memberID)) {
        status = 'VVIP';
      } else {
        const result = findBestEligibilityMatch(memberID, row["ClaimDate"] || '', (row["Clinician License"] || '').trim(), eligRows);
        if (!result) {
          remarks.push('No eligibility rows found for card number');
        } else if (result.error) {
          remarks.push(result.error);
        } else {
          match = result.match;
          if (!match) {
            remarks.push("Eligibility match is undefined.");
          } else {
            if (result.unknown) {
              remarks.push('Clinician mismatch - fallback eligibility used (marked unknown)');
            }

            status = match['Status'] || '';
            if ((status || '').toLowerCase() !== 'eligible') remarks.push(`Status not eligible (${status})`);

            const serviceCategory = (match['Service Category'] || '').trim();
            const consultationStatus = (match['Consultation Status'] || '').trim().toLowerCase();

            const validServices = [
              { cat: 'Dental Services', group: 'Dental' },
              { cat: 'Physiotherapy', group: 'Physiotherapy' },
              { cat: 'Other OP Services', group: 'OtherOP' },
              { cat: 'Consultation', group: 'Consultation', condition: () => consultationStatus === 'elective' }
            ];

            const matchedGroup = validServices.find(entry =>
              entry.cat === serviceCategory &&
              (!entry.condition || entry.condition())
            );

            if (!matchedGroup) {
              remarks.push(`Invalid Service Category: "${serviceCategory}"`);
            }

            const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/[-\s]/g, '').trim();
            if (excelCard && stripLeadingZero(row["PatientCardID"] || '') !== stripLeadingZero(excelCard)) {
              remarks.push('Card Number mismatch between XLS and Eligibility');
            }

            const reportLic = (row["Clinician License"] || '').trim();
            const eligLic = (match["Clinician"] || '').trim();
            const reportName = (row["OrderDoctor"] || '').trim();
            const eligName = (match["Clinician Name"] || '').trim();

            if (reportLic && eligLic && reportLic !== eligLic) {
              clinicianMismatch = true;
              clinicianMismatchMsg = buildClinicianMismatchMsg(
                reportLic,
                eligLic,
                reportName,
                eligName,
                'XLSX',
                'Eligibility'
              );
            }
          }
        }
      }

      const formattedDate = excelDateToDDMMYYYY(row["ClaimDate"]);

      return {
        claimID: row["ClaimID"],
        memberID: row["PatientCardID"],
        payerID: row["Insurance Company"],
        affiliatedPlan,
        encounterStart: formattedDate,
        clinic: row["Clinic"] || '',
        details: match ? formatEligibilityDetailsModal(match, row["PatientCardID"]) : formatReportDetailsModal(row, formattedDate),
        eligibilityRequestNumber: match?.['Eligibility Request Number'] || row["FileNo"] || null,
        status,
        remarks,
        match,
        unknown: clinicianMismatch && remarks.length === 0,
        clinicianMismatchMsg,
        serviceCategory: match?.['Service Category'] || ''
      };
    })
    .filter(Boolean); // remove skipped duplicates
}


// --- Modified validateXmlWithEligibility ---
function validateXmlWithEligibility(xmlPayload, eligRows, insuranceLicenses) {
  const { encounters } = xmlPayload;
  const seenClaimIDs = new Set();

  return encounters
    .map(encounter => {
      const claimID = encounter.claimID;
      if (seenClaimIDs.has(claimID)) return null;
      seenClaimIDs.add(claimID);

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

      if (/VVIP/i.test(memberID)) {
        status = 'VVIP';
      } else {
        const result = findBestEligibilityMatch(memberID, encounter.encounterStart || '', (encounter.clinician || '').trim(), eligRows);
        if (!result) {
          remarks.push('No eligibility rows found for card number');
        } else if (result.error) {
          remarks.push(result.error);
        } else {
          match = result.match;
          if (!match) {
            remarks.push("Eligibility match is undefined.");
          } else {
            if (result.unknown) {
              remarks.push('Clinician mismatch - fallback eligibility used (marked unknown)');
            }

            status = match['Status'] || '';
            if ((status || '').toLowerCase() !== 'eligible') remarks.push(`Status not eligible (${status})`);

            const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/[-\s]/g, '').trim();
            if (excelCard && stripLeadingZero(encounter.memberID || '') !== stripLeadingZero(excelCard)) {
              remarks.push('Card Number mismatch between XML and Eligibility');
            }

            const reportLic = (encounter.clinician || '').trim();
            const eligLic = (match["Clinician"] || '').trim();
            const reportName = '';
            const eligName = (match["Clinician Name"] || '').trim();

            if (reportLic && eligLic && reportLic !== eligLic) {
              clinicianMismatch = true;
              clinicianMismatchMsg = buildClinicianMismatchMsg(
                reportLic,
                eligLic,
                reportName,
                eligName,
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
        unknown: clinicianMismatch && remarks.length === 0,
        clinicianMismatchMsg
      };
    })
    .filter(Boolean); // remove skipped duplicates
  }

  function buildClinicianMismatchMsg(
    reportLicense,
    eligLicense,
    reportClinician,
    eligClinician,
    reportSourceLabel,
    eligSourceLabel
  ) {
    const safeText = str => str || 'Unknown';
  
    const rLic  = safeText(reportLicense),
          eLic  = safeText(eligLicense),
          rName = safeText(reportClinician),
          eName = safeText(eligClinician);
  
    const makeBadge = (lic, label, name) => `
      <span class="tooltip-parent">
        <span class="license-badge">${lic}</span>
        <span class="tooltip-text">${label}: ${name}</span>
      </span>
    `.trim();
  
    const reportBadge = makeBadge(rLic, reportSourceLabel, rName);
    const eligBadge   = makeBadge(eLic,   eligSourceLabel,   eName);
  
    return `Clinician license mismatch: ${reportBadge} vs. ${eligBadge}`;
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
          <th>Service Category</th>
          <th>Clinic</th>
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
      <td>${r.serviceCategory || ''}</td>
      <td>${r.clinic || ''}</td>
      <td style="white-space: pre-line;">${remarksCellHtml}</td>
    `;
  
    row.querySelector('td:nth-child(6)').replaceWith(tdBtn);
    return row;
  }

  function parseDate(value) {
    if (value === null || value === undefined) return null;
  
    // If it's already a Date, return it
    if (value instanceof Date) return value;
  
    // If number, treat as Excel date number
    if (typeof value === 'number') {
      // Excel date starts 1900-01-01 as 1, but Excel wrongly treats 1900 as leap year; here just approximate:
      // Excel date to JS Date conversion:
      // Excel day 1 = 1899-12-31 in JS Date, so:
      const jsDate = new Date(Math.round((value - 25569) * 86400 * 1000));
      if (!isNaN(jsDate.getTime())) return jsDate;
      return null;
    }
  
    if (typeof value !== 'string') return null;
  
    // Try DD/MM/YYYY format
    let parts = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (parts) {
      const dd = parts[1].padStart(2, '0');
      const mm = parts[2].padStart(2, '0');
      let yyyy = parts[3];
      if (yyyy.length === 2) yyyy = '20' + yyyy;
      const d = new Date(`${yyyy}-${mm}-${dd}`);
      if (!isNaN(d.getTime())) return d;
    }
  
    // Try DD-MMM-YYYY with optional time e.g. 11-jan-1900 00:00:00
    parts = value.match(/^(\d{1,2})-([a-zA-Z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
    if (parts) {
      const dd = parts[1].padStart(2, '0');
      const mmm = parts[2].toLowerCase();
      const yyyy = parts[3];
      const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      const mm = monthNames.indexOf(mmm) + 1;
      if (mm === 0) return null;
      const hh = parts[4] || '00';
      const mi = parts[5] || '00';
      const ss = parts[6] || '00';
      const d = new Date(`${yyyy}-${String(mm).padStart(2, '0')}-${dd}T${hh}:${mi}:${ss}`);
      if (!isNaN(d.getTime())) return d;
    }
  
    // Try ISO format YYYY-MM-DD or with time
    const isoDate = new Date(value);
    if (!isNaN(isoDate.getTime())) return isoDate;
  
    // Fallback - invalid date
    return null;
  }

  // Helper to compare if two dates are on the same calendar day (ignoring time)
  function isSameDay(date1, date2) {
    if (!date1 || !date2) return false;
    return (
      date1.getFullYear() === date2.getFullYear() &&
      date1.getMonth() === date2.getMonth() &&
      date1.getDate() === date2.getDate()
    );
  }
  
  // Helper to check if date1 is on or before date2 (ignore time)
  function isOnOrBefore(date1, date2) {
    if (!date1 || !date2) return false;
    const d1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate());
    const d2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate());
    return d1.getTime() <= d2.getTime();
  }
  
  // Modified findBestEligibilityMatch with safe date comparison
  function findBestEligibilityMatch(memberID, claimDateStr, clinicianID, eligRows) {
    const claimDate = parseDate(claimDateStr);
    if (!claimDate) {
      console.log("Invalid claimDate:", claimDateStr);
      return null;
    }
    const memberIDNorm = stripLeadingZero(memberID);
  
    const filteredElig = eligRows.filter(erow => {
      let xlsCard = (erow['Card Number / DHA Member ID'] || '').replace(/[-\s]/g, '').trim();
      if (xlsCard.startsWith('0')) xlsCard = xlsCard.substring(1);
      return xlsCard === memberIDNorm;
    });
  
    if (filteredElig.length === 0) {
      console.log("No eligibility rows matching memberID:", memberIDNorm);
      return null;
    }
  
    // Use this to only allow exact date matches:
    const sameDateMatches = filteredElig.filter(erow => {
      const eligDateStr = erow['Ordered On'] || erow['EffectiveDate'] || erow['Effective Date'] || erow['Answered On'] || '';
      const eligDate = parseDate(eligDateStr);
      if (!eligDate) return false;
  
      // Uncomment one of the following:
  
      // 1) Exact same calendar day match (ignore time)
      return isSameDay(eligDate, claimDate);
  
      // 2) Or allow eligibility date on or before claim date:
      // return isOnOrBefore(eligDate, claimDate);
    });
  
    if (sameDateMatches.length === 0) {
      console.log("No eligibility rows with matching date for memberID:", memberIDNorm);
      return { error: "No eligibility was taken on this date" };
    }
  
    // Try exact clinician match first
    for (const erow of sameDateMatches) {
      const eligClinID = (erow['Clinician'] || '').trim();
      if (eligClinID && clinicianID && eligClinID === clinicianID) {
        return { match: erow, unknown: false };
      }
    }
  
    // fallback to first match (unknown clinician)
    return { match: sameDateMatches[0], unknown: true };
  }

  // Modified updateStatus function to show filtered count for XLS report rows
  function updateStatus() {
    const usingXml = xmlRadio.checked;
    const xmlLoaded = !!xmlData;
    const xlsLoaded = !!xlsData;
    const eligLoaded = !!eligData;
    const licensesLoaded = !!insuranceLicenses;
    const msgs = [];
  
    if (usingXml && xmlLoaded) {
      const claimIDs = new Set((xmlData.encounters || []).map(r => r.claimID));
      const count = claimIDs.size;
      msgs.push(`${count} unique Claim ID${count !== 1 ? 's' : ''} loaded`);
    }
  
    if (!usingXml && xlsLoaded) {
      const claimIDs = new Set((xlsData || []).map(r => r["ClaimID"]));
      const count = claimIDs.size;
      msgs.push(`${count} unique XLS Claim ID${count !== 1 ? 's' : ''} loaded`);
    }
  
    if (eligLoaded) {
      const count = eligData.length || 0;
      msgs.push(`${count} Eligibility row${count !== 1 ? 's' : ''} loaded`);
    }
  
    if (licensesLoaded) { msgs.push('Insurance Licenses loaded'); }
  
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
