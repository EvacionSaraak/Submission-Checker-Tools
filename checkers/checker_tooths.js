const repoJsonUrl = 'checker_tooths.json';

// Tooth sets (unchanged)
const ANTERIOR_TEETH = new Set([
  // Permanent Anterior
  '6','7','8','9','10','11',
  '22','23','24','25','26','27',
  // Primary Anterior
  'C','D','E','F','G','H',
  'M','N','O','P','Q','R'
]);

const BICUSPID_TEETH = new Set([
  // Permanent Bicuspid (no baby premolars)
  '4','5','12','13',
  '20','21','28','29'
]);

const POSTERIOR_TEETH = new Set([
  // Permanent Molars
  '1','2','3','14','15','16',
  '17','18','19','30','31','32',
  // Primary Molars
  'A','B','I','J',
  'K','L','S','T'
]);

const ALL_TEETH = new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH, ...POSTERIOR_TEETH]);

function normalizeToothCode(code) {
  return code?.toString().trim().toUpperCase() || '';
}

function getTeethSet(region) {
  if (!region) return ALL_TEETH;
  const lc = region.toLowerCase().trim();
  if (lc === 'all') return ALL_TEETH;
  const s = new Set();
  if (lc.includes('anterior'))  ANTERIOR_TEETH.forEach(t=>s.add(t));
  if (lc.includes('bicuspid'))  BICUSPID_TEETH.forEach(t=>s.add(t));
  if (lc.includes('posterior')) POSTERIOR_TEETH.forEach(t=>s.add(t));
  return s.size ? s : ALL_TEETH;
}

function getRegionName(tooth) {
  if (ANTERIOR_TEETH.has(tooth))  return 'Anterior';
  if (BICUSPID_TEETH.has(tooth))  return 'Bicuspid';
  if (POSTERIOR_TEETH.has(tooth)) return 'Posterior';
  return 'Unknown';
}

document.addEventListener('DOMContentLoaded', () => {
  const xmlInput = document.getElementById('xmlFile');
  xmlInput.addEventListener('change', () => {
    if (!xmlInput.files.length) return;
    parseXML();
  });
});

document.getElementById('exportBtn').addEventListener('click', () => {
  if (!window.invalidRows || !window.invalidRows.length) return;

  const wb = XLSX.utils.book_new();
  const wsData = [
    ["Claim ID", "Activity ID", "Code", "Description", "Observations", "Remarks"],
    ...window.invalidRows.map(r => [
      r.claimId,
      r.activityId,
      r.code,
      r.description,
      r.details.replace(/<br>/g, '\n'),
      r.remarks.join('\n')
    ])
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, "Invalid Activities");
  XLSX.writeFile(wb, "invalid_tooths.xlsx");
});


function parseXML() {
  const xmlInput = document.getElementById('xmlFile');
  const resultsDiv = document.getElementById('results');
  const messageBox = document.getElementById('messageBox');
  messageBox.textContent = '';
  resultsDiv.innerHTML = '';

  if (!xmlInput.files.length) {
    messageBox.textContent = 'Please upload an XML file.';
    return;
  }
  const file = xmlInput.files[0];

  Promise.all([
    new Promise((res, rej) => {
      const rdr = new FileReader();
      rdr.onload = () => res(rdr.result);
      rdr.onerror = () => rej('Error reading XML');
      rdr.readAsText(file);
    }),
    fetch(repoJsonUrl)
      .then(r => r.ok ? r.json() : Promise.reject(`Failed to load JSON (HTTP ${r.status})`))
  ])
  .then(([xmlText, jsonData]) => {
    const codeToMeta = buildCodeMeta(jsonData);
    const xmlDoc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xmlDoc.querySelector('parsererror')) throw new Error('Invalid XML file');
    const rows = validateActivities(xmlDoc, codeToMeta);
    renderResults(resultsDiv, rows);
  })
  .catch(err => {
    messageBox.textContent = err.toString();
  });
}

function buildCodeMeta(data) {
  const map = {};
  data.forEach(entry => {
    const codesArray = entry.codes || entry.code || [];
    const teethSet = getTeethSet(entry.affiliated_teeth);
    codesArray.forEach(rawCode => {
      const code = rawCode.toString().trim();
      map[code] = {
        teethSet,
        description: entry.description || '(no description)'
      };
    });
  });
  return map;
}

function validateActivities(xmlDoc, codeToMeta) {
  const rows = [];

  Array.from(xmlDoc.getElementsByTagName('Claim')).forEach(claim => {
    const claimId = claim.querySelector('ID')?.textContent || '(no claim ID)';

    Array.from(claim.getElementsByTagName('Activity')).forEach(act => {
      const obsList = act.getElementsByTagName('Observation');
      if (!obsList.length) return;

      const activityId = act.querySelector('ID')?.textContent || '';
      const rawCode = act.querySelector('Code')?.textContent || '';
      const code = rawCode.trim();

      const meta = codeToMeta[code] || { teethSet: new Set(), description: '(no description)' };

      let isValid = true;
      const remarks = [];

      const details = Array.from(obsList).map(obs => {
        const obsCodeRaw = obs.querySelector('Code')?.textContent.trim() || '';
        const obsCode = obsCodeRaw.toUpperCase();

        if (!meta.teethSet.has(obsCode)) {
          isValid = false;
          remarks.push(`Invalid - ${obsCode}`);
        } else {
          remarks.push(`Valid - ${obsCode}`);
        }

        return `${obsCode} - ${getRegionName(obsCode)}`;
      }).join('<br>');

      rows.push({
        claimId,
        activityId,
        code,
        description: meta.description,
        details,
        remarks,
        isValid
      });
    });
  });

  return rows;
}

function renderResults(container, rows) {
  const summaryBox = document.getElementById('resultsSummary');
  if (!rows.length) {
    container.innerHTML = '<p>No activities found.</p>';
    summaryBox.textContent = '';
    document.getElementById('exportBtn').style.display = 'none';
    return;
  }

  let lastClaimId = null;
  window.invalidRows = rows.filter(r => !r.isValid);
  document.getElementById('exportBtn').style.display = window.invalidRows.length ? 'inline-block' : 'none';

  // Summary statistics
  const validCount = rows.filter(r => r.isValid).length;
  const totalCount = rows.length;
  const percentage = ((validCount / totalCount) * 100).toFixed(1);

  summaryBox.textContent = `Valid: ${validCount} / ${totalCount} (${percentage}%)`;

  const html = `
    <table border="1" style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th>Claim ID</th><th>Activity ID</th><th>Code</th>
          <th>Description</th><th>Observations</th><th>Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const showClaimId = r.claimId !== lastClaimId;
          lastClaimId = r.claimId;
          return `
            <tr class="${r.isValid ? 'valid' : 'invalid'}">
              <td>${showClaimId ? r.claimId : ''}</td>
              <td>${r.activityId}</td><td>${r.code}</td>
              <td>${r.description}</td><td>${r.details}</td>
              <td>${r.remarks.join('<br>')}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  container.innerHTML = html;
}
