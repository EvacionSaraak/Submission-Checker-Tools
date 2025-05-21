// script.js
// -----------------------

const repoJsonUrl = 'tooth validity.json';
const ANTERIOR_TEETH = new Set(['6','7','8','9','10','11','22','23','24','25','26','27']);
const BICUSPID_TEETH = new Set(['4','5','12','13','20','21','28','29']);
const POSTERIOR_TEETH = new Set(['1','2','3','14','15','16','17','18','19','30','31','32']);

function parseXML() {
  const xmlInput = document.getElementById('xmlFile');
  const jsonInput = document.getElementById('jsonFile');
  const resultsDiv = document.getElementById('results');

  if (!xmlInput?.files.length) return showMessage(resultsDiv, 'Please upload an XML file.');

  Promise.all([
    readXMLFile(xmlInput.files[0]),
    readJSONOrRepo(jsonInput)
  ])
  .then(([xmlData, jsonData]) => tryProcess(xmlData, jsonData, resultsDiv))
  .catch(err => showMessage(resultsDiv, err.message));
}

function readXMLFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Error reading XML file'));
    reader.readAsText(file);
  });
}

function readJSONOrRepo(jsonInput) {
  if (jsonInput?.files.length) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Error reading uploaded JSON file'));
      reader.readAsText(jsonInput.files[0]);
    });
  }
  return fetch(repoJsonUrl)
    .then(resp => {
      if (!resp.ok) throw new Error(`Could not load repository JSON (HTTP ${resp.status})`);
      return resp.text();
    });
}

function tryProcess(xmlData, jsonData, resultsDiv) {
  const codeToMeta = buildCodeMeta(jsonData);
  const xmlDoc = new DOMParser().parseFromString(xmlData, 'text/xml');
  const rows = validateActivities(xmlDoc, codeToMeta);
  renderResults(resultsDiv, rows);
}

function buildCodeMeta(jsonText) {
  let map = {};
  const data = JSON.parse(jsonText);
  data.forEach(entry => {
    const teethSet = getTeethSet(entry.affiliated_teeth);
    (entry.codes || []).forEach(raw => {
      const code = raw.toString().trim();
      map[code] = { teethSet, description: entry.description || '(no description)' };
    });
  });
  return map;
}

function getTeethSet(region) {
  switch ((region || '').toLowerCase()) {
    case 'all': return new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH, ...POSTERIOR_TEETH]);
    case 'anteriors': return ANTERIOR_TEETH;
    case 'posteriors':  return POSTERIOR_TEETH;
    case 'bicuspid':   return BICUSPID_TEETH;
    case 'anteriors/bicuspid': return new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH]);
    default: return new Set();
  }
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
      const net = act.querySelector('Net')?.textContent || '';

      const meta = codeToMeta[code] || { teethSet: new Set(), description: '(no description)' };
      let isValid = true;
      const remarks = [];
      const details = Array.from(obsList).map(obs => {
        const type = obs.querySelector('Type')?.textContent || '';
        const obsCode = obs.querySelector('Code')?.textContent.trim() || '';
        if (/^\d+$/.test(obsCode) && !meta.teethSet.has(obsCode)) {
          isValid = false;
          // Use region format instead of generic message
          remarks.push(`${obsCode} - ${getRegionName(obsCode)}`);
        }
        return `${type}: ${obsCode}`;
      }).join('<br>');

      rows.push({ claimId, activityId, code, description: meta.description, net, details, remarks, isValid });
    });
  });
  return rows;
}

function renderResults(container, rows) {
  if (!rows.length) {
    container.innerHTML = '<p>No activities with observations found.</p>';
    return;
  }

  const header = `
    <tr>
      <th>Claim ID</th>
      <th>Activity ID</th>
      <th>Code</th>
      <th>Description</th>
      <th>Net Amount</th>
      <th>Observations</th>
      <th>Remarks</th>
    </tr>`;

  const body = rows.map(r => `
    <tr class="${r.isValid ? 'valid' : 'invalid'}">
      <td>${r.claimId}</td>
      <td>${r.activityId}</td>
      <td>${r.code}</td>
      <td>${r.description}</td>
      <td>${r.net}</td>
      <td>${r.details}</td>
      <td>${r.remarks.length ? r.remarks.join('<br>') : 'All valid'}</td>
    </tr>
  `).join('');

  container.innerHTML = `<table border="1"><thead>${header}</thead><tbody>${body}</tbody></table>`;
}

function showMessage(container, message) {
  container.innerHTML = `<p>${message}</p>`;
}
