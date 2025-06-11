// checker_eligibilities.js

window.addEventListener('DOMContentLoaded', () => {
  const xmlInput = document.getElementById('xmlFileInput');
  const excelInput = document.getElementById('eligibilityFileInput');
  const processBtn = document.getElementById('processBtn');
  const resultContainer = document.getElementById('results');
  const status = document.getElementById('uploadStatus');

  let xmlData = null;
  let eligData = null;

  // Parses the uploaded Excel file and returns JSON representation
async function parseExcel(file) {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = e => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          console.log('SheetNames:', workbook.SheetNames); // <--- Sheet names

          const worksheet = workbook.Sheets['Eligibility'];
          if (!worksheet) {
            throw new Error('No worksheet named "Eligibility" found in uploaded file.');
          }
          const json = XLSX.utils.sheet_to_json(worksheet, { defval: '', range: 1 });
          console.log('Elig parsed json:', json);

          // Log all headers from the parsed sheet
          if (json.length > 0) {
            console.log('Eligibility headers:', Object.keys(json[0]));
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
        const encounterNodes = claim.querySelectorAll('Encounter');
        const encounters = Array.from(encounterNodes).map(enc => ({
          claimID,
          memberID,
          encounterStart: enc.querySelector('Start')?.textContent.trim() || ''
        }));
        return { claimID, memberID, encounters };
      });
      const allEncounters = claims.flatMap(c => c.encounters);
      return { claimsCount: claims.length, encounters: allEncounters };
    });
  }

  // Validates encounters against eligibility data
  function validateEncounters(xmlPayload, eligRows) {
    const { encounters } = xmlPayload;
    return encounters.map(encounter => {
      const match = findEligibilityMatchByCardAndDate(encounter.memberID, encounter.encounterStart, eligRows);
      const remarks = [];
      let status = '';
      if (!match) {
        remarks.push('No matching eligibility row found');
      } else {
        status = match['Status'] || '';
        if ((status || '').toLowerCase() !== 'eligible') remarks.push(`Status not eligible (${status})`);
        const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/-/g, '').trim();
        if (excelCard && encounter.memberID.replace(/-/g, '').trim() !== excelCard) {
          remarks.push('Card Number mismatch between XML and Excel');
        }
      }
      const details = match ? formatEligibilityDetailsModal(match) : '';
      return {
        claimID: encounter.claimID,
        memberID: encounter.memberID,
        encounterStart: encounter.encounterStart,
        details,
        eligibilityRequestNumber: match?.['Eligibility Request Number'] || null,
        status,
        remarks,
        match
      };
    });
  }

  // Finds the best eligibility row matching the card number and date
  function findEligibilityMatchByCardAndDate(memberID, encounterStart, eligRows) {
    const startDate = parseDMYorISO(encounterStart);
    const cardCol = 'Card Number / DHA Member ID';
    const dateCol = 'Ordered On';
    const matches = eligRows.filter(row => {
      const xlsCard = (row[cardCol] || '').replace(/-/g, '').trim();
      if (xlsCard !== memberID.replace(/-/g, '').trim()) return false;
      const excelDate = parseDMYorISO(row[dateCol]);
      return isSameDay(excelDate, startDate);
    });
    if (matches.length === 0) return null;
    return matches[0];
  }

  // Utility: Compare if two Date objects refer to the same day (ignoring time)
  function isSameDay(d1, d2) {
    if (!(d1 instanceof Date) || !(d2 instanceof Date)) return false;
    if (isNaN(d1.valueOf()) || isNaN(d2.valueOf())) return false;
    return d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate();
  }

  // Parses Excel or ISO date string to JS Date object
  function parseDMYorISO(str) {
    if (!str) return new Date('Invalid Date');
    const dmyParts = str.split(' ');
    if (dmyParts.length === 2 && dmyParts[0].includes('-')) {
      const [day, monStr, year] = dmyParts[0].split('-');
      const monthMap = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
      };
      const month = monthMap[monStr];
      if (month) return new Date(`${year}-${month}-${day}T${dmyParts[1]}`);
    }
    const parts = str.split(/[\/\-]/);
    if (parts.length === 3 && parts[2].length === 4) {
      return new Date(parts[2], parts[1] - 1, parts[0]);
    }
    const d = new Date(str);
    if (!isNaN(d.valueOf())) return d;
    return new Date('Invalid Date');
  }

  // Format details string for the modal in the specified order
  function formatEligibilityDetailsModal(match) {
    return [
      'Eligibility Request Number: ' + (match['Eligibility Request Number'] || ''),
      'Payer Name: ' + (match['Payer Name'] || ''),
      'Service Category: ' + (match['Service Category'] || ''),
      'Consultation status: ' + (match['Consultation status'] || ''),
      'Clinician: ' + (match['Clinician'] || ''),
      'Clinician Name: ' + (match['Clinician Name'] || ''),
      'Authorization Number: ' + (match['Authorization Number'] || ''),
      'EID: ' + (match['EID'] || ''),
      'Member Name: ' + (match['Member Name'] || '')
    ].join('\n');
  }

  // Builds the results table container
  function buildTableContainer(containerId = 'results') {
    const c = document.getElementById(containerId);
    c.innerHTML = `<table class="shared-table">
        <thead><tr>
          <th>#</th>
          <th>ID</th>
          <th>MemberID</th>
          <th>Encounter Start</th>
          <th>Eligibility Details</th>
          <th>Status</th>
          <th>Remarks</th>
        </tr></thead>
        <tbody></tbody>
      </table>`;
    return c.querySelector('tbody');
  }

  // Sets up the modal for displaying eligibility details
  function setupModal(containerId = 'results') {
    const c = document.getElementById(containerId);
    if (!c.querySelector('#eligibilityModal')) {
      c.insertAdjacentHTML('beforeend', `
        <div id="eligibilityModal" class="modal" style="display:none;">
          <div class="modal-content">
            <span class="close">&times;</span>
            <pre id="modalContent" style="white-space: pre-wrap;"></pre>
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

  // Creates a row in the results table for each encounter
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
      <td class="wrap-col">${r.claimID}</td>
      <td class="wrap-col">${r.memberID}</td>
      <td>${r.encounterStart}</td>
      <td></td>
      <td>${r.status || ''}</td>
      <td style="white-space: pre-line;">${r.remarks.join('\n')}</td>
    `;
    row.querySelector('td:nth-child(5)').replaceWith(tdBtn);
    return row;
  }

  // Renders the results table with all encounter rows
  function renderResults(results, containerId = 'results') {
    const tbody = buildTableContainer(containerId);
    const modalElements = setupModal(containerId);
    results.forEach((r, i) => {
      const row = createRow(r, i, modalElements);
      tbody.appendChild(row);
    });
  }

  // Updates the status text and process button state
  function updateStatus() {
      const claimsCount = xmlData?.claimsCount || 0;
      const eligCount = eligData?.length || 0;
      const msgs = [];
      if (claimsCount) msgs.push(`${claimsCount} Claim${claimsCount !== 1 ? 's' : ''} loaded`);
      if (eligCount) msgs.push(`${eligCount} Eligibilit${eligCount !== 1 ? 'ies' : 'y'} loaded`);
      status.textContent = msgs.join(', ');
      processBtn.disabled = !(claimsCount && eligCount);

      // Console logging for debugging
      console.log(`updateStatus: ${claimsCount} claims loaded, ${eligCount} eligibilities loaded`);
      if (xmlData) console.log('Claims data:', xmlData);
      if (eligData) console.log('Eligibility data:', eligData);
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
    if (!xmlData || !eligData) {
      alert('Please upload both XML Claims and Eligibility XLSX files');
      return;
    }
    processBtn.disabled = true;
    status.textContent = 'Validating…';
    try {
      const results = validateEncounters(xmlData, eligData);
      console.log(`Validation completed: ${results.length} encounters processed`);
      console.log('Validation results:', results);
      renderResults(results);
      status.textContent = `Validation completed: ${results.length} encounters processed`;
    } catch (err) {
      status.textContent = `Validation error: ${err.message}`;
      console.error("Validation error:", err);
    }
    processBtn.disabled = false;
  });
});
