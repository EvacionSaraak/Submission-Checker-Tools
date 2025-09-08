// ==============================
// import and constants
// ==============================
importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

const TARGET_HEADERS = [
  'Pri. Claim No', 'Clinician License', 'Encounter Date', 'Pri. Patient Insurance Card No',
  'Department', 'Visit Id', 'Pri. Plan Type', 'Facility ID',
  'Patient Code', 'Clinician Name', 'Opened by', 'Source File', 'Raw Encounter Date'
];

// === Header maps (unchanged) ===
const CLINICPRO_V1_MAP = {
  'ClaimID': 'Pri. Claim No', 'Clinician License': 'Clinician License',
  'ClaimDate': 'Encounter Date', 'Insurance Company': 'Pri. Plan Type',
  'PatientCardID': 'Pri. Patient Insurance Card No', 'Clinic': 'Department',
  'Visit Id': 'Visit Id', 'Clinician Name': 'Clinician Name',
  'Opened by/Registration Staff name': 'Opened by', 'Opened by': 'Opened by',
  'FileNo': 'Patient Code'
};

const CLINICPRO_V2_MAP = {
  'ClaimID': 'Pri. Claim No', 'Clinician License': 'Clinician License',
  'ClaimDate': 'Encounter Date', 'Insurance Company': 'Pri. Plan Type',
  'Member ID': 'Pri. Patient Insurance Card No', 'Clinic': 'Department',
  'Visit Id': 'Visit Id', 'Clinician Name': 'Clinician Name',
  'OrderDoctor': 'Clinician Name', 'Updated By': 'Opened by',
  'Opened by/Registration Staff name': 'Opened by', 'Opened by': 'Opened by',
  'FileNo': 'Patient Code'
};

const INSTAHMS_MAP = {
  'Pri. Claim No': 'Pri. Claim No', 'Clinician License': 'Clinician License',
  'Encounter Date': 'Encounter Date', 'Pri. Patient Insurance Card No': 'Pri. Patient Insurance Card No',
  'Department': 'Department', 'Visit Id': 'Visit Id',
  'Pri. Plan Type': 'Pri. Plan Type', 'Facility ID': 'Facility ID',
  'Patient Code': 'Patient Code', 'Clinician Name': 'Clinician Name',
  'Opened by': 'Opened by'
};

const ODOO_MAP = {
  'Pri. Claim ID': 'Pri. Claim No',
  'Admitting License': 'Clinician License',
  'Adm/Reg. Date': 'Encounter Date',
  'Pri. Member ID': 'Pri. Patient Insurance Card No',
  'Admitting Department': 'Department',
  'Visit Id': 'Visit Id',
  'Pri. Plan Type': 'Pri. Plan Type',
  'Center Name': 'Facility ID',
  'MR No.': 'Patient Code',
  'Admitting Doctor': 'Clinician Name'
  // Note: 'Opened by' intentionally not included for Odoo (should be blank)
};

const facilityNameMap = {
  "Ivory": "MF4456", "Korean": "MF5708", "Lauretta": "MF4706", "Laurette": "MF4184",
  "Majestic": "MF1901", "Nazek": "MF5009", "Extramall": "MF5090", "Khabisi": "MF5020",
  "Al Yahar": "MF5357", "Scandcare": "MF456", "Talat": "MF494", "True Life": "MF7003",
  "Al Wagan": "MF7231", "WLDY": "MF5339"
};

// ==============================
// Logging / small helpers
// ==============================
function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const msg = `[${level}] ${timestamp} - ${message}`;
  try { self.postMessage({ type: 'log', message: msg }); } catch (e) {}
  // console.log(msg);
}

function normalizeName(name) { return (name || '').replace(/\s+/g, '').toLowerCase(); }

// header signature used widely for stable comparisons
function headerSignature(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')   // remove zero-width
    .replace(/\u00A0/g, ' ')                 // NBSP -> space
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');              // remove non-alphanumerics
}

