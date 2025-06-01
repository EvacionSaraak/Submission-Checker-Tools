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

function buildAuthMap(authData) {
  // authData is assumed to be an array of entries like { code: "...", description: "...", ... }
  const map = {};
  authData.forEach(entry => {
    const code = entry.code?.toString().trim();
    if (code) {
      map[code] = {
        description: entry.description?.trim() || ''
      };
    }
  });
  return map;
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
  const xmlInput    = document.getElementById('xmlFile');
  const resultsDiv  = document.getElementById('results');
  const messageBox  = document.getElementById('messageBox');
  messageBox.textContent = '';
  resultsDiv.innerHTML   = '';

  if (!xmlInput.files.length) {
    messageBox.textContent = 'Please upload an XML file.';
    return;
  }
  const file = xmlInput.files[0];

  Promise.all([
    // Read uploaded XML
    new Promise((res, rej) => {
      const rdr = new FileReader();
      rdr.onload  = () => res(rdr.result);
      rdr.onerror = () => rej('Error reading XML');
      rdr.readAsText(file);
    }),
    // Load tooth‐code metadata
    fetch(repoJsonUrl)
      .then(r => r.ok ? r.json() : Promise.reject(`Failed to load ${repoJsonUrl} (HTTP ${r.status})`)),
    // Load authorization metadata for fallback
    fetch('checker_auths.json')
      .then(r => r.ok ? r.json() : Promise.reject(`Failed to load checker_auths.json (HTTP ${r.status})`))
  ])
  .then(([xmlText, toothJson, authJson]) => {
    const toothMap = buildCodeMeta(toothJson);
    const authMap  = buildAuthMap(authJson);
    const xmlDoc   = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xmlDoc.querySelector('parsererror')) throw new Error('Invalid XML file');
    const rows     = validateActivities(xmlDoc, toothMap, authMap);
    renderResults(resultsDiv, rows);
  })
  .catch(err => {
    messageBox.textContent = err.toString();
  });
}

