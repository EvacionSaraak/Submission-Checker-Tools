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
    console.log("parseExcel: Starting to parse Excel file");
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = e => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const worksheet = workbook.Sheets[workbook.SheetNames[1]];
          const json = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
          console.log("parseExcel: Successfully parsed Excel file");
          resolve(json);
        } catch (err) {
          console.error("parseExcel: Error parsing Excel file", err);
          reject(err);
        }
      };
      reader.onerror = () => {
        console.error("parseExcel: FileReader error", reader.error);
        reject(reader.error);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Parses the uploaded XML file and extracts MemberID and Encounter details
  function parseXML(file) {
    console.log("parseXML: Starting to parse XML file");
    return file.text().then(xmlText => {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, "application/xml");
      const claim = xmlDoc.querySelector('Claim');
      // Extract MemberID from XML (Card Number)
      const memberID = claim?.querySelector('MemberID')?.textContent.trim() || '';
      // Encounters may be multiple
      const encounterNodes = claim.querySelectorAll('Encounter');
      // Map over encounters to get Start date (and optionally other fields if needed)
      const encounters = Array.from(encounterNodes).map(enc => ({
        Start: enc.querySelector('Start')?.textContent.trim() || '',
        // Optionally store more fields here
      }));
      console.log("parseXML: Successfully parsed XML file");
      return { memberID, encounters };
    });
  }

  // Validates encounters against eligibility data
  function validateEncounters(xmlPayload, eligRows) {
    console.log("validateEncounters: Validating encounters");
    const { memberID, encounters } = xmlPayload;
    const normalizedMemberID = memberID.replace(/-/g, '').trim();
    // For each encounter, find eligibility match
    return encounters.map(encounter => {
      const remarks = [];
      const match = findEligibilityMatchByCardAndDate(normalizedMemberID, encounter, eligRows);
      if (!match) {
        remarks.push('No matching eligibility row found');
      } else {
        const status = (match['Status'] || '').toLowerCase();
        if (status !== 'eligible') remarks.push(`Status not eligible (${match['Status']})`);
        const excelCard = (match['Card Number / DHA Member ID'] || '').replace(/-/g, '').trim();
        if (excelCard && normalizedMemberID !== excelCard) {
          remarks.push('Card Number mismatch between XML and Excel');
        }
      }
      const details = match
        ? `${match['Eligibility Request Number'] || ''}\n${match['Service Category'] || ''} - ${match['Consultation Status'] || ''}`
        : '';
      return {
        memberID: normalizedMemberID,
        start: encounter.Start,
        details,
        eligibilityRequestNumber: match?.['Eligibility Request Number'] || null,
        remarks,
      };
    });
  }

  // Finds the best eligibility row matching the card number and date
  function findEligibilityMatchByCardAndDate(memberID, encounter, eligRows) {
    console.log("findEligibilityMatchByCardAndDate: Looking for eligibility match");
    const startDate = parseDMYorISO(encounter.Start);
    // Allow for different possible column names
    const cardCol = 'Card Number / DHA Member ID';
    const dateCol = 'Ordered On';

    // Filter for card number match (normalize both)
    const matches = eligRows.filter(row => {
      const xlsCard = (row[cardCol] || '').replace(/-/g, '').trim();
      if (xlsCard !== memberID) return false;
      // Compare date - should match exactly or within a day? Here, we match exact date only
      const excelDate = parseDMYorISO(row[dateCol]);
      return isSameDay(excelDate, startDate);
    });

    if (matches.length === 0) return null;
    // If multiple, pick the first (or you may sort by date descending if needed)
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
    console.log("parseDMYorISO: Parsing date", str);
    if (!str) return new Date('Invalid Date');
    // Try DMY or D-MMM-YYYY HH:mm format first (as in parseExcelDate)
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
    // Try DMY with slashes or dashes, e.g. 15/06/2024 or 15-06-2024
    const parts = str.split(/[\/\-]/);
    if (parts.length === 3 && parts[2].length === 4) {
      // Could be DD/MM/YYYY or DD-MM-YYYY
      return new Date(parts[2], parts[1] - 1, parts[0]);
    }
    // Try ISO
    const d = new Date(str);
    if (!isNaN(d.valueOf())) return d;
    return new Date('Invalid Date');
  }

  // Builds the results table container
  function buildTableContainer(containerId = 'results') {
    console.log("buildTableContainer: Building table container");
    const c = document.getElementById(containerId);
    c.innerHTML = `<table class="shared-table">
        <thead><tr>
          <th>#</th><th>MemberID</th><th>Encounter Start</th><th>Eligibility Details</th><th>Remarks</th>
        </tr></thead>
        <tbody></tbody>
      </table>`;
    return c.querySelector('tbody');
  }

  // Sets up the modal for displaying eligibility details
  function setupModal(containerId = 'results') {
    console.log("setupModal: Setting up modal");
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

  // Creates a row in the results table for each encounter
  function createRow(r, index, { modal, modalContent }) {
    console.log("createRow: Creating row for encounter", index + 1);
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
      <td class="wrap-col">${r.memberID}</td>
      <td>${r.start}</td>
      <td></td>
      <td style="white-space: pre-line;">${r.remarks.join('\n')}</td>
    `;
    row.querySelector('td:nth-child(4)').replaceWith(tdBtn);
    return row;
  }

  // Renders the results table with all encounter rows
  function renderResults(results, containerId = 'results') {
    console.log("renderResults: Rendering results");
    const tbody = buildTableContainer(containerId);
    const modalElements = setupModal(containerId);
    results.forEach((r, i) => {
      const row = createRow(r, i, modalElements);
      tbody.appendChild(row);
    });
  }

  // Updates the status text and process button state
  function updateStatus() {
    console.log("updateStatus: Updating status");
    const encountersCount = xmlData?.encounters?.length || 0;
    const eligCount = eligData?.length || 0;
    const msgs = [];
    if (encountersCount) msgs.push(`${encountersCount} Encounter${encountersCount !== 1 ? 's' : ''} loaded`);
    if (eligCount) msgs.push(`${eligCount} Eligibilit${eligCount !== 1 ? 'ies' : 'y'} loaded`);
    status.textContent = msgs.join(', ');
    processBtn.disabled = !(xmlData && eligData);
  }

  xmlInput.addEventListener('change', async (e) => {
    console.log("Event: XML file input changed");
    status.textContent = 'Loading Claims…';
    processBtn.disabled = true;
    try {
      xmlData = await parseXML(e.target.files[0]);
    } catch (err) {
      status.textContent = `XML Error: ${err.message}`;
      console.error("XML load error:", err);
      xmlData = null;
    }
    updateStatus();
  });

  excelInput.addEventListener('change', async (e) => {
    console.log("Event: Excel file input changed");
    status.textContent = 'Loading Eligibilities…';
    processBtn.disabled = true;
    try {
      eligData = await parseExcel(e.target.files[0]);
    } catch (err) {
      status.textContent = `XLSX Error: ${err.message}`;
      console.error("Excel load error:", err);
      eligData = null;
    }
    updateStatus();
  });

  processBtn.addEventListener('click', async () => {
    console.log("Event: Process button clicked");
    if (!xmlData || !eligData) {
      alert('Please upload both XML Claims and Eligibility XLSX files');
      return;
    }

    processBtn.disabled = true;
    status.textContent = 'Validating…';

    try {
      const results = validateEncounters(xmlData, eligData);
      renderResults(results);
      status.textContent = `Validation completed: ${results.length} encounters processed`;
      console.log("Process: Validation completed", results);
    } catch (err) {
      status.textContent = `Validation error: ${err.message}`;
      console.error("Validation error:", err);
    }

    processBtn.disabled = false;
  });
});