// tolerant header matcher (keeps existing behavior)
function findHeaderMatch(headerRow, srcHeader) {
  if (!Array.isArray(headerRow) || !srcHeader) return null;
  const normalize = s => String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/[\.\-\/,_\s]+/g, ' ');
  const targetNorm = normalize(srcHeader);
  const targetTokens = targetNorm.split(' ').filter(Boolean);

  // Exact normalized equality
  for (const h of headerRow) if (normalize(h) === targetNorm) return h;

  // Token-overlap: require at least two shared tokens, or all tokens if targetTokens.length <= 2
  for (const h of headerRow) {
    const hn = normalize(h);
    const hTokens = hn.split(' ').filter(Boolean);
    if (hTokens.length === 0 || targetTokens.length === 0) continue;
    const shared = targetTokens.filter(t => hTokens.includes(t));
    const required = Math.min(2, targetTokens.length);
    if (shared.length >= required) return h;
  }
  return null;
}

// headerExists wrapper to return the matched header (or null)
function headerExists(headerRow, srcHeader) {
  if (!Array.isArray(headerRow) || headerRow.length === 0) return null;
  return findHeaderMatch(headerRow, srcHeader);
}

// ==============================
// Facility ID helpers (keep original robust implementations)
// ==============================
function getFacilityIDFromFileName(filename) {
  if (!filename) return '';
  const s = String(filename).trim();
  const lower = s.toLowerCase();
  const mfMatch = lower.match(/\bmf\d{2,}\b/);
  
  if (mfMatch) return mfMatch[0].toUpperCase();
  for (const key of Object.keys(facilityNameMap)) {
    if (!key) continue;
    if (lower.includes(key.toLowerCase())) return facilityNameMap[key];
  }
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length) {
    const normalizedMap = Object.keys(facilityNameMap).reduce((acc, k) => {
      const nk = k.toLowerCase().replace(/\s+/g, '');
      acc[nk] = facilityNameMap[k];
      return acc;
    }, {});
    for (const t of tokens) {
      const compact = t.replace(/\s+/g, '');
      if (normalizedMap[compact]) return normalizedMap[compact];
    }
  }
  return '';
}

function getFacilityIDFromCenterName(centerName) {
  if (!centerName) return '';
  const s = String(centerName).trim();

  // direct MF code match
  const mfMatch = s.match(/\bM[Ff]\d{2,}\b/);
  if (mfMatch) return mfMatch[0].toUpperCase();

  // try keys in facilityNameMap (case-insensitive substring)
  const lower = s.toLowerCase();
  for (const k of Object.keys(facilityNameMap)) {
    if (lower.includes(k.toLowerCase())) return facilityNameMap[k];
  }

  // fallback: first token (useful if Center Name begins with code)
  const firstToken = s.split(/\s+/)[0];
  if (/^[A-Za-z0-9\-]+$/.test(firstToken) && firstToken.length <= 10) return firstToken;

  return '';
}

// ==============================
// Date normalization utilities
// (keep multiple converters, but standardize usage to toExcelSerial)
// ==============================
function excelDateFromJSDate(date) {
  const epoch = new Date(Date.UTC(1899, 11, 30));
  return (date - epoch) / (1000 * 60 * 60 * 24);
}

