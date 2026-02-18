(function() {
  try {
    const repoJsonUrl = 'checker_tooths.json';

    // Tooth region maps and sets
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

const ANTERIOR_TEETH = new Set([
  '6','7','8','9','10','11',
  '22','23','24','25','26','27',
  'C','D','E','F','G','H',
  'M','N','O','P','Q','R'
]);
const BICUSPID_TEETH = new Set([
  '4','5','12','13',
  '20','21','28','29'
]);
const POSTERIOR_TEETH = new Set([
  '1','2','3','14','15','16',
  '17','18','19','30','31','32',
  'A','B','I','J',
  'K','L','S','T'
]);
const ALL_TEETH = new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH, ...POSTERIOR_TEETH]);

// Special medical codes (global array)
const SPECIAL_MEDICAL_CODES = [
  { code: "17999", description: "Unlisted procedure, skin, mucous membrane, and subcutaneous tissue" },
  { code: "0232T", description: "Injection(s), platelet-rich plasma, any site, including image guidance, harvesting and preparation when performed" },
  { code: "J3490", description: "Unclassified drugs" },
  { code: "81479", description: "Unlisted molecular pathology procedure" },
  { code: "41899", description: "Unlisted procedure, dentoalveolar structures" }
  // { code: "69090", description: "Biopsy of external ear" },
  // { code: "11950", description: "Subcutaneous injection of filling material (e.g., collagen); 1 to 5 cc" },
  // { code: "11951", description: "Subcutaneous injection of filling material (e.g., collagen); 6 to 10 cc" },
  // { code: "11952", description: "Subcutaneous injection of filling material (e.g., collagen); 11 to 50 cc" }
];

// Utility functions: normalization, region/teeth lookup, and code/meta mapping
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

// Special code utilities
function isSpecialMedicalCode(code) {
  return SPECIAL_MEDICAL_CODES.some(item => item.code === code);
}

function getSpecialMedicalCodeDescription(code) {
  const item = SPECIAL_MEDICAL_CODES.find(item => item.code === code);
  return item?.description || "";
}

function hasValidActivityDescription(obsList) {
  function normalizeDesc(s) {
    if (!s) return '';
    // normalize unicode, collapse whitespace, trim and uppercase
    return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toUpperCase();
  }

  return Array.from(obsList).some(obs => {
    const rawDesc = obs.querySelector('Description')?.textContent;
    const rawCode = obs.querySelector('Code')?.textContent;
    const desc = normalizeDesc(rawDesc);
    const code = normalizeDesc(rawCode);
    console.log('hasValidActivityDescription check -> Description:', JSON.stringify(rawDesc), 'Code:', JSON.stringify(rawCode), '=>', desc, code);
    return desc === "ACTIVITY DESCRIPTION" || code === "ACTIVITY DESCRIPTION";
  });
}

// Special code handler
function handleSpecialMedicalCode({claimId, activityId, type, code, obsCodes, obsList}) {
  const remarks = [];
  let details = "";

  // Keep existing exception: if ALL observations are PDF or Drug Patient Share, accept.
  const allDrugShareOrPDF = obsCodes.length > 0 && obsCodes.every(isDrugPatientShareOrPDF);
  if (allDrugShareOrPDF) {
    details = obsCodes.map(oc =>
      oc === 'Drug Patient Share' ? 'Drug Patient Share (valid - no validation)' : 'PDF (valid - no validation)'
    ).join('<br>');
    return buildActivityRow({
      claimId,
      activityId,
      type,
      code,
      description: getSpecialMedicalCodeDescription(code),
      details,
      remarks: []
    });
  }

  // Require exact ACTIVITY DESCRIPTION (in either Description or Code)
  const hasExactActivityDescription = hasValidActivityDescription(obsList);
  if (hasExactActivityDescription) {
    details = 'Valid: ACTIVITY DESCRIPTION observation present';
    return buildActivityRow({
      claimId,
      activityId,
      type,
      code,
      description: getSpecialMedicalCodeDescription(code),
      details,
      remarks: []
    });
  }

  // Not valid: build appropriate remarks and details
  if (obsCodes.length === 0) {
    remarks.push(`${code} requires at least one observation code but none were provided.`);
    details = 'None provided';
  } else {
    // Show observations (mark PDF / Drug Patient Share specially)
    details = obsCodes.map(oc =>
      isDrugPatientShareOrPDF(oc) ? (oc === 'Drug Patient Share' ? 'Drug Patient Share (valid - no validation)' : 'PDF (valid - no validation)') : oc
    ).join('<br>');

    const nonPDFObs = obsCodes.filter(oc => !isDrugPatientShareOrPDF(oc));
    const toothCodesUsed = nonPDFObs.filter(oc => ALL_TEETH.has(oc));
    if (toothCodesUsed.length > 0) {
      remarks.push(`${code} cannot be used with tooth codes: ${toothCodesUsed.join(", ")}`);
    }

    // Always require the exact phrase for special medical codes (unless all-DRUG/PDF)
    remarks.push(`${code} requires an Observation with Description or Code exactly "ACTIVITY DESCRIPTION".`);
  }

  return buildActivityRow({
    claimId,
    activityId,
    type,
    code,
    description: getSpecialMedicalCodeDescription(code),
    details,
    remarks
  });
}

// Parsing and validation functions
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
    if (obsCodeRaw === 'Drug Patient Share') return 'Drug Patient Share';
    return obsCodeRaw.toUpperCase();
  }).filter(Boolean);
}

