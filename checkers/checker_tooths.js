const repoJsonUrl = 'checker_tooths.json';

// Predefined tooth sets by region
const ANTERIOR_TEETH = new Set([
  '6','7','8','9','10','11','22','23','24','25','26','27',
  'C','D','E','F','G','H','M','N','O','P'
]);

const BICUSPID_TEETH = new Set([
  '4','5','12','13','20','21','28','29',
]);

const POSTERIOR_TEETH = new Set([
  '1','2','3','14','15','16','17','18','19','30','31','32',
  'A','B','I','J','K','L','Q','R','S','T'
]);

function parseXML() {
  const xmlInput = document.getElementById('xmlFile');
  const resultsDiv = document.getElementById('results');

  if (!xmlInput?.files.length) { return showMessage(resultsDiv, 'Please upload an XML file.'); }

  const xmlFile = xmlInput.files[0];
  console.log(`XML file selected: ${xmlFile.name}`);

  Promise.all([
    readXMLFile(xmlFile),
    fetch(repoJsonUrl).then(resp => {
      console.log(`Fetching JSON from: ${repoJsonUrl}`);
      console.log(`Fetch status: ${resp.status}`);
      if (!resp.ok) throw new Error(`Could not load repository JSON (HTTP ${resp.status})`);
      return resp.text();
    })
  ])
  .then(([xmlData, jsonData]) => tryProcess(xmlData, jsonData, resultsDiv))
  .catch(err => showMessage(resultsDiv, `Error: ${err.message}`));
}

function readXMLFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      console.log("XML file successfully read.");
      resolve(reader.result);
    };
    reader.onerror = () => {
      console.error("Error reading XML file.");
      reject(new Error('Error reading XML file'));
    };
    reader.readAsText(file);
  });
}

function tryProcess(xmlData, jsonData, resultsDiv) {
  console.log("Raw JSON loaded:", jsonData.slice(0, 100), "...");

  const codeToMeta = buildCodeMeta(jsonData);
  console.log("Final codeToMeta map:", codeToMeta);

  const xmlDoc = new DOMParser().parseFromString(xmlData, 'text/xml');
  const rows = validateActivities(xmlDoc, codeToMeta);
  renderResults(resultsDiv, rows);
}

function buildCodeMeta(jsonText) {
  let map = {};
  let data;

  try {
    data = JSON.parse(jsonText);
    console.log(`Parsed JSON with ${data.length} entries.`);
  } catch (e) {
    console.error("JSON parsing failed:", e.message);
    return map;
  }

  data.forEach((entry, idx) => {
    console.log(`Processing JSON entry ${idx + 1}:`, entry);
    const teethSet = getTeethSet(entry.affiliated_teeth);
    (entry.codes || []).forEach(raw => {
      const code = raw.toString().trim();
      if (!code) {
        console.warn(`Empty code found in entry index ${idx}`);
        return;
      }
      map[code] = { teethSet, description: entry.description || '[No Description]' };
      console.log(`Mapped code ${code} → Region: ${entry.affiliated_teeth}`);
    });
  });

  return map;
}

function getTeethSet(region) {
  const normalized = (region || '').toLowerCase().trim();
  const result = new Set();

  if (normalized.includes('anterior')) { ANTERIOR_TEETH.forEach(tooth => result.add(tooth)); }
  if (normalized.includes('bicuspid')) { BICUSPID_TEETH.forEach(tooth => result.add(tooth)); }
  if (normalized.includes('posterior')) { POSTERIOR_TEETH.forEach(tooth => result.add(tooth)); }
  if (normalized === 'all' || result.size === 0) {
    console.log(`Using full set for region "${region}"`);
    return new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH, ...POSTERIOR_TEETH]);
  }

  return result;
}

function getRegionName(tooth) {
  if (ANTERIOR_TEETH.has(tooth)) return 'Anterior';
  if (BICUSPID_TEETH.has(tooth)) return 'Bicuspid';
  if (POSTERIOR_TEETH.has(tooth)) return 'Posterior';
  return 'Unknown';
}

function validateActivities(xmlDoc, codeToMeta) {
  const rows = [];

  Array.from(xmlDoc.getElementsByTagName('Claim')).forEach(claim => {
    const claimId = claim.querySelector('ID')?.textContent || '(no claim ID)';

    Array.from(claim.getElementsByTagName('Activity')).forEach(act => {
      const obsList = act.getElementsByTagName('Observation');
      if (!obsList.length) return;

      const activityId = act.querySelector('ID')?.textContent || '';
      const code = act.querySelector('Code')?.textContent.trim() || '';

      const meta = codeToMeta[code] || { teethSet: new Set(), description: '(code not found)' };
      console.log(`Activity ID: ${activityId}, Code: ${code}, Description: ${meta.description}`);
      console.log(`→ Valid teeth: ${[...meta.teethSet].join(', ')}`);

      let isValid = true;
      const remarks = [];

      const details = Array.from(obsList).map(obs => {
        const obsCode = obs.querySelector('Code')?.textContent.trim().toUpperCase() || '';
        console.log(`Checking observation code: ${obsCode}`);

        if (!meta.teethSet.has(obsCode)) {
          isValid = false;
          remarks.push(`Invalid - ${obsCode}`);
          console.warn(`INVALID tooth ${obsCode} for code ${code}`);
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
  const table = document.getElementById('outputTable');
  if (!rows.length) {
    container.innerHTML = '<p>No activities with observations found.</p>';
    if (table) table.style.display = 'none';
    return;
  }

  const header = `
    <tr>
      <th>Claim ID</th>
      <th>Activity ID</th>
      <th>Code</th>
      <th>Description</th>
      <th>Observations</th>
      <th>Remarks</th>
    </tr>`;

  const body = rows.map(r => `
    <tr class="${r.isValid ? 'valid' : 'invalid'}">
      <td>${r.claimId}</td>
      <td>${r.activityId}</td>
      <td>${r.code}</td>
      <td>${r.description}</td>
      <td>${r.details}</td>
      <td>${r.remarks.length ? r.remarks.join('<br>') : 'All valid'}</td>
    </tr>
  `).join('');

  if (table) {
    table.innerHTML = `<thead>${header}</thead><tbody>${body}</tbody>`;
    table.style.display = 'table';
    container.innerHTML = '';
  } else {
    container.innerHTML = `<table border="1"><thead>${header}</thead><tbody>${body}</tbody></table>`;
  }
}

function showMessage(container, message) {
  console.warn("Displaying message to user:", message);
  container.innerHTML = `<p>${message}</p>`;
}

function setupFileNameDisplay(inputId, displayId) {
  const input = document.getElementById(inputId);
  const display = document.getElementById(displayId);
  input.addEventListener('change', () => {
    const name = input.files.length ? input.files[0].name : 'No file chosen';
    display.textContent = name;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  console.log("Document ready — setting up file input display.");
  setupFileNameDisplay('xmlFile', 'xmlFileName');
});