function toExcelSerial(value, fileType) {
  // fileType: 0 => Odoo (MDY), 1 => ClinicPro (numeric), 2 => Insta (DMY)
  if (value === null || value === undefined || value === '') return '';
  if (fileType === 1) { // ClinicPro likely already numeric/excel serial
    const num = Number(value);
    if (!isNaN(num)) return Math.floor(num);
    return '';
  }

  // If it's already a Date object
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Math.floor(excelDateFromJSDate(value));
  }

  const s = String(value).trim();
  // Pure numeric that looks like a serial
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!isNaN(n) && n > 20000 && n < 60000) return Math.floor(n);

  // Split into parts
  const parts = s.split(/[\/\-.]/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 3) {
    // Decide ordering based on fileType
    let day, month, year;
    if (fileType === 2) { // DMY
      day = parseInt(parts[0], 10); month = parseInt(parts[1], 10) - 1; year = parseInt(parts[2], 10);
    } else { // Odoo MDY
      month = parseInt(parts[0], 10) - 1; day = parseInt(parts[1], 10); year = parseInt(parts[2], 10);
    }
    if (year < 100) year += 2000;
    const dt = new Date(Date.UTC(year, month, day));
    if (!isNaN(dt)) return Math.floor(excelDateFromJSDate(dt));
  }

  // Fallback: try Date.parse
  const parsed = Date.parse(s);
  if (!isNaN(parsed)) return Math.floor(excelDateFromJSDate(new Date(parsed)));

  return '';
}

// keep old converters commented for reference (do not delete)
/*
function normalizeExcelSerial(v, is1904=false){ ... }
function convertToExcelDateUniversal(value){ ... }
*/

// ==============================
// Detection using existing header maps
// ==============================
function detectFileTypeFromHeaders(headerRow) {
  // headerRow: array of raw header strings
  const normalizedHeaders = (headerRow || []).map(h => headerSignature(h));
  const maps = [
    { type: 'odoo', map: ODOO_MAP },
    { type: 'clinicpro_v2', map: CLINICPRO_V2_MAP },
    { type: 'clinicpro_v1', map: CLINICPRO_V1_MAP },
    { type: 'instahms', map: INSTAHMS_MAP }
  ];

  let best = { type: 'unknown', map: null, score: -1 };

  for (const m of maps) {
    let mapKeys = Object.keys(m.map).map(k => headerSignature(k));
    let score = 0;
    for (const mk of mapKeys) {
      if (mk && normalizedHeaders.includes(mk)) score++;
    }
    // small tie-breaker preference: exact header count wins, else prefer ODOO over Insta in ambiguous cases
    if (score > best.score || (score === best.score && best.type === 'unknown')) {
      best = { type: m.type, map: m.map, score };
    }
  }

  log(`detectFileTypeFromHeaders -> best: ${best.type} (score=${best.score})`);
  return { fileType: best.type, headerMap: best.map };
}

// ==============================
// Helper to map a sheet row into normalized sourceRow using headerMap
// ==============================
function mapSourceRowWithHeaderMap(headerRow, dataRow, headerMap) {
  // headerRow: array of raw header strings
  // headerMap: mapping from source header -> target header (as in your CLINICPRO/INSTA/ODOO maps)
  const sourceRow = {}; // keyed by normalized target name (headerSignature of source header)
  if (!Array.isArray(headerRow) || !Array.isArray(dataRow)) return sourceRow;

  // For each key in headerMap, attempt to find matching header in the file headerRow
  for (const [srcHdr, tgtHdr] of Object.entries(headerMap)) {
    const match = findHeaderMatch(headerRow, srcHdr);
    if (match) {
      const idx = headerRow.indexOf(match);
      sourceRow[headerSignature(srcHdr)] = dataRow[idx] ?? '';
      // Also store under its target normalized name for easier lookup
      sourceRow[headerSignature(tgtHdr)] = dataRow[idx] ?? '';
    } else {
      // no exact match; leave undefined
      sourceRow[headerSignature(srcHdr)] = sourceRow[headerSignature(srcHdr)] ?? '';
    }
  }

  // Also populate generic normalized versions of all actual headers (fallback access)
  for (let i = 0; i < headerRow.length; i++) {
    const raw = headerRow[i];
    sourceRow[headerSignature(raw)] = sourceRow[headerSignature(raw)] ?? (dataRow[i] ?? '');
  }

  return sourceRow;
}

