// checker_elig.js

// Dependencies: SheetJS (xlsx), xml-js

const parseExcel = async (file) => {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
};

const parseXML = async (file) => {
  const text = await file.text();
  const json = xmljs.xml2js(text, { compact: true });
  const claim = json['Claim.Submission']['Claim'];
  const encounter = claim['Encounter'];
  const claimEID = claim['EmiratesIDNumber']?._text || '';
  return { encounter, claimEID };
};

const validateEID = (eid) => {
  const parts = eid.split('-');
  if (parts.length !== 4) return 'Invalid EID format';
  if (parts[0] !== '784') return 'First part not 784';
  if (!/^\d{4}$/.test(parts[1])) return 'Second part not 4 digits';
  if (!/^\d{7}$/.test(parts[2])) return 'Third part not 7 digits';
  if (!/^\d{1}$/.test(parts[3])) return 'Fourth part not 1 digit';
  return null;
};

const findEligibilityMatch = (activity, eligRows) => {
  const clinician = activity.Clinician?._text || '';
  const providerID = activity.ProviderID?._text || '';
  const startDate = new Date(activity.Start?._text);

  const eligibleMatches = [];

  for (const row of eligRows) {
    if (
      row['Clinician'] !== clinician ||
      row['Provider License'] !== providerID
    ) continue;

    const effDate = new Date(row['EffectiveDate']);
    const expDate = row['ExpiryDate'] ? new Date(row['ExpiryDate']) : null;

    if (effDate > startDate) continue;
    if (expDate && expDate < startDate) continue;

    const status = (row['Status'] || '').toLowerCase();
    if (status === 'eligible') {
      eligibleMatches.push(row);
    }
  }

  if (eligibleMatches.length === 0) return null;

  eligibleMatches.sort((a, b) =>
    new Date(b['EffectiveDate']) - new Date(a['EffectiveDate'])
  );

  return eligibleMatches[0];
};

const validateActivities = (xmlPayload, eligRows) => {
  const { encounter, claimEID } = xmlPayload;
  let activities = [].concat(encounter.Activity || []);
  if (!Array.isArray(activities)) activities = [activities];

  const results = [];
  for (const activity of activities) {
    const clinicianID = activity.Clinician?._text || '';
    const providerID = activity.ProviderID?._text || '';
    const start = activity.Start?._text || '';

    const remarks = [];

    const eidRemark = validateEID(claimEID);
    if (eidRemark) {
      remarks.push(`EID: ${eidRemark}`);
    }

    const match = findEligibilityMatch(activity, eligRows);

    if (!match) {
      remarks.push('No matching eligibility row');
    } else {
      const status = (match['Status'] || '').toLowerCase();
      if (!['eligible'].includes(status)) {
        remarks.push(`Status not eligible (${match['Status']})`);
      }

      const excelEID = match['EmiratesIDNumber'] || '';
      if (excelEID && claimEID !== excelEID) {
        remarks.push('EID mismatch between XML and XLSX');
      }
    }

    const clinician = match ? `${clinicianID}\n${match['Clinician Name'] || ''}` : clinicianID;

    const details = match
      ? `${match['Eligibility Request Number'] || ''}\n${match['Service Category'] || ''} - ${match['Consultation Status'] || ''}`
      : '';

    results.push({
      clinician,
      providerID,
      start,
      details,
      remarks: remarks.join('; '),
    });
  }
  return results;
};

const renderResults = (results) => {
  const table = document.getElementById('results');
  table.innerHTML = '<tr><th>#</th><th>Clinician</th><th>ProviderID</th><th>ActivityStart</th><th>Eligibility Details</th><th>Remarks</th></tr>';

  results.forEach((r, i) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${i + 1}</td>
      <td style="white-space: pre-line">${r.clinician}</td>
      <td>${r.providerID}</td>
      <td>${r.start}</td>
      <td style="white-space: pre-line">${r.details}</td>
      <td>${r.remarks}</td>
    `;
    table.appendChild(row);
  });
};

// UI and status management

const status = document.getElementById('status');
const checkBtn = document.getElementById('check');

window.xmlData = null;
window.eligData = null;

const updateStatus = () => {
  const claimsCount = window.xmlData ? (Array.isArray(window.xmlData.activities) ? window.xmlData.activities.length : 1) : 0;
  const eligCount = window.eligData ? window.eligData.length : 0;

  let msgs = [];
  if (claimsCount) msgs.push(`${claimsCount} Claim${claimsCount !== 1 ? 's' : ''} loaded`);
  if (eligCount) msgs.push(`${eligCount} Eligibilit${eligCount !== 1 ? 'ies' : 'y'} loaded`);

  status.textContent = msgs.join(', ');

  checkBtn.disabled = !(window.xmlData && window.eligData);
};

document.getElementById('xmlFileInput').addEventListener('change', async (e) => {
  status.textContent = 'Loading Claims...';
  checkBtn.disabled = true;
  window.xmlData = await parseXML(e.target.files[0]);

  let activities = window.xmlData.encounter?.Activity || [];
  if (!Array.isArray(activities)) activities = [activities];
  window.xmlData.activities = activities;

  updateStatus();
});

document.getElementById('eligibilityFileInput').addEventListener('change', async (e) => {
  status.textContent = 'Loading Eligibilities...';
  checkBtn.disabled = true;
  window.eligData = await parseExcel(e.target.files[0]);
  updateStatus();
});

checkBtn.addEventListener('click', () => {
  if (!(window.xmlData && window.eligData)) return alert('Upload both files');

  checkBtn.disabled = true;
  status.textContent = 'Validating...';

  setTimeout(() => {
    const results = validateActivities(window.xmlData, window.eligData);
    renderResults(results);
    status.textContent = `Validation completed: ${results.length} activities processed`;
    checkBtn.disabled = false;
  }, 100);
});
