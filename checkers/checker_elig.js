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
          // Log all sheet names for debugging
          console.log('SheetNames:', workbook.SheetNames);

          // Use the sheet name 'Eligibility', case/space sensitive
          const worksheet = workbook.Sheets['Eligibility'];
          if (!worksheet) {
            throw new Error('No worksheet named "Eligibility" found in uploaded file.');
          }

          // Use the second row (range: 1) as headers
          const json = XLSX.utils.sheet_to_json(worksheet, { defval: '', range: 1 });

          // Log all headers for debugging
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

  // Returns all eligibility rows matching the card number (ignores date)
  function findEligibilityMatchesByCard(memberID, eligRows) {
    const cardCol = 'Card Number / DHA Member ID';
    const matches = eligRows.filter(row => {
      const xlsCard = (row[cardCol] || '').replace(/-/g, '').trim();
      return xlsCard === memberID.replace(/-/g, '').trim();
    });
    return matches;
  }

  // Validates encounters against eligibility data (ignoring date, returns all matches)
  function validateEncounters(xmlPayload, eligRows) {
    const { encounters } = xmlPayload;
    return encounters.map(encounter => {
      const matches = findEligibilityMatchesByCard(encounter.memberID, eligRows);
      const remarks = [];
      let status = '';
      let match = null;
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
      const details = match ? formatEligibilityDetailsModal(match) : '';
      // Log the array of matches for debug
      console.log('All Excel matches for card:', encounter.memberID, matches);
      // Log the data before it is pushed to a row
      console.log('Row data about to be rendered:', {
        claimID: encounter.claimID,
        memberID: encounter.memberID,
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

  // Format details string for the modal in the specified order, formatted as a table using tables.css
  function formatEligibilityDetailsModal(match) {
    // Prepare each field as a table row
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
      { label: 'ExpiryDate', value: match['ExpiryDate'] || match['Expiry Date'] || '' }
    ];
    // Build table HTML for modal, using classes from tables.css
    let table = '<table class="shared-table details-table"><tbody>';
    fields.forEach(f => {
      table += `<tr><th>${f.label}</th><td>${f.value}</td></tr>`;
    });
    table += '</tbody></table>';
    return table;
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
      modalContent.innerHTML = r.details; // Insert formatted table
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

      // NEW: Show summary of valid encounters
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
