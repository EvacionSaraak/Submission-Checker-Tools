// checker_tooths.js

const repoJsonUrl = 'checker_tooths.json';

// Tooth sets
const ANTERIOR_TEETH = new Set(['6','7','8','9','10','11','22','23','24','25','26','27','C','D','E','F','G','H','M','N','O','P']);
const BICUSPID_TEETH  = new Set(['4','5','12','13','20','21','28','29']);
const POSTERIOR_TEETH = new Set(['1','2','3','14','15','16','17','18','19','30','31','32','A','B','I','J','K','L','Q','R','S','T']);
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

function parseXML() {
  const xmlInput = document.getElementById('xmlFile');
  const resultsDiv = document.getElementById('results');
  if (!xmlInput.files.length) {
    return showMessage(resultsDiv, 'Please upload an XML file.');
  }
  const file = xmlInput.files[0];

  // 1) Read XML, 2) Fetch+parse JSON, then process both
  Promise.all([
    new Promise((res, rej) => {
      const rdr = new FileReader();
      rdr.onload = () => res(rdr.result);
      rdr.onerror = () => rej('Error reading XML');
      rdr.readAsText(file);
    }),
    fetch(repoJsonUrl)
      .then(r => {
        console.log(`JSON fetch status: ${r.status}`);
        return r.ok 
          ? r.json() 
          : Promise.reject(`Failed to load JSON (HTTP ${r.status})`);
      })
      .then(json => {
        console.log('JSON payload sample:', JSON.stringify(json.slice(0,3), null,2));
        return json;
      })
  ])
  .then(([xmlText, jsonData]) => {
    const codeToMeta = buildCodeMeta(jsonData);
    const xmlDoc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const rows = validateActivities(xmlDoc, codeToMeta);
    renderResults(resultsDiv, rows);
  })
  .catch(err => showMessage(resultsDiv, err.toString()));
}

function buildCodeMeta(data) {
  const map = {};
  data.forEach(entry => {
    const codesArray = entry.codes || entry.code || [];
    const teethSet = getTeethSet(entry.affiliated_teeth);
    codesArray.forEach(rawCode => {
      const code = rawCode.toString().trim();  // Force string type
      map[code] = {
        teethSet,
        description: entry.description || '(no description)'
      };
    });
  });
  console.log(`Mapped ${Object.keys(map).length} codes from JSON.`);
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
      const code = rawCode.trim();  // Preserve leading zeros

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
  if (!rows.length) {
    container.innerHTML = '<p>No activities found.</p>';
    return;
  }
  const html = `
    <table border="1" style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th>Claim ID</th><th>Activity ID</th><th>Code</th>
          <th>Description</th><th>Observations</th><th>Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r=>`
          <tr style="background:${r.isValid?'#e8ffe8':'#ffe8e8'}">
            <td>${r.claimId}</td><td>${r.activityId}</td><td>${r.code}</td>
            <td>${r.description}</td><td>${r.details}</td><td>${r.remarks.join('<br>')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  container.innerHTML = html;
}

console.log("02111" in codeToMeta);      // should be true if that's in your JSON
console.log("2111" in codeToMeta);       // should be false (unless duplicate added)


function showMessage(container, msg) {
  container.innerHTML = `<p style="color:red">${msg}</p>`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('xmlFile').addEventListener('change', e=>{
    document.getElementById('xmlFileName').textContent = e.target.files[0]?.name||'No file chosen';
  });
});
