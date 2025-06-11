// parse DD/MM/YYYY HH:mm strings to Date
const parseDMY = (str) => {
  if (!str) return new Date('Invalid Date');
  const [day, month, yearAndTime] = str.split('/');
  if (!yearAndTime) return new Date('Invalid Date');
  const [year, time = '00:00'] = yearAndTime.split(' ');
  // Construct ISO format: YYYY-MM-DDTHH:mm
  return new Date(`${year}-${month}-${day}T${time}`);
};

// Parse XLSX file to JSON rows
const parseExcel = async (file) => {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array' });
  // Use second sheet since headers start at second row
  const sheetName = workbook.SheetNames[1] || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { range: 1 }); // skip first row, start from second row (0-based)
};

// Parse XML Claims file
const parseXML = async (file) => {
  const text = await file.text();
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'application/xml');

  const claimEls = Array.from(xml.querySelectorAll('Claim'));
  if (claimEls.length === 0) throw new Error('Invalid XML: No <Claim> elements found');

  // Extract EmiratesIDNumber from first Claim (assumes same across claims)
  const claimEID = claimEls[0].querySelector('EmiratesIDNumber')?.textContent.trim() || '';

  // Extract all Activity elements from all claims, flatten
  const activities = claimEls.flatMap((claimEl) =>
    Array.from(claimEl.querySelectorAll('Activity')).map((act) => {
      const obj = {};
      for (const child of act.children) {
        obj[child.tagName] = child.textContent.trim();
      }
      return obj;
    })
  );

  return { claimsCount: claimEls.length, claimEID, activities };
};

// Validate Emirates ID format (784-XXXX-XXXXXXX-X)
const validateEID = (eid) => {
  const parts = eid.split('-');
  if (parts.length !== 4) return 'Invalid EID format';
  if (parts[0] !== '784') return 'First part not 784';
  if (!/^\d{4}$/.test(parts[1])) return 'Second part not 4 digits';
  if (!/^\d{7}$/.test(parts[2])) return 'Third part not 7 digits';
  if (!/^\d{1}$/.test(parts[3])) return 'Fourth part not 1 digit';
  return null;
};

// Find matching eligibility row(s) for an activity
const findEligibilityMatch = (activity, eligRows) => {
  const clinician = activity.Clinician || '';
  const providerID = activity.ProviderID || '';
  const startDate = parseDMY(activity.Start);

  const eligibleMatches = [];

  for (const row of eligRows) {
    if (
      row['Clinician'] !== clinician ||
      row['Provider License'] !== providerID
    ) continue;

    const effDate = parseDMY(row['EffectiveDate']);
    const expDate = row['ExpiryDate'] ? parseDMY(row['ExpiryDate']) : null;

    if (effDate > startDate) continue; // eligibility starts after activity start
    if (expDate && expDate < startDate) continue; // eligibility expired before activity start

    if ((row['Status'] || '').toLowerCase() === 'eligible') {
      eligibleMatches.push(row);
    }
  }

  if (eligibleMatches.length === 0) return null;

  // Sort by EffectiveDate descending (latest first)
  eligibleMatches.sort((a, b) =>
    parseDMY(b['EffectiveDate']) - parseDMY(a['EffectiveDate'])
  );

  return eligibleMatches[0];
};

// Validate all activities and build result objects
const validateActivities = (xmlPayload, eligRows) => {
  const { activities, claimEID } = xmlPayload;
  const results = [];

  const eidRemark = validateEID(claimEID);

  for (const activity of activities) {
    const clinicianID = activity.Clinician || '';
    const providerID = activity.ProviderID || '';
    const start = activity.Start || '';

    const remarks = [];
    if (eidRemark) remarks.push(`EID: ${eidRemark}`);

    const match = findEligibilityMatch(activity, eligRows);
    if (!match) {
      remarks.push('No matching eligibility row');
    } else {
      const status = (match['Status'] || '').toLowerCase();
      if (status !== 'eligible') {
        remarks.push(`Status not eligible (${match['Status']})`);
      }
      const excelEID = match['EmiratesIDNumber'] || '';
      if (excelEID && claimEID !== excelEID) {
        remarks.push('EID mismatch between XML and XLSX');
      }
    }

    const clinicianDisplay = match
      ? `${clinicianID}\n${match['Clinician Name'] || ''}`
      : clinicianID;
    const details = match
      ? `${match['Eligibility Request Number'] || ''}\n${match['Service Category'] || ''} - ${match['Consultation Status'] || ''}`
      : '';

    results.push({
      clinician: clinicianDisplay,
      providerID,
      start,
      details,
      remarks,
    });
  }
  return results;
};

