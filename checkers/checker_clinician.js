(function () {
  'use strict';

  let xmlInput, clinicianInput, statusInput, processBtn, resultsDiv;
  let xmlDoc = null, clinicianMap = {}, clinicianStatusMap = {};

  document.addEventListener('DOMContentLoaded', () => {
    xmlInput = document.getElementById('xmlFileInput');
    clinicianInput = document.getElementById('clinicianFileInput');
    statusInput = document.getElementById('statusFileInput');
    processBtn = document.getElementById('processBtn');
    resultsDiv = document.getElementById('results');

    xmlInput.addEventListener('change', handleXmlInput);
    clinicianInput.addEventListener('change', handleClinicianInput);
    statusInput.addEventListener('change', handleStatusInput);
    processBtn.addEventListener('click', validateClinicians);
  });

  function handleXmlInput(e) {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then(text => {
      xmlDoc = new DOMParser().parseFromString(text, 'application/xml');
    });
  }

  function handleClinicianInput(e) {
    const file = e.target.files[0];
    if (!file) return;
    readExcel(file, data => {
      data.forEach(row => {
        const id = row['Clinician License']?.toString().trim();
        if (!id) return;
        clinicianMap[id] = row;
      });
    });
  }

  function handleStatusInput(e) {
    const file = e.target.files[0];
    if (!file) return;
    readExcel(file, data => {
      data.forEach(row => {
        const id = row['License Number']?.toString().trim();
        if (!id) return;
        clinicianStatusMap[id] = clinicianStatusMap[id] || [];
        clinicianStatusMap[id].push(row);
      });
    });
  }

  function validateClinicians() {
    const claims = xmlDoc.getElementsByTagName('Claim');
    const results = [];

    for (const claim of claims) {
      const providerId = getText(claim, 'ProviderID');
      const encounter = claim.getElementsByTagName('Encounter')[0];
      const start = getText(encounter, 'Start');

      const activities = claim.getElementsByTagName('Activity');
      for (const act of activities) {
        const oid = getText(act, 'OrderingClinician');
        const pid = getText(act, 'Clinician');
        const remarks = [];

        if (oid && pid && oid !== pid) {
          if (clinicianMap[oid]?.['Clinician Category'] !== clinicianMap[pid]?.['Clinician Category']) {
            remarks.push('Category mismatch between ordering and performing clinicians');
          }
        }

        const validateStatus = (id) => {
          const entries = clinicianStatusMap[id] || [];
          const valid = entries.find(e => e['Facility License Number'] === providerId);
          if (!valid) return 'No matching license record';
          if (valid['Status']?.toLowerCase() !== 'active') return `Inactive as of ${valid['Effective Date']}`;
          return null;
        };

        const orderingStatus = validateStatus(oid);
        const performingStatus = validateStatus(pid);
        if (orderingStatus) remarks.push(`Ordering: ${orderingStatus}`);
        if (performingStatus) remarks.push(`Performing: ${performingStatus}`);

        results.push({
          claimId: getText(claim, 'ID'),
          activityId: getText(act, 'ID'),
          ordering: oid,
          performing: pid,
          remarks: remarks
        });
      }
    }
    render(results);
  }

  function render(results) {
    resultsDiv.innerHTML = '<table><tr><th>Claim</th><th>Activity</th><th>Ordering</th><th>Performing</th><th>Remarks</th></tr>' +
      results.map(r => `<tr><td>${r.claimId}</td><td>${r.activityId}</td><td>${r.ordering}</td><td>${r.performing}</td><td>${r.remarks.join('; ')}</td></tr>`).join('') +
      '</table>';
  }

  function getText(parent, tag) {
    const el = parent.getElementsByTagName(tag)[0];
    return el ? el.textContent.trim() : '';
  }

  function readExcel(file, callback) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet);
      callback(rows);
    };
    reader.readAsArrayBuffer(file);
  }
})();