function isDrugPatientShareOrPDF(obsCode) {
  return obsCode === 'Drug Patient Share' || obsCode === 'PDF';
}

function checkRegionDuplication(tracker, code, regionType, regionKey, codeLastDigit) {
  const key = `${regionKey}_${code}`;
  if (tracker[key]) {
    if (codeLastDigit !== '9') {
      return [`Duplicate ${regionType} code "${code}" in ${regionKey}`];
    }
    return [];
  }
  tracker[key] = true;
  return [];
}

// Activity validation functions
function validateKnownCode({
  claimId, activityId, type, code, obsCodes, meta, claimRegionTrack, codeLastDigit, obsList
}) {
  const regionType = meta.description.toLowerCase().includes('sextant') ? 'sextant'
    : meta.description.toLowerCase().includes('quadrant') ? 'quadrant'
    : null;

  let regionKey = null;
  const remarks = [];

  // PATCH: If all obsCodes are Drug Patient Share or PDF, mark valid and skip remarks
  const allDrugShareOrPDF = obsCodes.length > 0 && obsCodes.every(isDrugPatientShareOrPDF);
  if (allDrugShareOrPDF) {
    return buildActivityRow({
      claimId,
      activityId,
      type,
      code,
      description: meta.description,
      details: obsCodes.map(obsCode =>
        obsCode === 'Drug Patient Share'
          ? 'Drug Patient Share (valid - no validation)'
          : 'PDF (valid - no validation)'
      ).join('<br>'),
      remarks: []
    });
  }

  // Special Medical Code Handling
  if (isSpecialMedicalCode(code)) {
    return handleSpecialMedicalCode({claimId, activityId, type, code, obsCodes, obsList});
  }

  // Mark as invalid if no observations
  if (obsCodes.length === 0) {
    remarks.push(`${code} requires at least one observation but none were provided.`);
  }

  const details = obsCodes.length === 0
    ? 'None provided'
    : obsCodes.map(obsCode => {
      if (isDrugPatientShareOrPDF(obsCode)) {
        return `${obsCode} (valid - no validation)`;
      }
      let thisRemark = '';
      if (!meta.teethSet.has(obsCode)) {
        const toothType = getRegionName(obsCode);
        thisRemark = `${toothType} ${obsCode} not allowed for ${meta.description.match(/anterior|posterior|bicuspid|all/i)?.[0] || 'see code description'} code ${code}.`;
        remarks.push(thisRemark);
      }

      if (regionType === 'sextant') {
        regionKey = getSextant(obsCode);
      } else if (regionType === 'quadrant') {
        regionKey = getQuadrant(obsCode);
      }

      return `${obsCode} - ${getRegionName(obsCode)}`;
    }).join('<br>');

  // Region duplication check
  if (regionType && regionKey && regionKey !== 'Unknown') {
    const tracker = claimRegionTrack[regionType];
    const dupRemarks = checkRegionDuplication(tracker, code, regionType, regionKey, codeLastDigit);
    if (dupRemarks.length) {
      remarks.push(...dupRemarks);
    }
  }

  return buildActivityRow({
    claimId,
    activityId,
    type,
    code,
    description: meta.description,
    details,
    remarks
  });
}

