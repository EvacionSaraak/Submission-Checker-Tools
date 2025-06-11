// checker_eligibilities.js

window.addEventListener('DOMContentLoaded', () => {
  const xmlInput = document.getElementById('xmlFileInput');
  const excelInput = document.getElementById('eligibilityFileInput');
  const processBtn = document.getElementById('processBtn');
  const resultContainer = document.getElementById('results');
  const status = document.getElementById('uploadStatus');

  let xmlData = null;
  let eligData = null;
  let insuranceLicenses = null;

  // Load insurance_licenses.json from the same folder
  fetch('insurance_licenses.json')
    .then(r => r.json())
    .then(json => {
      insuranceLicenses = json;
      console.log('Loaded insurance licenses:', insuranceLicenses);
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
          console.log('SheetNames:', workbook.SheetNames);

          const worksheet = workbook.Sheets['Eligibility'];
          if (!worksheet) {
            throw new Error('No worksheet named "Eligibility" found in uploaded file.');
          }
          const json = XLSX.utils.sheet_to_json(worksheet, { defval: '', range: 1 });

          if (json.length > 0) {
            console.log('Eligibility headers:', Object.keys(json[0]));
            console.log('First eligibility row:', json[0]);
          } else {
            console.log('Eligibility headers: [No data rows parsed]');
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
        const encounterNodes = claim.querySelectorAll('Encounter');
        const encounters = Array.from(encounterNodes).map(enc => ({
          claimID,
          memberID,
          payerID,
          encounterStart: enc.querySelector('Start')?.textContent.trim() || ''
        }));
        return { claimID, memberID, payerID, encounters };
      });
      const allEncounters = claims.flatMap(c => c.encounters);
      return { claimsCount: claims.length, encounters: allEncounters };
    });
  }

  // Returns all eligibility rows matching the card number (ignores date)
  function findEligibilityMatchesByCard(memberID, eligRows) {
    const cardCol = 'Card Number / DHA Member ID';
    const matches = eligRows.filter(row => {
      const xlsCard = (row[cardCol] || '').replace(/-/g, '').trim();
      return xlsCard === memberID.replace(/-/g, '').trim();
    });
    return matches;
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
    return encounters.map(encounter => {
      const matches = findEligibilityMatchesByCard(encounter.memberID, eligRows);
      const remarks = [];
      let status = '';
      let match = null;
      let affiliatedPlan = "";
      if (matches.length === 0) {
        remarks.push('No eligibility rows found for card number');
      } else {
        // Pick the first match for main display (could be improved later)
        match = matches[0];
        status = match['Status'] || '';
        if ((status || '').toLowerCase() !== 'eligible') remarks.push(`Status not eligible (${status})`);
        const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/-/g, '').trim();
        if (excelCard && encounter.memberID.replace(/-/g, '').trim() !== excelCard) {
          remarks.push('Card Number mismatch between XML and Excel');
        }
      }

      // Insurance license validation (iterate for all plans for this PayerID)
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
      console.log('All Excel matches for card:', encounter.memberID, matches);
      console.log('Row data about to be rendered:', {
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
        matches // all matches for this card number
      });
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
        matches // array of all matching eligibility rows for later filtering
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
    const eligCount = eligData?.length || 0;
    const licensesLoaded = insuranceLicenses ? true : false;
    const msgs = [];
    if (claimsCount) msgs.push(`${claimsCount} Claim${claimsCount !== 1 ? 's' : ''} loaded`);
    if (eligCount) msgs.push(`${eligCount} Eligibilit${eligCount !== 1 ? 'ies' : 'y'} loaded`);
    if (licensesLoaded) msgs.push('Insurance Licenses loaded');
    status.textContent = msgs.join(', ');
    processBtn.disabled = !(claimsCount && eligCount && licensesLoaded);

    console.log(`updateStatus: ${claimsCount} claims loaded, ${eligCount} eligibilities loaded, licenses loaded: ${licensesLoaded}`);
    if (xmlData) console.log('Claims data:', xmlData);
    if (eligData) console.log('Eligibility data:', eligData);
    if (insuranceLicenses) console.log('Insurance licenses:', insuranceLicenses);
  }

  xmlInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading Claims…';
    processBtn.disabled = true;
    try {
      xmlData = await parseXML(e.target.files[0]);
      console.log(`XML parsed: ${xmlData.claimsCount} claims, ${xmlData.encounters.length} encounters`);
      console.log('Parsed claims:', xmlData);
    } catch (err) {
      status.textContent = `XML Error: ${err.message}`;
      console.error("XML load error:", err);
      xmlData = null;
    }
    updateStatus();
  });

  excelInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading Eligibilities…';
    processBtn.disabled = true;
    try {
      eligData = await parseExcel(e.target.files[0]);
      console.log(`Excel parsed: ${eligData.length} eligibilities`);
      console.log('Parsed eligibilities:', eligData);
    } catch (err) {
      status.textContent = `XLSX Error: ${err.message}`;
      console.error("Excel load error:", err);
      eligData = null;
    }
    updateStatus();
  });

  processBtn.addEventListener('click', async () => {
    if (!xmlData || !eligData || !insuranceLicenses) {
      alert('Please upload both XML Claims, Eligibility XLSX files, and ensure insurance_licenses.json is present');
      return;
    }
    processBtn.disabled = true;
    status.textContent = 'Validating…';
    try {
      const results = validateEncounters(xmlData, eligData, insuranceLicenses);
      console.log(`Validation completed: ${results.length} encounters processed`);
      console.log('Validation results:', results);
      renderResults(results);

      // Validity summary
      const validCount = results.filter(r => r.remarks.length === 0).length;
      const totalCount = results.length;
      const percent = totalCount > 0 ? Math.round((validCount / totalCount) * 100) : 0;
      status.textContent = `Valid: ${validCount} / ${totalCount} (${percent}%)`;

    } catch (err) {
      status.textContent = `Validation error: ${err.message}`;
      console.error("Validation error:", err);
    }
    processBtn.disabled = false;
  });
});