// Render results table with modal buttons and row coloring
const renderResults = (results) => {
  const container = document.getElementById('results');

  container.innerHTML = `
    <table class="shared-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Clinician</th>
          <th>ProviderID</th>
          <th>Activity Start</th>
          <th>Eligibility Details</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>

    <div id="eligibilityModal" class="modal" style="display:none;">
      <div class="modal-content">
        <span class="close">&times;</span>
        <pre id="modalContent" style="white-space: pre-wrap;"></pre>
      </div>
    </div>
  `;

  const tbody = container.querySelector('tbody');
  const modal = container.querySelector('#eligibilityModal');
  const modalContent = modal.querySelector('#modalContent');
  const closeBtn = modal.querySelector('.close');

  closeBtn.onclick = () => {
    modal.style.display = 'none';
  };
  window.onclick = (event) => {
    if (event.target === modal) {
      modal.style.display = 'none';
    }
  };

  results.forEach((r, i) => {
    const row = document.createElement('tr');

    if (r.remarks.length > 0) {
      row.classList.add('invalid');
    } else {
      row.classList.add('valid');
    }

    // Join remarks array for display with line breaks
    const remarksText = r.remarks.join('\n');

    // Eligibility button that opens modal with details
    const eligibilityButton = document.createElement('button');
    eligibilityButton.textContent = r.details.split('\n')[0] || 'View Eligibility';
    eligibilityButton.onclick = () => {
      modalContent.textContent = r.details || 'No details available';
      modal.style.display = 'block';
    };

    const tdEligibility = document.createElement('td');
    tdEligibility.appendChild(eligibilityButton);

    row.innerHTML = `
      <td>${i + 1}</td>
      <td class="wrap-col">${r.clinician.replace(/\n/g, '<br>')}</td>
      <td>${r.providerID}</td>
      <td>${r.start}</td>
      <td></td>
      <td style="white-space: pre-line;">${remarksText}</td>
    `;

    // Replace empty eligibility cell with button
    row.querySelector('td:nth-child(5)').replaceWith(tdEligibility);

    tbody.appendChild(row);
  });
};

// UI & Status Elements
const status = document.getElementById('uploadStatus');
const checkBtn = document.getElementById('processBtn');
window.xmlData = null;
window.eligData = null;

const updateStatus = () => {
  const claimsCount = window.xmlData ? window.xmlData.claimsCount : 0;
  const eligCount = window.eligData ? window.eligData.length : 0;
  const msgs = [];
  if (claimsCount) msgs.push(`${claimsCount} Claim${claimsCount !== 1 ? 's' : ''} loaded`);
  if (eligCount) msgs.push(`${eligCount} Eligibilit${eligCount !== 1 ? 'ies' : 'y'} loaded`);
  status.textContent = msgs.join(', ');
  checkBtn.disabled = !(window.xmlData && window.eligData);
};

document.getElementById('xmlFileInput').addEventListener('change', async (e) => {
  status.textContent = 'Loading Claims…';
  checkBtn.disabled = true;
  try {
    window.xmlData = await parseXML(e.target.files[0]);
    updateStatus();
  } catch (err) {
    status.textContent = `XML Error: ${err.message}`;
    console.error(err);
    window.xmlData = null;
  }
});

document.getElementById('eligibilityFileInput').addEventListener('change', async (e) => {
  status.textContent = 'Loading Eligibilities…';
  checkBtn.disabled = true;
  try {
    window.eligData = await parseExcel(e.target.files[0]);
    updateStatus();
  } catch (err) {
    status.textContent = `XLSX Error: ${err.message}`;
    console.error(err);
    window.eligData = null;
  }
});

checkBtn.addEventListener('click', () => {
  if (!(window.xmlData && window.eligData)) {
    alert('Please upload both XML Claims and Eligibility XLSX files');
    return;
  }
  checkBtn.disabled = true;
  status.textContent = 'Validating…';
  setTimeout(() => {
    const results = validateActivities(window.xmlData, window.eligData);
    renderResults(results);
    status.textContent = `Validation completed: ${results.length} activities processed`;
    checkBtn.disabled = false;
  }, 100);
});
