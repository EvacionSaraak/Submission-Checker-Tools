const repoJsonUrl = 'checker_tooths.json';

const SEXTANT_MAP = {
  // Permanent Dentition
  'Upper Right Sextant': new Set(['1', '2', '3', '4', '5']),
  'Upper Anterior Sextant': new Set(['6', '7', '8', '9', '10', '11']),
  'Upper Left Sextant': new Set(['12', '13', '14', '15', '16']),
  'Lower Left Sextant': new Set(['17', '18', '19', '20', '21']),
  'Lower Anterior Sextant': new Set(['22', '23', '24', '25', '26', '27']),
  'Lower Right Sextant': new Set(['28', '29', '30', '31', '32']),

  // Primary Dentition
  'Upper Right Sextant (Primary)': new Set(['A', 'B', 'C']),
  'Upper Anterior Sextant (Primary)': new Set(['D', 'E', 'F', 'G']),
  'Upper Left Sextant (Primary)': new Set(['H', 'I', 'J']),
  'Lower Left Sextant (Primary)': new Set(['K', 'L', 'M']),
  'Lower Anterior Sextant (Primary)': new Set(['N', 'O', 'P', 'Q']),
  'Lower Right Sextant (Primary)': new Set(['R', 'S', 'T'])
};

const QUADRANT_MAP = {
  'Upper Right': new Set(['1','2','3','4','5','6','7','8','9','10','11','A','B','C','D','E']),
  'Upper Left': new Set(['12','13','14','15','16','17','18','19','20','21','22','F','G','H','I','J']),
  'Lower Left': new Set(['23','24','25','26','27','28','29','30','31','32','K','L','M','N','O']),
  'Lower Right': new Set(['33','34','35','36','37','38','39','40','41','42','43','44','45','46','47','48','P','Q','R','S','T'])
};

// Tooth sets
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

function getQuadrant(tooth) {
  const t = normalizeToothCode(tooth);
  for (const [quadrant, set] of Object.entries(QUADRANT_MAP)) {
    if (set.has(t)) return quadrant;
  }
  return 'Unknown';
}