// ==============================
// combineEligibilities (kept, minor cleanup)
// ==============================
async function combineEligibilities(fileEntries) {
  log("Starting eligibility combining");

  const XLSX = (typeof window !== "undefined" ? window.XLSX : self.XLSX);
  if (!fileEntries || fileEntries.length === 0) {
    log("No eligibility files provided", "ERROR");
    return;
  }

  let combinedRows = [];
  let headerRow = null;
  const seenRows = new Set();

  for (let entry of fileEntries) {
    log(`Reading file: ${entry.name}`);
    const data = entry.buffer; // buffer from File/Upload
    const wb = XLSX.read(data, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    let rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    // Headers are on row 2 (index 1)
    if (!headerRow) {
      headerRow = rows[1];
      combinedRows.push(headerRow);
      log(`Header row set: ${headerRow.join(", ")}`);
    }

    const dataRows = rows.slice(2);
    for (let row of dataRows) {
      const key = JSON.stringify(row);
      if (!seenRows.has(key)) {
        combinedRows.push(row);
        seenRows.add(key);
      }
    }
    log(`Processed ${dataRows.length} data rows from ${entry.name}`);
  }

  if (!headerRow) {
    log("No header row found in any file", "ERROR");
    return;
  }

  const ws = XLSX.utils.aoa_to_sheet(combinedRows);
  const wbOut = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbOut, ws, "Combined Eligibility");
  log(`Combined eligibility workbook created with ${combinedRows.length - 1} data rows`);

  return wbOut;
}