function validateUnknownCode({
  claimId, activityId, type, code, obsCodes, description, claimRegionTrack, codeLastDigit, obsList
}) {
  let remarks = [];
  let details = '';
  const isRegion = description.toLowerCase().includes('sextant') || description.toLowerCase().includes('quadrant');
  let regionType = null;

  if (isRegion) {
    regionType = description.toLowerCase().includes('sextant') ? 'sextant' : 'quadrant';
  }

  let regionKey = null;

  // PATCH: If all obsCodes are Drug Patient Share or PDF, mark valid and skip remarks
  const allDrugShareOrPDF = obsCodes.length > 0 && obsCodes.every(isDrugPatientShareOrPDF);
  if (allDrugShareOrPDF) {
    details = obsCodes.map(obsCode =>
      obsCode === 'Drug Patient Share'
        ? 'Drug Patient Share (valid - no validation)'
        : 'PDF (valid - no validation)'
    ).join('<br>');
    return buildActivityRow({
      claimId,
      activityId,
      code,
      description,
      details,
      remarks: []
    });
  }

  // Special Medical Code Handling
  if (isSpecialMedicalCode(code)) {
    return handleSpecialMedicalCode({claimId, activityId, type, code, obsCodes, obsList});
  }

  if (isRegion && obsCodes.length > 0) {
    details = obsCodes.map(obsCode => {
      if (isDrugPatientShareOrPDF(obsCode)) return `${obsCode} (valid - no validation)`;

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
    details = obsCodes.map(obsCode => (
      isDrugPatientShareOrPDF(obsCode) ? `${obsCode} (valid - no validation)` : obsCode
    )).join('<br>');
  } else {
    details = 'N/A';
  }

  if (obsCodes.length === 0 && isRegion) {
    remarks.push(`No tooth (Observation) specified for unknown code "${code}" (region type: ${regionType}).`);
  }

  return buildActivityRow({
    claimId,
    activityId,
    type,
    code,
    description,
    details,
    remarks
  });
}

function buildActivityRow({claimId, activityId, type, code, description, details, remarks}) {
  return {
    claimId,
    activityId,
    type,
    code,
    description,
    details,
    remarks
  };
}

// Main activity validation and results rendering
function validateActivities(xmlDoc, codeToMeta, fallbackDescriptions) {
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
      const typeValue = act.querySelector('Type')?.textContent?.trim() || '';
      const rawCode = act.querySelector('Code')?.textContent || '';
      const code = rawCode.trim();
      const codeLastDigit = code.slice(-1);

      // --- ADDED: Check for code === "0000"
      if (code === "00000") {
        const row = buildActivityRow({
          claimId,
          activityId,
          type: typeValue,
          code,
          description: '(invalid placeholder code)',
          details: 'N/A',
          remarks: ['Code "00000" is invalid. Please ask IT to delete this activity or set it to "In Progress".']
        });
        claimHasInvalid = true;
        rows.push(row);
        return;
      }
      
      // --- ADDED: Check for invalid code length ---
      if (code.length !== 5 && !code.includes(`-`)) {
        const row = buildActivityRow({
          claimId,
          activityId,
          type: typeValue,
          code,
          description: '(invalid code length)',
          details: 'N/A',
          remarks: [`Code "${code}" is invalid: it must have exactly 5 characters.`]
        });
        claimHasInvalid = true;
        rows.push(row);
        return;
      }

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
          claimId, activityId, type: typeValue, code, obsCodes, description, claimRegionTrack: claimRegionTrack[claimId], codeLastDigit, obsList
        });
      } else {
        row = validateKnownCode({
          claimId, activityId, type: typeValue, code, obsCodes, meta, claimRegionTrack: claimRegionTrack[claimId], codeLastDigit, obsList
        });
      }

      if (row.remarks && row.remarks.length > 0) claimHasInvalid = true;
      rows.push(row);
    });

    claimSummaries[claimId] = claimHasInvalid;
  });

  rows.__claimSummaries = claimSummaries;
  return rows;
}

