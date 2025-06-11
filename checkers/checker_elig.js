// checker_eligibilities.js

window.addEventListener('DOMContentLoaded', () => {
  const xmlInput = document.getElementById('xmlFileInput');
  const excelInput = document.getElementById('eligibilityFileInput');
  const processBtn = document.getElementById('processBtn');
  const resultContainer = document.getElementById('results');
  const status = document.getElementById('uploadStatus');

  let xmlData = null;
  let eligData = null;

  async function parseExcel(file) {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = e => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const worksheet = workbook.Sheets[workbook.SheetNames[1]];
          const json = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
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
      const claim = xmlDoc.querySelector('Claim');
      const claimEID = claim?.querySelector('EmiratesIDNumber')?.textContent.trim() || '';
      const activityNodes = claim.querySelectorAll('Activity');
      const activities = Array.from(activityNodes).map(act => ({
        Clinician: act.querySelector('Clinician')?.textContent.trim() || '',
        ProviderID: act.querySelector('ProviderID')?.textContent.trim() || '',
        Start: act.querySelector('Start')?.textContent.trim() || '',
      }));
      return { claimEID, activities };
    });
  }

  function validateActivities(xmlPayload, eligRows) {
    const { claimEID, activities } = xmlPayload;
    const normalizedXmlEID = claimEID.replace(/-/g, '');
    const eidRemark = validateEIDFormat(normalizedXmlEID);
    return activities.map(activity => {
      const remarks = [];
      if (eidRemark) remarks.push(`XML EID: ${eidRemark}`);
      const match = findEligibilityMatch(activity, eligRows);
      if (!match) {
        remarks.push('No matching eligibility row found');
      } else {
        const status = (match['Status'] || '').toLowerCase();
        if (status !== 'eligible') remarks.push(`Status not eligible (${match['Status']})`);
        const excelEID = (match['EID'] || '').replace(/-/g, '');
        if (excelEID && normalizedXmlEID !== excelEID) {
          remarks.push('EID mismatch between XML and Excel');
        }
      }
      const clinicianDisplay = match
        ? `${activity.Clinician}\n${match['Clinician Name'] || ''}`
        : activity.Clinician;
      const details = match
        ? `${match['Eligibility Request Number'] || ''}\n${match['Service Category'] || ''} - ${match['Consultation Status'] || ''}`
        : '';
      return {
        clinician: clinicianDisplay,
        providerID: activity.ProviderID,
        start: activity.Start,
        details,
        eligibilityRequestNumber: match?.['Eligibility Request Number'] || null,
        remarks,
      };
    });
  }

  function validateEIDFormat(eid) {
    if (!eid) return 'Missing EID';
    if (!/^784\d{12}$/.test(eid)) return 'Invalid EID format (expect 15 digits starting with 784)';
    return null;
  }

  function findEligibilityMatch(activity, eligRows) {
    const clinician = activity.Clinician;
    const providerID = activity.ProviderID;
    const startDate = parseDMY(activity.Start);
    const matches = eligRows.filter(row => {
      if (row['Clinician'] !== clinician) return false;
      if (row['Provider License'] !== providerID) return false;
      const effDate = parseExcelDate(row['EffectiveDate']);
      const expDate = row['ExpiryDate'] ? parseExcelDate(row['ExpiryDate']) : null;
      if (effDate > startDate) return false;
      if (expDate && expDate < startDate) return false;
      return true;
    });
    if (matches.length === 0) return null;
    matches.sort((a, b) => parseExcelDate(b['EffectiveDate']) - parseExcelDate(a['EffectiveDate']));
    return matches[0];
  }

  function parseExcelDate(str) {
    if (!str) return new Date('Invalid Date');
    const parts = str.split(' ');
    if (parts.length === 2) {
      const [day, monStr, year] = parts[0].split('-');
      const monthMap = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
      };
      const month = monthMap[monStr];
      if (!month) return new Date('Invalid Date');
      return new Date(`${year}-${month}-${day}T${parts[1]}`);
    }
    return new Date(str);
  }

  function parseDMY(str) {
    if (!str) return new Date('Invalid Date');
    const parts = str.split(/[\/\-]/);
    if (parts.length === 3 && parts[2].length === 4) {
      return new Date(parts[2], parts[1] - 1, parts[0]);
    }
    return new Date(str);
  }

  function buildTableContainer(containerId = 'results') {
    const c = document.getElementById(containerId);
    c.innerHTML = `<table class="shared-table">
        <thead><tr>
          <th>#</th><th>Clinician</th><th>ProviderID</th><th>Activity Start</th><th>Eligibility Details</th><th>Remarks</th>
        </tr></thead>
        <tbody></tbody>
      </table>`;
    return c.querySelector('tbody');
  }

  function setupModal(containerId = 'results') {
    const c = document.getElementById(containerId);
    c.insertAdjacentHTML('beforeend', `
      <div id="eligibilityModal" class="modal" style="display:none;">
        <div class="modal-content">
          <span class="close">&times;</span>
          <pre id="modalContent" style="white-space: pre-wrap;"></pre>
        </div>
      </div>
    `);
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
      modalContent.textContent = r.details;
      modal.style.display = 'block';
    });
    const tdBtn = document.createElement('td');
    tdBtn.appendChild(btn);

    row.innerHTML = `
      <td>${index + 1}</td>
      <td class="wrap-col">${r.clinician.replace(/\n/g, '<br>')}</td>
      <td>${r.providerID}</td>
      <td>${r.start}</td>
      <td></td>
      <td style="white-space: pre-line;">${r.remarks.join('\n')}</td>
    `;
    row.querySelector('td:nth-child(5)').replaceWith(tdBtn);
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
    const claimsCount = xmlData?.activities?.length || 0;
    const eligCount = eligData?.length || 0;
    const msgs = [];
    if (claimsCount) msgs.push(`${claimsCount} Claim${claimsCount !== 1 ? 's' : ''} loaded`);
    if (eligCount) msgs.push(`${eligCount} Eligibilit${eligCount !== 1 ? 'ies' : 'y'} loaded`);
    status.textContent = msgs.join(', ');
    processBtn.disabled = !(xmlData && eligData);
  }

  xmlInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading Claims…';
    processBtn.disabled = true;
    try {
      xmlData = await parseXML(e.target.files[0]);
    } catch (err) {
      status.textContent = `XML Error: ${err.message}`;
      console.error(err);
      xmlData = null;
    }
    updateStatus();
  });

  excelInput.addEventListener('change', async (e) => {
    status.textContent = 'Loading Eligibilities…';
    processBtn.disabled = true;
    try {
      eligData = await parseExcel(e.target.files[0]);
    } catch (err) {
      status.textContent = `XLSX Error: ${err.message}`;
      console.error(err);
      eligData = null;
    }
    updateStatus();
  });

  processBtn.addEventListener('click', async () => {
    if (!xmlData || !eligData) {
      alert('Please upload both XML Claims and Eligibility XLSX files');
      return;
    }

    processBtn.disabled = true;
    status.textContent = 'Validating…';

    try {
      const results = validateActivities(xmlData, eligData);
      renderResults(results);
      status.textContent = `Validation completed: ${results.length} activities processed`;
    } catch (err) {
      status.textContent = `Validation error: ${err.message}`;
      console.error(err);
    }

    processBtn.disabled = false;
  });
});