function buildCodeMeta(data) {
  const map = {};
  data.forEach(entry => {
    const codesArray = Array.isArray(entry.codes) ? entry.codes : (
      entry.codes ? [entry.codes] : (
        entry.code ? [entry.code] : []
      )
    );

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

// ---------------------------------------
// Helper: Map a tooth code into a quadrant
// ---------------------------------------
function getQuadrant(tooth) {
  const t = String(tooth).toUpperCase();
  const num = Number(t);
  if (!isNaN(num)) {
    if (num >= 1 && num <= 8)   return 'UR';
    if (num >= 9 && num <= 16)  return 'UL';
    if (num >= 17 && num <= 24) return 'LL';
    if (num >= 25 && num <= 32) return 'LR';
  }
  if ('ABCDE'.includes(t))      return 'UR';
  if ('FGHIJ'.includes(t))      return 'UL';
  if ('KLMNO'.includes(t))      return 'LL';
  if ('PQRST'.includes(t))      return 'LR';
  return 'Unknown';
}

// ---------------------------------------
// Helper: Map a tooth code into a sextant
// Sextants:  
//  S1 = Upper Right Posterior (teeth 1–3 or A–C)  
//  S2 = Upper Anterior (4–13 or D–K)  
//  S3 = Upper Left Posterior (14–16 or L–O)  
//  S4 = Lower Left Posterior (17–19 or P–R)  
//  S5 = Lower Anterior (20–29 or S–T)  
//  S6 = Lower Right Posterior (30–32 or None)  
// Adjust as needed for primary/secondary mapping.
// ---------------------------------------
function getSextant(tooth) {
  const t = String(tooth).toUpperCase();
  const num = Number(t);

  if (!isNaN(num)) {
    if (num >= 1 && num <= 5)   return 'S1'; // Upper Right Posterior
    if (num >= 6 && num <= 11)  return 'S2'; // Upper Anterior
    if (num >= 12 && num <= 16) return 'S3'; // Upper Left Posterior
    if (num >= 17 && num <= 21) return 'S4'; // Lower Left Posterior
    if (num >= 22 && num <= 27) return 'S5'; // Lower Anterior
    if (num >= 28 && num <= 32) return 'S6'; // Lower Right Posterior
  } else {
    if ('A,B,C'.includes(t)) return 'S1';
    if ('D,E,F,G'.includes(t)) return 'S2';
    if ('H,I,J'.includes(t)) return 'S3';
    if ('K,L,M'.includes(t)) return 'S4';
    if ('N,O,P,Q'.includes(t)) return 'S5';
    if ('R,S,T'.includes(t)) return 'S6';
  }

  return 'Unknown';
}

// ---------------------------------------
// Optional label helpers
// ---------------------------------------
function quadrantLabel(q) {
  switch (q) {
    case 'UR': return 'Upper Right';
    case 'UL': return 'Upper Left';
    case 'LL': return 'Lower Left';
    case 'LR': return 'Lower Right';
    default:   return q;
  }
}
function sextantLabel(s) {
  switch (s) {
    case 'S1': return 'Upper Right Posterior';
    case 'S2': return 'Upper Anterior';
    case 'S3': return 'Upper Left Posterior';
    case 'S4': return 'Lower Left Posterior';
    case 'S5': return 'Lower Anterior';
    case 'S6': return 'Lower Right Posterior';
    default:   return s;
  }
}

// --------------------------------------------------------
// Updated validateActivities: support conditional region‐check
// --------------------------------------------------------
function validateActivities(xmlDoc, codeToMeta, authMap) {
  const rows = [];

  Array.from(xmlDoc.getElementsByTagName('Claim')).forEach(claim => {
    const claimId = claim.querySelector('ID')?.textContent || '(no claim ID)';

    // We’ll track seen keys separately per claim:
    const seenQuadrantPairs = new Set();
    const seenSextantPairs = new Set();

    Array.from(claim.getElementsByTagName('Activity')).forEach(act => {
      const obsList = act.getElementsByTagName('Observation');
      if (!obsList.length) return;

      const activityId = act.querySelector('ID')?.textContent || '';
      const rawCode    = act.querySelector('Code')?.textContent || '';
      const code       = rawCode.trim();

      // 1) PDF override as before
      let containsPDF = false;
      Array.from(obsList).forEach(obs => {
        const obsCodeRaw = obs.querySelector('Code')?.textContent.trim() || '';
        if (obsCodeRaw.toUpperCase() === 'PDF') {
          containsPDF = true;
        }
      });
      if (containsPDF) {
        rows.push({
          claimId,
          activityId,
          code,
          description: '(PDF—no tooth validation)',
          details: 'PDF',
          remarks: ['PDF override—marked valid'],
          isValid: true
        });
        return;
      }

      // 2) Lookup tooth metadata + fallback to authMap for description
      const toothMeta   = codeToMeta[code] || { teethSet: new Set(), description: '' };
      let description   = (toothMeta.description || '').trim();
      if (!description && authMap[code]?.description) {
        description = authMap[code].description.trim();
      }
      const descMissing = !description;

      // 3) Determine if we must enforce quadrant or sextant checks
      //    We do NOT enforce either unless description contains the keyword
      const enforceQuadrant = /quadrant/i.test(description);
      const enforceSextant  = /sextant/i.test(description);

      // 4) Build the set of valid teeth for this code
      const teethSet = toothMeta.teethSet;

      let isValid = true;
      const details = [];
      const remarks = [];

      // 5) Loop through each Observation
      Array.from(obsList).forEach(obs => {
        const obsCodeRaw = obs.querySelector('Code')?.textContent.trim() || '';
        const obsCode    = obsCodeRaw.toUpperCase();

        // Collect detail: “TOOTH – REGION (Quadrant/Sextant if enforced)”
        let regionInfo = '';
        if (enforceQuadrant) {
          const q = getQuadrant(obsCode);
          regionInfo = ` (${quadrantLabel(q)})`;
        } else if (enforceSextant) {
          const s = getSextant(obsCode);
          regionInfo = ` (${sextantLabel(s)})`;
        }
        details.push(`${obsCode} - ${getRegionName(obsCode)}${regionInfo}`);

        // Check if tooth is allowed at all
        if (!teethSet.has(obsCode)) {
          isValid = false;
          remarks.push(`Invalid tooth ${obsCode}`);
        } else {
          // If quadrant enforcement is ON:
          if (enforceQuadrant) {
            const q = getQuadrant(obsCode);
            const key = `${code}|${q}`;
            if (seenQuadrantPairs.has(key)) {
              isValid = false;
              remarks.push(`Duplicate code ${code} in ${q}`);
            } else {
              seenQuadrantPairs.add(key);
              remarks.push(`Valid ${obsCode} in ${q}`);
            }
          }
          // Else if sextant enforcement is ON:
          else if (enforceSextant) {
            const s = getSextant(obsCode);
            const key = `${code}|${s}`;
            if (seenSextantPairs.has(key)) {
              isValid = false;
              remarks.push(`Duplicate code ${code} in ${s}`);
            } else {
              seenSextantPairs.add(key);
              remarks.push(`Valid ${obsCode} in ${s}`);
            }
          }
          // Otherwise (neither), just mark valid by default
          else {
            remarks.push(`Valid - ${obsCode}`);
          }
        }
      });

      // 6) If description is still missing → invalid
      if (descMissing) {
        isValid = false;
        remarks.unshift('No description found for code');
      }

      rows.push({
        claimId,
        activityId,
        code,
        description: description || '(no description)',
        details: details.join('<br>'),
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