function buildResultsTable(rows) {
  // Defensive check: ensure rows is an array
  if (!Array.isArray(rows)) {
    console.error('[TEETH] Invalid results - expected array, got:', typeof rows, rows);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'alert alert-danger';
    errorDiv.textContent = 'Error: Invalid data structure for results table';
    const summaryBox = document.getElementById('resultsSummary');
    if (summaryBox) summaryBox.textContent = '';
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.style.display = 'none';
    return errorDiv;
  }
  
  const summaryBox = document.getElementById('resultsSummary');
  if (!rows.length) {
    if (summaryBox) summaryBox.textContent = '';
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.style.display = 'none';
    const emptyDiv = document.createElement('p');
    emptyDiv.textContent = 'No activities found.';
    return emptyDiv;
  }

  let lastClaimId = null;
  window.invalidRows = rows.filter(r => r.remarks && r.remarks.length > 0);
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.style.display = window.invalidRows.length ? 'inline-block' : 'none';

  const claimSummaries = rows.__claimSummaries || {};
  const totalClaims = Object.keys(claimSummaries).length;
  const validClaims = Object.values(claimSummaries).filter(isInvalid => !isInvalid).length;
  const percentage = totalClaims === 0 ? "0.0" : ((validClaims / totalClaims) * 100).toFixed(1);

  if (summaryBox) summaryBox.textContent = `Valid claims: ${validClaims} / ${totalClaims} (${percentage}%)`;

  const table = document.createElement('table');
  table.className = 'table table-striped table-bordered';
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';

  const html = `
    <thead>
      <tr>
        <th style="padding:8px;border:1px solid #ccc">Claim ID</th>
        <th style="padding:8px;border:1px solid #ccc">Activity ID</th>
        <th style="padding:8px;border:1px solid #ccc">Type</th>
        <th style="padding:8px;border:1px solid #ccc">Code</th>
        <th class="description-col" style="padding:8px;border:1px solid #ccc">Description</th>
        <th style="padding:8px;border:1px solid #ccc">Observations</th>
        <th class="description-col" style="padding:8px;border:1px solid #ccc">Remarks</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(r => {
        const showClaimId = r.claimId !== lastClaimId;
        lastClaimId = r.claimId;
        const rowClass = r.remarks && r.remarks.length > 0 ? 'table-danger' : 'table-success';
        return `
          <tr class="${rowClass}" data-claim-id="${r.claimId || ''}">
            <td style="padding:6px;border:1px solid #ccc" class="claim-id-cell">${showClaimId ? r.claimId : ''}</td>
            <td style="padding:6px;border:1px solid #ccc">${r.activityId}</td>
            <td style="padding:6px;border:1px solid #ccc">${r.type || ''}</td>
            <td style="padding:6px;border:1px solid #ccc">${r.code}</td>
            <td class="description-col" style="padding:6px;border:1px solid #ccc">${r.description}</td>
            <td style="padding:6px;border:1px solid #ccc">${r.details}</td>
            <td class="description-col" style="padding:6px;border:1px solid #ccc">${r.remarks.join('<br>')}</td>
          </tr>`;
      }).join('')}
    </tbody>`;

  table.innerHTML = html;
  
  // Add observer to fill in Claim IDs when filtering hides rows
  const observer = new MutationObserver(() => {
    fillMissingClaimIds();
  });
  
  const tbody = table.querySelector('tbody');
  if (tbody) {
    observer.observe(tbody, { attributes: true, attributeFilter: ['style'], subtree: true });
  }
  
  setTimeout(() => fillMissingClaimIds(), 0);
  
  return table;
}

// Helper function to fill in missing Claim IDs when rows are filtered
function fillMissingClaimIds() {
  const table = document.querySelector('#results table');
  if (!table) return;
  
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  let lastVisibleClaimId = null;
  
  rows.forEach(row => {
    const isHidden = row.style.display === 'none';
    const claimIdCell = row.querySelector('.claim-id-cell');
    const claimId = row.getAttribute('data-claim-id');
    
    if (!claimIdCell || !claimId) return;
    
    if (!isHidden) {
      // Row is visible
      if (claimIdCell.textContent.trim() === '') {
        // Empty claim ID cell - fill it in for filtered view
        claimIdCell.textContent = claimId;
        claimIdCell.style.color = '#666'; // Lighter color to indicate it's auto-filled
        claimIdCell.style.fontStyle = 'italic';
      } else {
        // Has claim ID - this is a new claim
        lastVisibleClaimId = claimId;
        claimIdCell.style.color = '';
        claimIdCell.style.fontStyle = '';
      }
    }
  });
}

