// checker_tooths.js
// -----------------------
// Main entry point: reads XML and repo JSON then processes data

const repoJsonUrl = 'checker_tooths.json';

// Define all tooth sets (uppercase strings for letters)
const ANTERIOR_TEETH = new Set([
  '6','7','8','9','10','11','22','23','24','25','26','27',  // permanent anterior
  'C','D','E','F','G','H','M','N','O','P'                  // primary anterior
]);

const BICUSPID_TEETH = new Set([
  '4','5','12','13','20','21','28','29',  // permanent premolars
]);

const POSTERIOR_TEETH = new Set([
  '1','2','3','14','15','16','17','18','19','30','31','32',  // permanent molars
  'A','B','I','J','K','L','Q','R','S','T'                  // primary molars
]);

// Combine all known teeth into one set (to validate unknown teeth)
const ALL_TEETH = new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH, ...POSTERIOR_TEETH]);

/**
 * Normalize tooth code from XML (trim + uppercase)
 * @param {string} code 
 * @returns {string}
 */
function normalizeToothCode(code) {
  return code?.toString().trim().toUpperCase() || '';
}

/**
 * Map affiliated_teeth string to corresponding tooth sets
 * @param {string} region 
 * @returns {Set<string>}
 */
function getTeethSet(region) {
  if (!region) return ALL_TEETH; // default all if missing

  const regionLC = region.toLowerCase().trim();

  if (regionLC === 'all') {
    console.log(`Teeth region "${region}" mapped to ALL_TEETH`);
    return ALL_TEETH;
  }

  let teethSet = new Set();

  if (regionLC.includes('anterior')) {
    ANTERIOR_TEETH.forEach(t => teethSet.add(t));
  }
  if (regionLC.includes('bicuspid')) {
    BICUSPID_TEETH.forEach(t => teethSet.add(t));
  }
  if (regionLC.includes('posterior')) {
    POSTERIOR_TEETH.forEach(t => teethSet.add(t));
  }

  // If nothing matched, default to ALL_TEETH (fail safe)
  if (teethSet.size === 0) {
    console.warn(`Teeth region "${region}" did not match any known set. Using ALL_TEETH as fallback.`);
    return ALL_TEETH;
  }

  console.log(`Teeth region "${region}" mapped to set: [${[...teethSet].join(', ')}]`);
  return teethSet;
}

/**
 * Check if tooth code is valid for a given teeth set
 * @param {string} toothCode 
 * @param {Set<string>} allowedSet 
 * @returns {boolean}
 */
function isToothValid(toothCode, allowedSet) {
  // Normalize the tooth code
  const tCode = normalizeToothCode(toothCode);

  // If tooth code is unknown (not in ALL_TEETH), consider invalid
  if (!ALL_TEETH.has(tCode)) {
    console.warn(`Unknown tooth code encountered: "${tCode}"`);
    return false;
  }

  // Check if tooth code is allowed for this code's affiliated teeth
  const valid = allowedSet.has(tCode);
  console.log(`Tooth "${tCode}" validation against allowed set: ${valid ? 'VALID' : 'INVALID'}`);
  return valid;
}

/**
 * Reads user-selected XML and repo JSON,
 * then initiates validation and rendering.
 */
function parseXML() {
  const xmlInput = document.getElementById('xmlFile');
  const resultsDiv = document.getElementById('results');

  // Ensure XML file is provided
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
  .catch(err => showMessage(resultsDiv, err.message));
}

/**
 * Returns a Promise resolving to the text of the provided XML file.
 * @param {File} file 
 * @returns {Promise<string>}
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
 * Parses XML + JSON data, validates activities, and renders output.
 * @param {string} xmlData 
 * @param {string} jsonData 
 * @param {HTMLElement} resultsDiv 
 */
function tryProcess(xmlData, jsonData, resultsDiv) {
  const codeToMeta = buildCodeMeta(jsonData);
  const xmlDoc = new DOMParser().parseFromString(xmlData, 'text/xml');
  const rows = validateActivities(xmlDoc, codeToMeta);
  renderResults(resultsDiv, rows);
}

/**
 * Builds a map: procedure code -> { teethSet, description }
 * @param {string} jsonText 
 * @returns {Object<string, {teethSet: Set<string>, description: string}>}
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
        description: entry.description || '[Code N/A within JSON Repository]'
      };
      console.log(`Mapping code "${code}" to description "${map[code].description}" with teeth: [${[...teethSet].join(', ')}]`);
    });
  });
  return map;
}

/**
 * Determines the human-readable region name for a given tooth number.
 * @param {string} tooth 
 * @returns {string}
 */
function getRegionName(tooth) {
  const t = normalizeToothCode(tooth);
  if (ANTERIOR_TEETH.has(t)) return 'Anterior';
  if (BICUSPID_TEETH.has(t)) return 'Bicuspid';
  if (POSTERIOR_TEETH.has(t)) return 'Posterior';
  return 'Unknown';
}

/**
 * Iterates claims/activities, validates each observation,
 * and collects row data for rendering.
 * @param {Document} xmlDoc 
 * @param {Object<string, {teethSet: Set<string>, description: string}>} codeToMeta 
 * @returns {Array}
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

      const meta = codeToMeta[code] || { teethSet: ALL_TEETH, description: '(no description)' };
      console.log(`\nActivity: ${activityId}, Code: ${code}, Description: ${meta.description}`);
      console.log(`Valid teeth for this code: [${[...meta.teethSet].join(', ')}]`);

      let isValid = true;
      const remarks = [];

      const details = Array.from(obsList).map(obs => {
        const obsCodeRaw = obs.querySelector('Code')?.textContent || '';
        const obsCode = normalizeToothCode(obsCodeRaw);

        console.log(`Checking tooth: "${obsCode}"`);

        if (!isToothValid(obsCode, meta.teethSet)) {
          isValid = false;
          remarks.push(`Invalid - ${obsCode}`);
          console.log(`--> INVALID: ${obsCode} not allowed for this code.`);
        } else {
          remarks.push(`Valid - ${obsCode}`);
          console.log(`--> VALID: ${obsCode} allowed for this code.`);
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

/**
 * Renders the results table or a no-data message inside #results,
 * updating the hidden #outputTable element.
 * @param {HTMLElement} container 
 * @param {Array} rows 
 */
function renderResults(container, rows) {
  const table = document.getElementById('outputTable');
  if (!rows.length) {
    container.innerHTML = '<p>No activities with observations found.</p>';
    if(table) table.style.display = 'none';
    return;
  }

  const rowsHtml = rows.map(row => `
    <tr style="background-color:${row.isValid ? 'transparent' : '#fcc'};">
      <td>${row.claimId}</td>
      <td>${row.activityId}</td>
      <td>${row.code}</td>
      <td>${row.description}</td>
      <td>${row.details}</td>
      <td>${row.remarks.join('<br>')}</td>
    </tr>
  `).join('\n');

  const html = `
    <table border="1" style="border-collapse:collapse; width: 100%;">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Activity ID</th>
          <th>Code</th>
          <th>Description</th>
          <th>Tooth Details</th>
          <th>Validation Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  `;

  container.innerHTML = html;
  if(table) table.style.display = 'table';
}

/**
 * Utility to show messages
 * @param {HTMLElement} container 
 * @param {string} msg 
 */
function showMessage(container, msg) {
  container.innerHTML = `<p style="color:red;">${msg}</p>`;
}

// Hook the file input and button on the page (example HTML assumed)
// <input type="file" id="xmlFile" accept=".xml">
// <button onclick="parseXML()">Validate XML</button>
// <div id="results"></div>

