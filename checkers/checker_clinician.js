//VERKA 2

// Additional global variable to hold Open Jet XLSX clinician list
let openJetClinicianList = [];

// Add a new input for Open Jet XLSX
const openJetInput = document.getElementById('openJetFileInput');
if (openJetInput) {
  openJetInput.addEventListener('change', async () => {
    resultsDiv.textContent = 'Loading Open Jet XLSX...';
    try {
      openJetClinicianList = await readOpenJetExcel(openJetInput.files[0]);
      console.log('Open Jet XLSX loaded:', openJetClinicianList.length, 'records');
      resultsDiv.textContent = 'All files loaded. Ready to process.';
    } catch (e) {
      openJetClinicianList = [];
      resultsDiv.textContent = `Error loading Open Jet XLSX: ${e.message}`;
      console.error(e);
    }
    toggleProcessButton();
  });
}

// Extend toggle logic
function toggleProcessButton() {
  processBtn.disabled = filesLoading.xml || filesLoading.excel || !xmlDoc || !clinicianMap || openJetClinicianList.length === 0;
  if (!processBtn.disabled) resultsDiv.textContent = 'Ready to process. Click "Process Files".';
}

// Parse Open Jet XLSX
async function readOpenJetExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read Open Jet Excel file.'));
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        resolve(json.map(row => row['Clinician']?.toString().trim()).filter(Boolean));
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

// Update processClaims
function processClaims(xmlDoc, clinicianMap) {
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  const results = [];

  claims.forEach(claim => {
    const claimId = getText(claim, 'ID') || 'N/A';
    const activities = Array.from(claim.getElementsByTagName('Activity'));

    activities.forEach(activity => {
      const activityId = getText(activity, 'ID') || 'N/A';
      const orderingId = getText(activity, 'OrderingClinician') || '';
      const performingId = getText(activity, 'Clinician') || '';

      const orderingData = clinicianMap.get(orderingId) || defaultClinicianData();
      const performingData = clinicianMap.get(performingId) || defaultClinicianData();

      const remarksList = [];

      if (!openJetClinicianList.includes(performingId)) {
        remarksList.push('Performing Clinician mismatch with XLSX');
      }
      if (!openJetClinicianList.includes(orderingId)) {
        remarksList.push('Ordering Clinician mismatch with XLSX');
      }

      const valid = validateClinicians(orderingId, performingId, orderingData, performingData);
      if (!valid && !remarksList.length) {
        remarksList.push(generateRemarks(orderingId, performingId, orderingData, performingData, valid));
      }

      results.push({
        claimId, activityId,
        clinicianInfo: `Ordering: ${orderingId} - ${orderingData.name}\nPerforming: ${performingId} - ${performingData.name}`,
        privilegesInfo: `Ordering: ${orderingData.privileges}\nPerforming: ${performingData.privileges}`,
        categoryInfo: `Ordering: ${orderingData.category}\nPerforming: ${performingData.category}`,
        valid, remarks: remarksList.join('; ')
      });
    });
  });

  renderResults(results);
  logSummary(results);
}