// UI event handlers removed - teeth checker is now called directly from unified interface via parseXML()

document.getElementById('exportBtn')?.addEventListener('click', () => {
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

// Main XML parsing function - returns Promise<Element>
function parseXML() {
  const xmlInput    = document.getElementById('xmlFile');
  const messageBox  = document.getElementById('messageBox');
  
  // Defensive null checks
  if (messageBox) messageBox.textContent = '';
  
  console.log('[TEETH] parseXML() called');
  console.log('[TEETH] xmlInput element:', !!xmlInput);
  console.log('[TEETH] messageBox element:', !!messageBox);

  let file = xmlInput?.files?.[0];
  
  // Fallback to unified checker files cache
  if (!file && window.unifiedCheckerFiles && window.unifiedCheckerFiles.xml) {
    file = window.unifiedCheckerFiles.xml;
    console.log('[TEETH] Using XML file from unified cache:', file.name);
  }
  
  console.log('[TEETH] File to process:', file ? file.name : 'NO FILE');
  
  if (!file) {
    const msg = 'Please upload an XML file.';
    console.error('[TEETH]', msg);
    if (messageBox) messageBox.textContent = msg;
    const errorDiv = document.createElement('div');
    errorDiv.className = 'alert alert-warning';
    errorDiv.textContent = msg;
    return Promise.resolve(errorDiv);
  }
  
  console.log('[TEETH] Starting file processing...');

  return Promise.all([
    new Promise((res, rej) => {
      const rdr = new FileReader();
      rdr.onload  = () => {
        console.log('[TEETH] XML file read successfully');
        res(rdr.result);
      };
      rdr.onerror = () => {
        console.error('[TEETH] Error reading XML file');
        rej('Error reading XML');
      };
      rdr.readAsText(file);
    }),
    fetch(repoJsonUrl)
      .then(r => {
        console.log('[TEETH] Fetched tooth JSON:', r.ok);
        return r.ok ? r.json() : Promise.reject(`Failed to load ${repoJsonUrl} (HTTP ${r.status})`);
      }),
    fetch('checker_auths.json')
      .then(r => {
        console.log('[TEETH] Fetched auth JSON:', r.ok);
        return r.ok ? r.json() : Promise.reject(`Failed to load checker_auths.json (HTTP ${r.status})`);
      })
  ])
  .then(([xmlText, toothJson, authJson]) => {
    console.log('[TEETH] All resources loaded, processing...');
    const toothMap = buildCodeMeta(toothJson);
    const authMap  = buildAuthMap(authJson);
    // Preprocess XML to replace unescaped & with "and" for parseability
    const xmlContent = xmlText.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g, "and");
    const xmlDoc   = new DOMParser().parseFromString(xmlContent, 'application/xml');
    if (xmlDoc.querySelector('parsererror')) throw new Error('Invalid XML file');
    console.log('[TEETH] XML parsed, validating activities...');
    const rows     = validateActivities(xmlDoc, toothMap, authMap);
    console.log('[TEETH] Validation complete, building table... (rows:', rows.length, ')');
    const tableElement = buildResultsTable(rows);
    console.log('[TEETH] Table build complete');
    return tableElement;
  })
  .catch(err => {
    console.error('[TEETH] Error during processing:', err);
    const errorMsg = err.toString();
    if (messageBox) messageBox.textContent = errorMsg;
    const errorDiv = document.createElement('div');
    errorDiv.className = 'alert alert-danger';
    errorDiv.textContent = `Error: ${errorMsg}`;
    return errorDiv;
  });
}

// ----------- SUPERFLUOUS FUNCTIONS (no longer used, kept for reference) -----------
// function getTeethSet(region) { ... }
// function getRegionName(tooth) { ... }
// function getQuadrant(tooth) { ... }
// function getSextant(tooth) { ... }

    // Expose function globally for unified checker
    window.parseXML = parseXML;

  } catch (error) {
    console.error('[CHECKER-ERROR] Failed to load checker:', error);
    console.error(error.stack);
  }
})();