function getSextant(tooth) {
  const t = normalizeToothCode(tooth);
  for (const [sextant, set] of Object.entries(SEXTANT_MAP)) {
    if (set.has(t)) return sextant;
  }
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
    console.log('[parseXML] XML, tooth codes, and auth metadata loaded');
    const toothMap = buildCodeMeta(toothJson);
    console.log('[parseXML] Built code meta:', toothMap);
    const authMap  = buildAuthMap(authJson);
    const xmlDoc   = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xmlDoc.querySelector('parsererror')) throw new Error('Invalid XML file');
    const rows     = validateActivities(xmlDoc, toothMap, authMap);
    renderResults(resultsDiv, rows);
  })
  .catch(err => {
    messageBox.textContent = err.toString();
    console.error('[parseXML] Error:', err);
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

function parseObservationCodes(obsList) {
  return Array.from(obsList).map(obs => {
    const obsCodeRaw = obs.querySelector('Code')?.textContent.trim() || '';
    return obsCodeRaw.toUpperCase();
  }).filter(Boolean);
}

function checkRegionDuplication(tracker, code, regionType, regionKey, codeLastDigit) {
  const key = `${regionKey}_${code}`;
  if (tracker[key]) {
    if (codeLastDigit !== '9') {
      return [`Duplicate ${regionType} code "${code}" in ${regionKey}`];
    }
    // else, valid because code ends with 9
    return [];
  }
  tracker[key] = true;
  return [];
}

function validateUnknownCode({
  claimId, activityId, code, obsCodes, description, claimRegionTrack, codeLastDigit
}) {
  let remarks = [];
  let details = '';
  const isRegion = description.toLowerCase().includes('sextant') || description.toLowerCase().includes('quadrant');
  let regionType = null;
  if (isRegion) {
    regionType = description.toLowerCase().includes('sextant') ? 'sextant' : 'quadrant';
  }

  let regionKey = null;

  if (isRegion && obsCodes.length > 0) {
    details = obsCodes.map(obsCode => {
      let regionRemark = '';
      if (regionType === 'sextant') {
        regionKey = getSextant(obsCode);
      } else if (regionType === 'quadrant') {
        regionKey = getQuadrant(obsCode);
      }
      if (regionType && regionKey && regionKey !== 'Unknown') {
        const tracker = claimRegionTrack[regionType];
        const dupRemarks = checkRegionDuplication(tracker, code, regionType, regionKey, codeLastDigit);
        if (dupRemarks.length) {
          remarks.push(...dupRemarks);
          regionRemark = dupRemarks[0];
        } else {
          regionRemark = `Valid - ${obsCode}`;
        }
      } else {
        regionRemark = `Valid - ${obsCode}`;
      }
      return `${obsCode} - ${regionRemark}`;
    }).join('<br>');
  } else if (obsCodes.length > 0) {
    remarks.push(`Unknown code in repo; obsCodes present: ${obsCodes.join(', ')}`);
    details = obsCodes.join('<br>');
  } else {
    details = 'N/A';
  }

  if (obsCodes.length === 0 && isRegion) {
    // Only flag as invalid if description implies region
    remarks.push(`Invalid - No tooth (Observation) specified for unknown code "${code}" (region type: ${regionType}).`);
  }
  console.log(`[validateUnknownCode] Activity ${activityId}:`, {code, obsCodes, remarks, details});
  return buildActivityRow({claimId, activityId, code, description, details, remarks});
}

function validateKnownCode({
  claimId, activityId, code, obsCodes, meta, claimRegionTrack, codeLastDigit
}) {
  const regionType = meta.description.toLowerCase().includes('sextant') ? 'sextant'
    : meta.description.toLowerCase().includes('quadrant') ? 'quadrant'
    : null;

  let regionKey = null;
  const remarks = [];

  // Special handling for codes 17999 and 0232T
  if (code === "17999" || code === "0232T") {
    if (obsCodes.length === 0) {
      remarks.push(`Invalid: Code "${code}" requires at least one observation code, but none were provided.`);
    } else {
      // Consider obsCodes that are not "PDF" for tooth code check
      const nonPDFObs = obsCodes.filter(oc => oc !== 'PDF');
      const toothCodesUsed = nonPDFObs.filter(oc => ALL_TEETH.has(oc));
      if (toothCodesUsed.length > 0) {
        remarks.push(`Invalid: Code "${code}" cannot be used with tooth codes: ${toothCodesUsed.join(", ")}`);
      }
    }
    return buildActivityRow({
      claimId,
      activityId,
      code,
      description: meta.description,
      details: obsCodes.length ? obsCodes.join('<br>') : 'None provided',
      remarks
    });
  }

  if (obsCodes.length === 0) {
    remarks.push(`No tooth number provided for code "${code}".`);
  }

  const details = obsCodes.length === 0
    ? 'None provided'
    : obsCodes.map(obsCode => {
      if (obsCode === 'PDF') {
        return 'PDF (no validation)';
      }
      let thisRemark = '';
      if (!meta.teethSet.has(obsCode)) {
        thisRemark = `Tooth "${obsCode}" not allowed for code "${code}" (expected: ${meta.description.match(/anterior|posterior|bicuspid|all/i)?.[0] || 'see code description'})`;
        remarks.push(thisRemark);
      }
      if (regionType === 'sextant') {
        regionKey = getSextant(obsCode);
      } else if (regionType === 'quadrant') {
        regionKey = getQuadrant(obsCode);
      }
      return `${obsCode} - ${getRegionName(obsCode)}${thisRemark ? ' | ' + thisRemark : ''}`;
    }).join('<br>');

  if (regionType && regionKey && regionKey !== 'Unknown') {
    const tracker = claimRegionTrack[regionType];
    const dupRemarks = checkRegionDuplication(tracker, code, regionType, regionKey, codeLastDigit);
    if (dupRemarks.length) {
      remarks.push(...dupRemarks);
    }
  }
  console.log(`[validateKnownCode] Activity ${activityId}:`, {code, obsCodes, remarks, details});
  return buildActivityRow({
    claimId,
    activityId,
    code,
    description: meta.description,
    details,
    remarks
  });
}

function buildActivityRow({claimId, activityId, code, description, details, remarks}) {
  return {
    claimId,
    activityId,
    code,
    description,
    details,
    remarks
  };
}

function validateActivities(xmlDoc, codeToMeta, fallbackDescriptions) {
  console.log('[validateActivities] Start');
  const rows = [];
  const claimSummaries = {};
  const claimRegionTrack = {};

  Array.from(xmlDoc.getElementsByTagName('Claim')).forEach(claim => {
    const claimId = claim.querySelector('ID')?.textContent || '(no claim ID)';
    claimRegionTrack[claimId] = { sextant: {}, quadrant: {} };

    let claimHasInvalid = false;

    Array.from(claim.getElementsByTagName('Activity')).forEach(act => {
      const obsList = act.getElementsByTagName('Observation');
      const activityId = act.querySelector('ID')?.textContent || '';
      const rawCode = act.querySelector('Code')?.textContent || '';
      const code = rawCode.trim();
      const codeLastDigit = code.slice(-1);

      let meta = codeToMeta[code];
      let fallback = fallbackDescriptions?.[code];
      const obsCodes = parseObservationCodes(obsList);

      let row;
      if (!meta) {
        let description = '(unknown code)';
        if (fallback && fallback.description) {
          description = fallback.description;
        }
        row = validateUnknownCode({
          claimId, activityId, code, obsCodes, description, claimRegionTrack: claimRegionTrack[claimId], codeLastDigit
        });
      } else {
        row = validateKnownCode({
          claimId, activityId, code, obsCodes, meta, claimRegionTrack: claimRegionTrack[claimId], codeLastDigit
        });
      }

      if (row.remarks && row.remarks.length > 0) claimHasInvalid = true;
      rows.push(row);
    });

    claimSummaries[claimId] = claimHasInvalid;
  });

  rows.__claimSummaries = claimSummaries;
  console.log('[validateActivities] Finished, result:', rows);
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
  window.invalidRows = rows.filter(r => r.remarks && r.remarks.length > 0);
  document.getElementById('exportBtn').style.display = window.invalidRows.length ? 'inline-block' : 'none';

  const claimSummaries = rows.__claimSummaries || {};
  const totalClaims = Object.keys(claimSummaries).length;
  const validClaims = Object.values(claimSummaries).filter(isInvalid => !isInvalid).length;
  const percentage = totalClaims === 0 ? "0.0" : ((validClaims / totalClaims) * 100).toFixed(1);

  summaryBox.textContent = `Valid claims: ${validClaims} / ${totalClaims} (${percentage}%)`;

  const html = `
    <table border="1" style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Activity ID</th>
          <th>Code</th>
          <th class="description-col">Description</th>
          <th>Observations</th>
          <th class="description-col">Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const showClaimId = r.claimId !== lastClaimId;
          lastClaimId = r.claimId;
          const invalidClass = r.remarks && r.remarks.length > 0 ? 'invalid' : 'valid';
          return `
            <tr class="${invalidClass}">
              <td>${showClaimId ? r.claimId : ''}</td>
              <td>${r.activityId}</td>
              <td>${r.code}</td>
              <td class="description-col">${r.description}</td>
              <td>${r.details}</td>
              <td class="description-col">${r.remarks.join('<br>')}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  container.innerHTML = html;
  console.log('[renderResults] Rendered table with', rows.length, 'rows');
}
