(function () {
  'use strict';

  // === STATE ===
  let xmlDoc = null, clinicianMap = {}, clinicianStatusMap = {};
  let xmlInput, clinicianInput, statusInput, processBtn, resultsDiv, uploadDiv;

  // === DOM READY & BINDINGS ===
  document.addEventListener('DOMContentLoaded', () => {
    xmlInput = document.getElementById('xmlFileInput');
    clinicianInput = document.getElementById('clinicianFileInput');
    statusInput = document.getElementById('statusFileInput');
    processBtn = document.getElementById('processBtn');
    resultsDiv = document.getElementById('results');
    uploadDiv = document.getElementById('uploadStatus');

    xmlInput.addEventListener('change', handleXmlInput);
    clinicianInput.addEventListener('change', handleClinicianInput);
    statusInput.addEventListener('change', handleStatusInput);
    processBtn.addEventListener('click', validateClinicians);

    processBtn.disabled = true;
    updateUploadStatus();
  });

  function handleXmlInput(e) {
    const file = e.target.files[0];
    if (!file) {
      xmlDoc = null;
      updateUploadStatus();
      return;
    }
    file.text().then(text => {
      xmlDoc = new DOMParser().parseFromString(text, 'application/xml');
      updateUploadStatus();
    });
  }

  function handleClinicianInput(e) {
    const file = e.target.files[0];
    if (!file) {
      clinicianMap = {};
      updateUploadStatus();
      return;
    }
    readExcel(file, data => {
      clinicianMap = {};
      data.forEach(row => {
        const id = (row['Clinician License'] || '').toString().trim();
        if (!id) return;
        clinicianMap[id] = {
          name: row['Clinician Name'] || row['Name'] || '',
          category: row['Clinician Category'] || row['Category'] || '',
        };
      });
      updateUploadStatus();
    });
  }

  function handleStatusInput(e) {
    const file = e.target.files[0];
    if (!file) {
      clinicianStatusMap = {};
      updateUploadStatus();
      return;
    }
    readExcel(file, data => {
      clinicianStatusMap = {};
      data.forEach(row => {
        const id = (row['License Number'] || '').toString().trim();
        if (!id) return;
        clinicianStatusMap[id] = clinicianStatusMap[id] || [];
        clinicianStatusMap[id].push({
          facility: row['Facility License Number'] || '',
          effective: row['Effective Date'] || '',
          status: row['Status'] || ''
        });
      });
      updateUploadStatus();
    });
  }

  function validateClinicians() {
    if (!xmlDoc) return;
    const claims = xmlDoc.getElementsByTagName('Claim');
    const results = [];
    for (const claim of claims) {
      const providerId = getText(claim, 'ProviderID');
      const encounter = claim.getElementsByTagName('Encounter')[0];
      const encounterStart = getText(encounter, 'Start');

      const activities = claim.getElementsByTagName('Activity');
      for (const act of activities) {
        const claimId = getText(claim, 'ID');
        const activityId = getText(act, 'ID');
        const oid = getText(act, 'OrderingClinician');
        const pid = getText(act, 'Clinician');
        const remarks = [];
        let valid = true;

        // Category check
        if (oid && pid && oid !== pid) {
          const oCat = clinicianMap[oid]?.category;
          const pCat = clinicianMap[pid]?.category;
          if (oCat && pCat && oCat !== pCat) {
            remarks.push('Category mismatch');
            valid = false;
          }
        }

        // License status check (Performing)
        const statusRemark = (id, label) => {
          const entries = clinicianStatusMap[id] || [];
          const encounterD = new Date(encounterStart);
          // Filter for facility and effective date <= encounter
          const validRec = entries
            .filter(e => e.facility === providerId && new Date(e.effective) <= encounterD)
            .sort((a, b) => new Date(b.effective) - new Date(a.effective))[0];
          if (!validRec) return `${label}: No matching license record`;
          if ((validRec.status || '').toLowerCase() !== 'active')
            return `${label}: Inactive as of ${validRec.effective}`;
          return null;
        };
        if (oid) {
          const ordStatus = statusRemark(oid, 'Ordering');
          if (ordStatus) {
            remarks.push(ordStatus);
            valid = false;
          }
        }
        if (pid) {
          const perfStatus = statusRemark(pid, 'Performing');
          if (perfStatus) {
            remarks.push(perfStatus);
            valid = false;
          }
        }

        results.push({
          claimId, activityId,
          ordering: oid,
          performing: pid,
          remarks,
          valid
        });
      }
    }
    render(results);
  }

  function render(results) {
    let validCt = results.filter(r => r.valid).length;
    let total = results.length;
    let pct = total ? Math.round(validCt / total * 100) : 0;
    resultsDiv.innerHTML =
      `<div class="${pct > 90 ? 'valid-message' : pct > 70 ? 'warning-message' : 'error-message'}">
        Validation: ${validCt}/${total} valid (${pct}%)
      </div>` +
      '<table><tr><th>Claim</th><th>Activity</th><th>Ordering</th><th>Performing</th><th>Remarks</th><th>Valid</th></tr>' +
      results.map(r =>
        `<tr class="${r.valid ? 'valid' : 'invalid'}">
          <td>${r.claimId}</td>
          <td>${r.activityId}</td>
          <td>${r.ordering}</td>
          <td>${r.performing}</td>
          <td>${r.remarks.join('; ')}</td>
          <td>${r.valid ? '✔' : '✘'}</td>
        </tr>`
      ).join('') + '</table>';
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

  function updateUploadStatus() {
    const loaded = [
      xmlDoc ? "XML loaded" : "",
      Object.keys(clinicianMap).length ? "Clinicians loaded" : "",
      Object.keys(clinicianStatusMap).length ? "License history loaded" : ""
    ].filter(Boolean).join(", ");
    uploadDiv.textContent = loaded;
    processBtn.disabled = !(xmlDoc && Object.keys(clinicianMap).length && Object.keys(clinicianStatusMap).length);
  }
})();
