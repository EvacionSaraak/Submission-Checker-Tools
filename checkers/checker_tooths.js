const repoJsonUrl = 'checker_tooths.json';

const ANTERIOR_TEETH = new Set(['6','7','8','9','10','11','22','23','24','25','26','27','C','D','E','F','G','H','M','N','O','P']);
const BICUSPID_TEETH = new Set(['4','5','12','13','20','21','28','29']);
const POSTERIOR_TEETH = new Set(['1','2','3','14','15','16','17','18','19','30','31','32','A','B','I','J','K','L','Q','R','S','T']);

function parseXML() {
  const xmlInput = document.getElementById('xmlFile');
  const resultsDiv = document.getElementById('results');

  if (!xmlInput?.files.length) {
    return showMessage(resultsDiv, 'Please upload an XML file.');
  }

  const xmlFile = xmlInput.files[0];
  console.log(`XML file selected: ${xmlFile.name}`);

  Promise.all([
    readXMLFile(xmlFile),
    fetch(repoJsonUrl).then(resp => {
      if (!resp.ok) throw new Error(`Could not load repository JSON (HTTP ${resp.status})`);
      return resp.text();
    })
  ])
  .then(([xmlData, jsonData]) => tryProcess(xmlData, jsonData, resultsDiv))
  .catch(err => showMessage(resultsDiv, '[E000] ' + err.message));
}

function readXMLFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Error reading XML file'));
    reader.readAsText(file);
  });
}

function tryProcess(xmlData, jsonData, resultsDiv) {
  const codeToMeta = buildCodeMeta(jsonData);
  const xmlDoc = new DOMParser().parseFromString(xmlData, 'text/xml');
  const rows = validateActivities(xmlDoc, codeToMeta);
  renderResults(resultsDiv, rows);
}

function buildCodeMeta(jsonText) {
  const map = {};
  const data = JSON.parse(jsonText);
  data.forEach(entry => {
    const teethSet = getTeethSet(entry.affiliated_teeth);
    (entry.codes || []).forEach(raw => {
      const code = raw.toString().trim();
      map[code] = {
        teethSet,
        description: entry.description || '[Code N/A within JSON Repository]'
      };
    });
  });
  console.log(`Loaded ${Object.keys(map).length} codes from JSON.`);
  return map;
}

function getTeethSet(region) {
  const normalized = (region || '').toLowerCase().trim();
  const result = new Set();

  if (normalized.includes('anterior')) ANTERIOR_TEETH.forEach(t => result.add(t));
  if (normalized.includes('bicuspid')) BICUSPID_TEETH.forEach(t => result.add(t));
  if (normalized.includes('posterior')) POSTERIOR_TEETH.forEach(t => result.add(t));

  if (normalized === 'all' || result.size === 0) {
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

      const meta = codeToMeta[code];
      if (!meta) {
        console.warn(`[E001] Code not in JSON: ${code}`);
        rows.push({
          claimId,
          activityId,
          code,
          description: 'UNKNOWN CODE',
          details: '',
          remarks: ['[E001] Code not found in JSON'],
          isValid: false
        });
        return;
      }

      console.log(`\nActivity ID: ${activityId}, Code: ${code}`);
      console.log(`→ Description: ${meta.description}`);
      console.log(`→ Valid teeth for this code:`, [...meta.teethSet]);

      let isValid = true;
      const remarks = [];

      const details = Array.from(obsList).map(obs => {
        const codeElem = obs.querySelector('Code');
        if (!codeElem) {
          remarks.push('[E002] Observation missing <Code> element');
          isValid = false;
          console.warn(`[E002] Observation missing <Code>`);
          return 'Invalid Observation (no <Code>)';
        }

        const obsCodeRaw = codeElem.textContent || '';
        const obsCode = obsCodeRaw.trim().toUpperCase().replace(/^0+/, '');

        console.log(`→ Checking Tooth: [${obsCodeRaw}] → Normalized: [${obsCode}]`);

        if (!obsCode) {
          remarks.push('[E002] Empty code value in <Code>');
          isValid = false;
          return 'Invalid Observation (empty code)';
        }

        if (!meta.teethSet.has(obsCode)) {
          remarks.push(`[E003] Invalid Tooth - ${obsCode}`);
          isValid = false;
          console.warn(`[E003] ${obsCode} not in allowed teeth set`);
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
  setupFileNameDisplay('xmlFile', 'xmlFileName');
});
