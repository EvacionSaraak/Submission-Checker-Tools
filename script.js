// script.js
// -----------------------
// Main entry point: reads XML and JSON (or repo) then processes data

const repoJsonUrl = 'tooth validity.json';

// Predefined tooth sets by region
const ANTERIOR_TEETH = new Set([
  '6','7','8','9','10','11','22','23','24','25','26','27',  // permanent anterior
  'C','D','E','F','G','H','M','N','O','P'                   // primary anterior
]);

const BICUSPID_TEETH = new Set([
  '4','5','12','13','20','21','28','29',  // permanent premolars (no primary equivalent)
]);

const POSTERIOR_TEETH = new Set([
  '1','2','3','14','15','16','17','18','19','30','31','32',  // permanent molars
  'A','B','I','J','K','L','Q','R','S','T'                    // primary molars
]);

/**
 * Reads user-selected XML and JSON (optional) / repo JSON,
 * then initiates validation and rendering.
 */
function parseXML() {
  const xmlInput = document.getElementById('xmlFile');
  const jsonInput = document.getElementById('jsonFile');
  const resultsDiv = document.getElementById('results');

  // Ensure XML file is provided
  if (!xmlInput?.files.length) {
    return showMessage(resultsDiv, 'Please upload an XML file.');
  }

  // Read both XML and JSON (uploaded or repo) in parallel
  Promise.all([
    readXMLFile(xmlInput.files[0]),
    readJSONOrRepo(jsonInput)
  ])
    .then(([xmlData, jsonData]) => tryProcess(xmlData, jsonData, resultsDiv))
    .catch(err => showMessage(resultsDiv, err.message));
}

/**
 * Returns a Promise resolving to the text of the provided XML file.
 */
function readXMLFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Error reading XML file'));
    reader.readAsText(file);
  });
}

/**
 * Returns a Promise resolving to JSON text: prefers uploaded file, falls back to repo fetch.
 */
function readJSONOrRepo(jsonInput) {
  if (jsonInput?.files.length) {
    // Uploaded JSON for debugging
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Error reading uploaded JSON file'));
      reader.readAsText(jsonInput.files[0]);
    });
  }
  // Fetch repository JSON
  return fetch(repoJsonUrl)
    .then(resp => {
      if (!resp.ok) throw new Error(`Could not load repository JSON (HTTP ${resp.status})`);
      return resp.text();
    });
}

/**
 * Parses XML + JSON data, validates activities, and renders output.
 */
function tryProcess(xmlData, jsonData, resultsDiv) {
  const codeToMeta = buildCodeMeta(jsonData);
  const xmlDoc = new DOMParser().parseFromString(xmlData, 'text/xml');
  const rows = validateActivities(xmlDoc, codeToMeta);
  renderResults(resultsDiv, rows);
}

/**
 * Builds a map: procedure code -> { teethSet, description }
 */
function buildCodeMeta(jsonText) {
  let map = {};
  const data = JSON.parse(jsonText);
  data.forEach(entry => {
    const teethSet = getTeethSet(entry.affiliated_teeth);
    (entry.codes || []).forEach(raw => {
      const code = raw.toString().trim();
      map[code] = {
        teethSet,
        description: entry.description || '(no description)'
      };
    });
  });
  return map;
}

/**
 * Returns the Set of valid teeth given an affiliated_teeth region string.
 */
function getTeethSet(region) {
  const normalized = (region || '').toLowerCase().trim();

  if (normalized === 'all') { return new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH, ...POSTERIOR_TEETH]); }
  if ((normalized.includes('anterior') && normalized.includes('bicuspid')) && normalized.includes('posterior')) { 
    return new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH, ...POSTERIOR_TEETH]); 
  }
  if (normalized.includes('anterior') && normalized.includes('bicuspid')) { return new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH]); }
  if (normalized.includes('anterior') && normalized.includes('posterior')) { return new Set([...ANTERIOR_TEETH, ...POSTERIOR_TEETH]); }
  if (normalized.includes('bicuspid') && normalized.includes('posterior')) { return new Set([...BICUSPID_TEETH, ...POSTERIOR_TEETH]); }
  if (normalized.includes('posterior')) { return POSTERIOR_TEETH; }
  if (normalized.includes('bicuspid')) { return BICUSPID_TEETH; }
  if (normalized.includes('anterior')) { return ANTERIOR_TEETH; }

  // Fallback for unknown or empty region
  return new Set();
}