// ==============================
// Main reporting combiner (rewritten, uses header maps and robust detection)
// ==============================
async function combineReportings(fileEntries, clinicianFile) {
  log("Starting combineReportings function");
  if (!Array.isArray(fileEntries) || fileEntries.length === 0) {
    log("No input files provided", "ERROR");
    throw new Error("No input files provided");
  }

  const headersWithRaw = TARGET_HEADERS; // includes Raw Encounter Date at end already
  const combinedRows = [headersWithRaw];
  log("Initialized combinedRows with headers");

  // clinician maps
  const clinicianMapByLicense = new Map(), clinicianMapByName = new Map();
  let fallbackExcel = [];

  // Load clinician licenses JSON
  try {
    log("Fetching clinician_licenses.json");
    const resp = await fetch('./clinician_licenses.json');
    const clinicianData = await resp.json();
    if (!Array.isArray(clinicianData)) throw new Error("Clinician data is not an array");
    clinicianData.forEach(entry => {
      const lic = entry['Phy Lic']?.toString().trim();
      const nm = entry['Clinician Name']?.toString().trim();
      if (lic) clinicianMapByLicense.set(lic, entry);
      if (nm) clinicianMapByName.set(normalizeName(nm), entry);
    });
    log(`Loaded clinician licenses: ${clinicianMapByLicense.size} by license`);
  } catch (err) {
    log(`Failed to load clinician_licenses.json: ${err.message}`, 'ERROR');
  }

  // Load fallback clinician file if provided
  if (clinicianFile) {
    try {
      log("Reading fallback clinician file");
      const wbClin = XLSX.read(clinicianFile, { type: 'array' });
      const wsClin = wbClin.Sheets[wbClin.SheetNames[0]];
      fallbackExcel = XLSX.utils.sheet_to_json(wsClin, { defval: '' }).map(r => ({
        lic: r['Clinician License']?.toString().trim(),
        nm: (r['Clinician Name'] || '').trim().replace(/\s+/g, ' '),
        facilityLicense: r['Facility License']?.toString().trim() || '',
        raw: r
      }));
      log(`Fallback clinician entries loaded: ${fallbackExcel.length}`);
    } catch (err) {
      log(`Error reading fallback clinician file: ${err.message}`, 'ERROR');
      fallbackExcel = [];
    }
  }

  const rawToSerialMap = {};
  const serialSet = new Set();
  const globalSeenClaimIDs = new Set();

  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    log(`Reading reporting file: ${name}`);

    let wb;
    try { wb = XLSX.read(buffer, { type: 'array', cellDates: true }); }
    catch (err) { log(`Failed to read XLSX from buffer for file ${name}: ${err.message}`, 'ERROR'); continue; }

    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (!sheetData || sheetData.length === 0) { log(`File ${name} skipped: no data`, 'WARN'); continue; }

    const { headerRowIndex, headers: headerRow, rows: rowsAfterHeader } = findHeaderRowFromArrays(sheetData, 10);
    if (!headerRow || headerRow.length === 0) { log(`File ${name} skipped: header row not found.`, 'WARN'); continue; }

    const trimmedHeaderRow = headerRow.map(h => (h || '').toString().trim());
    // detect file type using header maps
    const { fileType, headerMap } = detectFileTypeFromHeaders(trimmedHeaderRow);
    if (!headerMap) {
      log(`File ${name}: no header map matched, defaulting to ODOO_MAP`, 'WARN');
    }

    // Decide a normalized "schema type" for date parsing and facility handling
    let schemaType = 0; // 0 => Odoo (MDY), 1 => ClinicPro (numeric or numeric-like), 2 => InstaHMS (DMY)
    if (fileType === 'clinicpro_v1' || fileType === 'clinicpro_v2') schemaType = 1;
    else if (fileType === 'instahms') schemaType = 2;
    else schemaType = 0; // odoo or fallback

    log(`Detected file type for ${name}: ${fileType} (schema=${schemaType})`);

    // for each data row after headerRowIndex
    const startRow = headerRowIndex + 1;
    const totalRows = sheetData.length;
    const normalizedHeaderSignatures = trimmedHeaderRow.map(h => headerSignature(h));

    // Build target->normalizedSource map for quick lookup (target is the normalized target header)
    const targetToSourceSig = {}; // e.g. 'Encounter Date' -> 'admregdate'
    if (headerMap) {
      for (const [src, tgt] of Object.entries(headerMap)) {
        const srcSig = headerSignature(src);
        // find actual header in file that matches src (using findHeaderMatch)
        const matchedHdr = findHeaderMatch(trimmedHeaderRow, src);
        const matchedSig = matchedHdr ? headerSignature(matchedHdr) : null;
        targetToSourceSig[tgt] = matchedSig;
      }
    }

    const seenClaimIDs = new Set(); // per-file
    for (let r = startRow; r < totalRows; r++) {
      const row = sheetData[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      try {
        // Map values into sourceRow keyed by normalized signatures of actual file headers
        const sourceRow = {};
        for (let c = 0; c < trimmedHeaderRow.length; c++) {
          const sig = headerSignature(trimmedHeaderRow[c]);
          sourceRow[sig] = row[c] ?? '';
        }

        // Extract claim id using headerMap (preferred) or fallback heuristics
        let claimID = '';
        if (headerMap) {
          const claimSrc = Object.keys(headerMap).find(k => headerMap[k] === 'Pri. Claim No');
          if (claimSrc) {
            const sig = headerSignature(claimSrc);
            claimID = (sourceRow[sig] ?? '').toString().trim();
          }
        }
        // fallback: try common header signatures
        if (!claimID) {
          claimID = (sourceRow['pri.claim.no'] || sourceRow['claimid'] || sourceRow['priclaimid'] || '')?.toString().trim();
        }

        if (!claimID) continue; // can't process without claim key
        if (seenClaimIDs.has(claimID) || globalSeenClaimIDs.has(claimID)) continue;
        seenClaimIDs.add(claimID); globalSeenClaimIDs.add(claimID);

        // Determine Facility ID
        let facilityID = '';
        if (schemaType === 2) { // InstaHMS usually contains Facility ID column
          const facSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Facility ID');
          if (facSrc) {
            facilityID = (sourceRow[headerSignature(facSrc)] ?? '').toString().trim();
          }
          if (!facilityID) facilityID = getFacilityIDFromFileName(name);
        } else if (schemaType === 1) { // ClinicPro: use filename + Visit Id heuristics
          // prefer Visit Id value if present (it might embed MF code)
          const visitSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Visit Id');
          const visitVal = visitSrc ? (sourceRow[headerSignature(visitSrc)] ?? '').toString().trim() : '';
          facilityID = getFacilityIDFromFileName(visitVal || name);
        } else { // Odoo
          const centerSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Facility ID' || (headerMap || {})[k] === 'Center Name' || k.toLowerCase().includes('center'));
          const centerVal = centerSrc ? (sourceRow[headerSignature(centerSrc)] ?? '').toString().trim() : '';
          facilityID = getFacilityIDFromCenterName(centerVal || name);
        }

        // Clinician license / name extraction & fallback logic
        let clinLicense = '', clinName = '';
        const clinLicenseSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Clinician License');
        const clinNameSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Clinician Name');

        if (clinLicenseSrc) clinLicense = (sourceRow[headerSignature(clinLicenseSrc)] ?? '').toString().trim();
        if (clinNameSrc) clinName = (sourceRow[headerSignature(clinNameSrc)] ?? '').toString().trim();

        // fallback 'orderdoctor' raw header often present
        if (!clinName) {
          const od = Object.keys(sourceRow).find(k => k.includes('orderdoctor') || k.includes('orderdoctor'.replace(/\./g,'')));
          if (od) clinName = (sourceRow[od] ?? '').toString().trim();
        }

        if (clinLicense && !clinName && clinicianMapByLicense.has(clinLicense)) {
          clinName = clinicianMapByLicense.get(clinLicense)['Clinician Name'];
        }
        if (clinName && !clinLicense && clinicianMapByName.has(normalizeName(clinName))) {
          clinLicense = clinicianMapByName.get(normalizeName(clinName))['Phy Lic'];
        }
        if ((!clinName || !clinLicense) && clinName && facilityID) {
          const fb = fallbackClinicianLookupWithFacility(clinName, facilityID, fallbackExcel);
          if (fb) { clinLicense = fb.license || clinLicense; clinName = fb.name || clinName; }
        }

        // IMPORTANT: do not skip Odoo rows for missing clinician info
        if ((fileType !== 'odoo') && !clinName && !clinLicense) {
          // skip rows for non-odoo if no clinician info found
          continue;
        }

        // Encounter date: find which source header provides Encounter Date (from targetToSourceSig)
        let rawEncounterVal = '', normalizedEncounter = '';
        const encounterTgtSig = targetToSourceSig['Encounter Date'] ? targetToSourceSig['Encounter Date'] : null;
        if (encounterTgtSig && sourceRow[encounterTgtSig] !== undefined) {
          rawEncounterVal = sourceRow[encounterTgtSig];
          normalizedEncounter = toExcelSerial(rawEncounterVal, schemaType);
        } else {
          // fallback: try common header signatures
          const commonEnc = sourceRow['encounterdate'] || sourceRow['claimdate'] || sourceRow['admregdate'] || sourceRow['date'] || '';
          rawEncounterVal = commonEnc;
          normalizedEncounter = toExcelSerial(rawEncounterVal, schemaType);
        }

        if (normalizedEncounter !== '' && normalizedEncounter !== null) {
          serialSet.add(Number(normalizedEncounter));
          const rawKey = (typeof rawEncounterVal === 'object') ? JSON.stringify(rawEncounterVal) : String(rawEncounterVal);
          rawToSerialMap[rawKey] = Number(normalizedEncounter);
        }

        // Build the target row in order of headersWithRaw (TARGET_HEADERS + Raw)
        const targetRow = [];
        for (let col = 0; col < headersWithRaw.length; col++) {
          const tgt = headersWithRaw[col];
          let val = '';

          if (tgt === 'Facility ID') val = facilityID || '';
          else if (tgt === 'Pri. Patient Insurance Card No') {
            // ClinicPro special handling: prefer Member ID then PatientCardID
            if (schemaType === 1) {
              const memSig = headerSignature(Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Pri. Patient Insurance Card No') || '');
              val = (sourceRow[memSig] ?? sourceRow['memberid'] ?? sourceRow['patientcardid'] ?? '') || '';
            } else {
              const sig = targetToSourceSig['Pri. Patient Insurance Card No'];
              val = (sig ? (sourceRow[sig] ?? '') : '') || (sourceRow['pripatentinsurancecardno'] ?? sourceRow['pri.member.id'] ?? '');
            }
          }
          else if (tgt === 'Patient Code') {
            const sig = targetToSourceSig['Patient Code'];
            val = sig ? (sourceRow[sig] ?? '') : (sourceRow['mrno'] ?? sourceRow['fileno'] ?? '');
          }
          else if (tgt === 'Clinician License') val = clinLicense || '';
          else if (tgt === 'Clinician Name') val = clinName || '';
          else if (tgt === 'Opened by') {
            if (fileType === 'odoo') val = ''; // intentionally blank for Odoo
            else {
              const sig = targetToSourceSig['Opened by'];
              val = sig ? (sourceRow[sig] ?? sourceRow['updatedby'] ?? '') : (sourceRow['openedby'] ?? sourceRow['openedby/registrationstaffname'] ?? '');
            }
          }
          else if (tgt === 'Encounter Date') val = normalizedEncounter;
          else if (tgt === 'Raw Encounter Date') val = rawEncounterVal ?? '';
          else if (tgt === 'Source File') val = name;
          else {
            // Generic mapping using headerMap targets
            const sig = targetToSourceSig[tgt] || null;
            if (sig) val = sourceRow[sig] ?? '';
            else val = '';
          }

          targetRow.push(val);
        }

        combinedRows.push(targetRow);

      } catch (err) {
        log(`Fatal row error in file ${name}, row ${r + 1}: ${err.message}`, 'ERROR');
      }
    } // end row loop

    self.postMessage({ type: 'progress', progress: 50 + Math.floor(((i + 1) / fileEntries.length) * 50) });
  } // end file loop

  log(`Raw->Serial mapping: ${JSON.stringify(rawToSerialMap)}`);
  log(`Unique Excel serials found: ${[...serialSet].sort((a, b) => a - b).join(', ')}`);

  // Validate combinedRows shape
  for (const [idx, row] of combinedRows.entries()) {
    if (!Array.isArray(row) || row.length !== headersWithRaw.length) {
      log(`Bad combined row at index ${idx} (len=${Array.isArray(row) ? row.length : 'na'})`, 'ERROR');
      throw new Error('Invalid combined rows');
    }
  }

  const wsOut = XLSX.utils.aoa_to_sheet(combinedRows);
  const wbOut = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbOut, wsOut, 'Combined Reporting');
  self.postMessage({ type: 'progress', progress: 100 });

  return wbOut;
}

// ==============================
// Remaining helpers kept but commented if unneeded
// (You asked: do not delete functions; comment them if unneeded)
// ==============================
/*
// old simpler detector (kept commented for reference)
function detectFileTypeFromHeaders_old(headers) { ... }

// older date normalizer - kept commented
function normalizeExcelSerial(v, is1904=false){ ... }

function convertToExcelDateUniversal(value){ ... }
*/

// ==============================
// Worker message entrypoint
// ==============================
self.onmessage = async (e) => {
  if (e.data.type !== 'start') return;
  const { mode, files, clinicianFile } = e.data;
  try {
    log(`Processing started in mode: ${mode}, ${files.length} file(s)`);
    const combineFn = mode === 'eligibility' ? combineEligibilities : combineReportings;
    const wb = await combineFn(files, clinicianFile);
    const wbArray = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const wbUint8 = new Uint8Array(wbArray);
    self.postMessage({ type: 'result', workbookData: wbUint8 }, [wbUint8.buffer]);
    log(`Processing complete for mode: ${mode}`, 'SUCCESS');
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message });
    log(`Error during processing: ${err.message}`, 'ERROR');
  }
};
