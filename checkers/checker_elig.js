(function () {
  'use strict';

  let xmlInput, eligibilityInput, processBtn, resultsDiv;
  let xmlDoc = null, eligibilityMap = {};

  document.addEventListener('DOMContentLoaded', () => {
    xmlInput = document.getElementById('xmlFileInput');
    eligibilityInput = document.getElementById('eligibilityFileInput');
    processBtn = document.getElementById('processBtn');
    resultsDiv = document.getElementById('results');

    xmlInput.addEventListener('change', handleXmlInput);
    eligibilityInput.addEventListener('change', handleEligibilityInput);
    processBtn.addEventListener('click', validateEligibility);
  });

  function handleXmlInput(e) {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then(text => {
      xmlDoc = new DOMParser().parseFromString(text, 'application/xml');
    });
  }

  function handleEligibilityInput(e) {
    const file = e.target.files[0];
    if (!file) return;
    readExcel(file, data => {
      data.forEach(row => {
        const id = row['Clinician']?.toString().trim();
        if (!id) return;
        eligibilityMap[id] = row;
      });
    });
  }

  function validateEligibility() {
    const claims = xmlDoc.getElementsByTagName('Claim');
    const results = [];

    for (const claim of claims) {
      const encounter = claim.getElementsByTagName('Encounter')[0];
      const start = parseDate(getText(encounter, 'Start'));
      const end = parseDate(getText(encounter, 'End'));

      const activities = claim.getElementsByTagName('Activity');
      for (const act of activities) {
        const oid = getText(act, 'OrderingClinician');
        const pid = getText(act, 'Clinician');
        const remarks = [];

        const validate = (id, role) => {
          const row = eligibilityMap[id];
          if (!row) return `${role} (${id}) not found in eligibility file`;
          const from = parseDate(row['EffectiveDate']);
          const to = parseDate(row['ExpiryDate']);
          if (start < from || end > to) return `${role} eligibility period invalid (${from.toDateString()} - ${to.toDateString()})`;
          if (row['Card Status']?.toLowerCase() !== 'active') return `${role} card is not active`;
          return null;
        };

        const oRes = validate(oid, 'Ordering');
        const pRes = validate(pid, 'Performing');

        if (oRes) remarks.push(oRes);
        if (pRes) remarks.push(pRes);

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

  function parseDate(str) {
    const d = new Date(str);
    return isNaN(d) ? new Date('Invalid') : d;
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