/**
 * Determines the human-readable region name for a given tooth number.
 */
function getRegionName(tooth) {
  if (ANTERIOR_TEETH.has(tooth)) return 'Anterior';
  if (BICUSPID_TEETH.has(tooth)) return 'Bicuspid';
  if (POSTERIOR_TEETH.has(tooth)) return 'Posterior';
  return 'Unknown';
}

/**
 * Iterates claims/activities, validates each observation,
 * and collects row data for rendering.
 */
function validateActivities(xmlDoc, codeToMeta) {
  const rows = [];

  Array.from(xmlDoc.getElementsByTagName('Claim')).forEach(claim => {
    const claimId = claim.querySelector('ID')?.textContent || '(no claim ID)';

    Array.from(claim.getElementsByTagName('Activity')).forEach(act => {
      const obsList = act.getElementsByTagName('Observation');
      if (!obsList.length) return; // Skip if no observations

      const activityId = act.querySelector('ID')?.textContent || '';
      const code = act.querySelector('Code')?.textContent.trim() || '';
      const net = act.querySelector('Net')?.textContent || '';

      const meta = codeToMeta[code] || { teethSet: new Set(), description: '(no description)' };
      console.log(`\nActivity: ${activityId}, Code: ${code}, Description: ${meta.description}`);
      console.log(`Valid teeth for this code:`, [...meta.teethSet]);

      let isValid = true;
      const remarks = [];

      const details = Array.from(obsList).map(obs => {
        const type = obs.querySelector('Type')?.textContent || '';
        const obsCodeRaw = obs.querySelector('Code')?.textContent.trim() || '';
        const obsCode = obsCodeRaw.toUpperCase(); // Normalize to match tooth sets

        console.log(`Checking tooth: ${obsCode}`);

        if (!meta.teethSet.has(obsCode)) {
          isValid = false;
          remarks.push(`Invalid - ${obsCode}`);
          console.log(`--> INVALID: ${obsCode} not in meta.teethSet`);
        } else {
          remarks.push(`Valid - ${obsCode}`);
          console.log(`--> VALID: ${obsCode} found in meta.teethSet`);
        }

        return `${obsCode} - ${getRegionName(obsCode)}`;
      }).join('<br>');

      rows.push({
        claimId,
        activityId,
        code,
        description: meta.description,
        net,
        details,
        remarks,
        isValid
      });
    });
  });

  return rows;
}

/**
 * Renders the results table or a no-data message.
 */
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

  container.innerHTML = `<table border="1">
    <thead>${header}</thead>
    <tbody>${body}</tbody>
  </table>`;
}

/**
 * Utility: displays a simple message in the results container.
 */// After parseXML setup…
/**
 * AESTHETIC FORMATING SCRIPTS
 */


// Display selected file name under each input
function setupFileNameDisplay(inputId, displayId) {
  const input = document.getElementById(inputId);
  const display = document.getElementById(displayId);
  input.addEventListener('change', () => {
    const name = input.files.length ? input.files[0].name : 'No file chosen';
    display.textContent = name;
  });
}

function showMessage(container, message) {
  container.innerHTML = `<p>${message}</p>`;
}

// Wait for DOM to be ready before initializing
document.addEventListener('DOMContentLoaded', () => {
  setupFileNameDisplay('xmlFile', 'xmlFileName');
  setupFileNameDisplay('jsonFile', 'jsonFileName');
});

function showMessage(container, message) {
  container.innerHTML = `<p>${message}</p>`;
}

//DEV MODE DETECTION
document.addEventListener('DOMContentLoaded', () => {
  setupFileNameDisplay('xmlFile', 'xmlFileName');
  setupFileNameDisplay('jsonFile', 'jsonFileName');

  // Show developer mode if ?dev=true in the URL
  const params = new URLSearchParams(window.location.search);
  if (params.get('dev') === 'true') {
    const devSection = document.getElementById('devMode');
    if (devSection) devSection.style.display = 'flex';
  }
});

