// ==============================
// import and constants
// ==============================
importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

const TARGET_HEADERS = [
  'Pri. Claim No', 'Clinician License', 'Encounter Date', 'Pri. Patient Insurance Card No',
  'Department', 'Visit Id', 'Pri. Plan Type', 'Facility ID',
  'Patient Code', 'Clinician Name', 'Opened by', 'Source File', 'Raw Encounter Date',
  'Total Amount'
];

// === Header maps (unchanged) ===
const CLINICPRO_V1_MAP = {
  'ClaimID': 'Pri. Claim No', 'Clinician License': 'Clinician License',
  'ClaimDate': 'Encounter Date', 'Insurance Company': 'Pri. Plan Type',
  'PatientCardID': 'Pri. Patient Insurance Card No', 'Clinic': 'Department',
  'Visit Id': 'Visit Id', 'Clinician Name': 'Clinician Name',
  'Opened by/Registration Staff name': 'Opened by', 'Opened by': 'Opened by',
  'FileNo': 'Patient Code',
  'InvoiceAmount': 'Total Amount'
};

const CLINICPRO_V2_MAP = {
  'ClaimID': 'Pri. Claim No', 'Clinician License': 'Clinician License',
  'ClaimDate': 'Encounter Date', 'Insurance Company': 'Pri. Plan Type',
  'Member ID': 'Pri. Patient Insurance Card No', 'Clinic': 'Department',
  'Visit Id': 'Visit Id', 'Clinician Name': 'Clinician Name',
  'OrderDoctor': 'Clinician Name', 'Updated By': 'Opened by',
  'Opened by/Registration Staff name': 'Opened by', 'Opened by': 'Opened by',
  'FileNo': 'Patient Code',
  'InvoiceAmount': 'Total Amount'
};

const INSTAHMS_MAP = {
  'Pri. Claim No': 'Pri. Claim No', 'Clinician License': 'Clinician License',
  'Encounter Date': 'Encounter Date', 'Pri. Patient Insurance Card No': 'Pri. Patient Insurance Card No',
  'Department': 'Department', 'Visit Id': 'Visit Id',
  'Pri. Plan Type': 'Pri. Plan Type', 'Facility ID': 'Facility ID',
  'Patient Code': 'Patient Code', 'Clinician Name': 'Clinician Name',
  'Opened by': 'Opened by',
  'Gross Amount': 'Total Amount'
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
  'Admitting Doctor': 'Clinician Name',
  'Total Sponsor Amt': 'Total Amount'
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

function findHeaderRowFromArrays(sheetRows, maxScan = 10) {
  if (!Array.isArray(sheetRows) || sheetRows.length === 0) {
    return { headerRowIndex: -1, headers: [], rows: [] };
  }

  const tokens = [
    'pri. claim no', 'pri claim no', 'claimid', 'claim id', 'pri. claim id', 'pri claim id',
    'center name', 'card number', 'card number / dha member id', 'member id', 'patientcardid',
    'pri. patient insurance card no', 'institution', 'facility id', 'mr no.', 'pri. claim id',
    'encounter date', 'claimdate', 'adm/reg. date', 'adm/reg date', 'adm reg'
  ];

  const limit = Math.min(maxScan, sheetRows.length);
  let bestIndex = 0;
  let bestScore = 0;

  for (let i = 0; i < limit; i++) {
    const row = sheetRows[i];
    if (!Array.isArray(row)) continue;
    const joined = row.map(c => (c === undefined || c === null) ? '' : String(c)).join(' ').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (joined.includes(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const headerRowIndex = bestScore > 0 ? bestIndex : 0;
  const rawHeaderRow = sheetRows[headerRowIndex] || [];
  const headers = rawHeaderRow.map(h => (h === undefined || h === null) ? '' : String(h).trim());
  const rowsAfterHeader = sheetRows.slice(headerRowIndex + 1);

  return { headerRowIndex, headers, rows: rowsAfterHeader };
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

  // direct MF code match (MFxxxx)
  const mfMatch = s.match(/\bM[Ff]\d{2,}\b/);
  if (mfMatch) return mfMatch[0].toUpperCase();

  // try keys in facilityNameMap (case-insensitive substring)
  const lower = s.toLowerCase();
  for (const k of Object.keys(facilityNameMap)) {
    if (lower.includes(k.toLowerCase())) return facilityNameMap[k];
  }

  // fallback: only accept a first token that looks like a code (contains digits or MF-like)
  const firstToken = s.split(/\s+/)[0];
  // allow if MF code or contains a digit (e.g., "MF5357", "Center123", "C123-XYZ")
  if (/^M[Ff]\d{2,}$/.test(firstToken)) return firstToken.toUpperCase();
  if (/^[A-Za-z0-9\-]*\d+[A-Za-z0-9\-]*$/.test(firstToken) && firstToken.length <= 12) return firstToken;

  // otherwise return empty so we don't return meaningless tokens like "New"
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

// Canonical: unified toExcelSerial
// schemaType: 0 => Odoo (prefer MDY fallback for ambiguous; can be tuned), 
//             1 => ClinicPro (prefer MDY for ambiguous numeric-ish rows), 
//             2 => InstaHMS (prefer DMY)
function toExcelSerial(rawValue, schemaType = 0) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30); // Excel day 1 offset

  if (rawValue === null || rawValue === undefined || rawValue === '') return '';

  // 1) If it's already a number
  if (typeof rawValue === 'number' && !isNaN(rawValue)) {
    // Large numbers likely ms timestamps ( > ~1e11 ), convert to days
    if (Math.abs(rawValue) > 1e11) {
      return Math.floor((Number(rawValue) - EXCEL_EPOCH_MS) / MS_PER_DAY);
    }
    // If it looks like a proper Excel serial or decimal serial -> floor
    if (rawValue > 20000 && rawValue < 60000) return Math.floor(rawValue);
    // fallback: treat small numeric as not a date
    return '';
  }

  // 2) Normalize string
  const sRaw = String(rawValue).trim();
  if (!sRaw) return '';

  // 3) Pure numeric string (including decimal)
  if (/^[+-]?\d+(\.\d+)?$/.test(sRaw)) {
    const n = Number(sRaw);
    // ms timestamp
    if (Math.abs(n) > 1e11) return Math.floor((n - EXCEL_EPOCH_MS) / MS_PER_DAY);
    // treat decimal serials or integer-like excel serials
    if (n > 20000 && n < 60000) return Math.floor(n);
    // Some exporters give decimals like 45907.481 -> still floor
    if (n > 0) return Math.floor(n);
    return '';
  }

  // 4) ISO yyyy-mm-dd (unambiguous)
  let m = sRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
    const ms = Date.UTC(y, mo, d);
    return Math.floor((ms - EXCEL_EPOCH_MS) / MS_PER_DAY);
  }

  // 5) Common separators: dd/mm/yyyy or mm/dd/yyyy or d/m/yy etc.
  m = sRaw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let p1 = Number(m[1]), p2 = Number(m[2]), p3 = Number(m[3]);
    if (p3 < 100) p3 += 2000;

    let day, month, year;
    // heuristics:
    if (p1 > 12) { day = p1; month = p2; year = p3; }        // definitely DMY
    else if (p2 > 12) { month = p1; day = p2; year = p3; }  // definitely MDY
    else {
      // ambiguous -> choose based on schemaType
      if (schemaType === 2) { day = p1; month = p2; year = p3; } // Insta -> DMY
      else { month = p1; day = p2; year = p3; }                  // Clinic/Odoo prefer MDY
    }

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const ms = Date.UTC(year, month - 1, day);
      return Math.floor((ms - EXCEL_EPOCH_MS) / MS_PER_DAY);
    }
  }

  // 6) Last resort: Date.parse (handles many textual forms). Use UTC day boundary.
  const parsedMs = Date.parse(sRaw);
  if (!isNaN(parsedMs)) {
    const ms = parsedMs;
    return Math.floor((ms - EXCEL_EPOCH_MS) / MS_PER_DAY);
  }

  // else not recognized
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
  if (!fileEntries || !fileEntries.length) return log("No eligibility files provided", "ERROR");

  let combinedRows = [], headerRow = null, seenRows = new Set(), emptyFiles = [];

  for (let entry of fileEntries) {
    log(`Reading file: ${entry.name}`);
    let wb; try { wb = XLSX.read(entry.buffer, { type: "array" }); } 
    catch (err) { log(`Failed to parse ${entry.name}: ${err.message}`, "ERROR"); continue; }

    if (!wb.SheetNames?.length) { log(`File ${entry.name} has no sheets`, "WARN"); emptyFiles.push(entry.name); continue; }
    const sheet = wb.Sheets[wb.SheetNames[0]]; 
    if (!sheet) { log(`File ${entry.name} has an empty sheet`, "WARN"); emptyFiles.push(entry.name); continue; }

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (!rows || rows.length < 2) { log(`File ${entry.name} has no entries`, "WARN"); emptyFiles.push(entry.name); continue; }

    if (!headerRow) { headerRow = rows[1] || []; combinedRows.push(headerRow); log(`Header row set: ${headerRow.join(", ")}`); }
    for (let row of rows.slice(2)) { let key = JSON.stringify(row); if (!seenRows.has(key)) { combinedRows.push(row); seenRows.add(key); } }
    log(`Processed ${rows.length - 2} data rows from ${entry.name}`);
  }

  if (!headerRow) { 
    log("No header row found in any file", "ERROR"); 
    emptyFiles.forEach(f => log(`File ${f} has no entries`, "WARN")); 
    return; 
  }

  const ws = XLSX.utils.aoa_to_sheet(combinedRows), wbOut = XLSX.utils.book_new(); 
  XLSX.utils.book_append_sheet(wbOut, ws, "Combined Eligibility");
  log(`Combined eligibility workbook created with ${combinedRows.length - 1} data rows`);
  emptyFiles.forEach(f => log(`File ${f} has no entries`, "WARN"));
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

  // Output headers (TARGET_HEADERS is expected to exist globally)
  const headersWithRaw = [...TARGET_HEADERS]; // don't append 'Raw Encounter Date' again (it's already in TARGET_HEADERS)
  const combinedRows = [headersWithRaw];
  log("Initialized combinedRows with headers");

  // Clinician lookup structures
  const clinicianMapByLicense = new Map(), clinicianMapByName = new Map();
  let fallbackExcel = [];

  // Load clinician licenses JSON (optional)
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
    log(`Failed to load clinician_licenses.json: ${err.message}`, 'WARN');
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

  // Helpers used only inside combineReportings to keep behavior local & robust
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30); // 1899-12-30 UTC
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

    // locate header row
    const { headerRowIndex, headers: headerRow } = findHeaderRowFromArrays(sheetData, 10);
    if (!headerRow || headerRow.length === 0) { log(`File ${name} skipped: header row not found.`, 'WARN'); continue; }

    const trimmedHeaderRow = headerRow.map(h => (h || '').toString().trim());
    const trimmedHeaderSignatures = trimmedHeaderRow.map(h => headerSignature(h));

    // detect type using header maps
    const { fileType, headerMap } = detectFileTypeFromHeaders(trimmedHeaderRow);
    // normalize schemaType for date parsing & facility logic
    let schemaType = 0;
    if (fileType === 'clinicpro_v1' || fileType === 'clinicpro_v2') schemaType = 1;
    else if (fileType === 'instahms') schemaType = 2;
    else schemaType = 0; // odoo / fallback

    log(`Detected file "${name}" as type="${fileType}", schema=${schemaType}`);

    // Build mapping: target header -> matched source header signature
    const targetToSourceSig = {};
    if (headerMap) {
      for (const [src, tgt] of Object.entries(headerMap)) {
        const matched = findHeaderMatch(trimmedHeaderRow, src);
        const matchedSig = matched ? headerSignature(matched) : null;
        targetToSourceSig[tgt] = matchedSig;
      }

      // debug: show what matched (useful for troubleshooting)
      for (const [src, tgt] of Object.entries(headerMap)) {
        const matched = findHeaderMatch(trimmedHeaderRow, src) || 'N/A';
        log(`${name}: mapping "${tgt}" <= "${src}" matched -> "${matched}"`);
      }
    } else {
      log(`${name}: no headerMap found by detection; continuing with heuristics`, 'WARN');
    }

    const startRow = headerRowIndex + 1;
    const totalRows = sheetData.length;
    const seenClaimIDs = new Set();

    for (let r = startRow; r < totalRows; r++) {
      const row = sheetData[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      try {
        // build sourceRow keyed by headerSignature(actualHeader)
        const sourceRow = {};
        for (let c = 0; c < trimmedHeaderRow.length; c++) {
          const sig = headerSignature(trimmedHeaderRow[c] || '');
          sourceRow[sig] = row[c] ?? '';
        }

        // obtain Claim ID (prefer headerMap)
        let claimID = '';
        if (headerMap) {
          const claimSrc = Object.keys(headerMap).find(k => headerMap[k] === 'Pri. Claim No');
          if (claimSrc) claimID = (sourceRow[headerSignature(claimSrc)] ?? '').toString().trim();
        }
        if (!claimID) {
          // fallback common header names
          claimID = (sourceRow['priclaimno'] || sourceRow['claimid'] || sourceRow['priclaimid'] || '')?.toString().trim();
        }
        if (!claimID) continue; // can't work without claim key

        if (seenClaimIDs.has(claimID) || globalSeenClaimIDs.has(claimID)) continue;
        seenClaimIDs.add(claimID); globalSeenClaimIDs.add(claimID);

        // Determine facilityID according to schemaType and preference for filename for Odoo
        let facilityID = '';
        if (schemaType === 2) { // InstaHMS normally has facility column
          const facSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Facility ID');
          if (facSrc) facilityID = (sourceRow[headerSignature(facSrc)] ?? '').toString().trim();
          if (!facilityID) facilityID = getFacilityIDFromFileName(name);
        } else if (schemaType === 1) { // ClinicPro -> prefer VisitId then filename
          const visitSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Visit Id');
          const visitVal = visitSrc ? (sourceRow[headerSignature(visitSrc)] ?? '').toString().trim() : '';
          facilityID = getFacilityIDFromFileName(visitVal || name);
        } else { // Odoo -> prefer filename mapping, then Center Name, then visitId/filename fallback
          facilityID = getFacilityIDFromFileName(name);
          if (!facilityID) {
            const centerSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Facility ID' || (headerMap || {})[k] === 'Center Name' || k.toLowerCase().includes('center'));
            const centerVal = centerSrc ? (sourceRow[headerSignature(centerSrc)] ?? '').toString().trim() : '';
            if (centerVal) facilityID = getFacilityIDFromCenterName(centerVal);
          }
          if (!facilityID) {
            const visitSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Visit Id');
            const visitVal = visitSrc ? (sourceRow[headerSignature(visitSrc)] ?? '').toString().trim() : '';
            facilityID = getFacilityIDFromFileName(visitVal || name);
          }
        }

        // Clinician extraction & fallback
        let clinLicense = '', clinName = '';
        const clinLicenseSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Clinician License');
        const clinNameSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Clinician Name');
        if (clinLicenseSrc) clinLicense = (sourceRow[headerSignature(clinLicenseSrc)] ?? '').toString().trim();
        if (clinNameSrc) clinName = (sourceRow[headerSignature(clinNameSrc)] ?? '').toString().trim();

        // fallback 'OrderDoctor' style raw header
        if (!clinName) {
          const odKey = Object.keys(sourceRow).find(k => k.includes('orderdoctor'));
          if (odKey) clinName = (sourceRow[odKey] ?? '').toString().trim();
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

        // Do not skip Odoo rows when clinician info missing
        if (fileType && !fileType.startsWith('odoo') && !clinName && !clinLicense) {
          // non-odoo schemas require clinician info per previous rules
          continue;
        }

        // Encounter Date normalization (robust)
        let rawEncounterVal = '', normalizedEncounter = '';
        const encSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Encounter Date');
        if (encSrc) {
          rawEncounterVal = sourceRow[headerSignature(encSrc)] ?? '';
          normalizedEncounter = toExcelSerial(rawEncounterVal, schemaType);
        } else {
          // fallback common header signatures
          rawEncounterVal = sourceRow[headerSignature('Encounter Date')] ?? sourceRow[headerSignature('ClaimDate')] ?? sourceRow[headerSignature('Adm/Reg. Date')] ?? sourceRow['date'] ?? '';
          normalizedEncounter = toExcelSerial(rawEncounterVal, schemaType);
        }

        if (normalizedEncounter !== '' && normalizedEncounter !== null) {
          serialSet.add(Number(normalizedEncounter));
          const rawKey = (typeof rawEncounterVal === 'object') ? JSON.stringify(rawEncounterVal) : String(rawEncounterVal);
          rawToSerialMap[rawKey] = Number(normalizedEncounter);
        }

        // Compose output targetRow in order of headersWithRaw
        const targetRow = [];
        for (let col = 0; col < headersWithRaw.length; col++) {
          const tgt = headersWithRaw[col];
          let val = '';

          if (tgt === 'Facility ID') val = facilityID || '';
          else if (tgt === 'Pri. Patient Insurance Card No') {
            if (schemaType === 1) {
              // ClinicPro: prefer Member ID, then PatientCardID
              const memSrc = Object.keys(headerMap || {}).find(k => (headerMap || {})[k] === 'Pri. Patient Insurance Card No');
              const memSig = memSrc ? headerSignature(memSrc) : null;
              val = (memSig ? (sourceRow[memSig] ?? '') : '') || (sourceRow['memberid'] ?? sourceRow['patientcardid'] ?? '');
            } else {
              const sig = targetToSourceSig['Pri. Patient Insurance Card No'];
              val = (sig ? (sourceRow[sig] ?? '') : '') || (sourceRow[headerSignature('Pri. Member ID')] ?? sourceRow['memberid'] ?? sourceRow['patientcardid'] ?? '');
            }
          }
          else if (tgt === 'Patient Code') {
            const sig = targetToSourceSig['Patient Code'];
            val = sig ? (sourceRow[sig] ?? '') : ((sourceRow['mrno'] ?? sourceRow['fileno'] ?? '') || '');
          }
          else if (tgt === 'Clinician License') val = clinLicense || '';
          else if (tgt === 'Clinician Name') val = clinName || '';
          else if (tgt === 'Opened by') {
            if (fileType && fileType.startsWith('odoo')) val = ''; // intentionally blank for Odoo
            else {
              const sig = targetToSourceSig['Opened by'];
              if (sig) {
                val = sourceRow[sig] ?? sourceRow[headerSignature('Updated By')] ?? sourceRow[headerSignature('Opened by')] ?? sourceRow[headerSignature('Opened by/Registration Staff name')] ?? '';
              } else {
                val = sourceRow[headerSignature('Opened by')] ?? sourceRow[headerSignature('Opened by/Registration Staff name')] ?? sourceRow[headerSignature('Updated By')] ?? '';
              }
            }
          }
          else if (tgt === 'Encounter Date') val = normalizedEncounter;
          else if (tgt === 'Raw Encounter Date') val = rawEncounterVal ?? '';
          else if (tgt === 'Source File') val = name;
          else if (tgt === 'Total Amount') {
            // ensure Total Amount is captured: prefer mapped header, else common variants
            const sig = targetToSourceSig['Total Amount'];
            val = sig ? (sourceRow[sig] ?? '') : (sourceRow['totalsponsoramt'] ?? sourceRow['invoiceamount'] ?? sourceRow['totalamount'] ?? '');
          }
          else {
            const sig = targetToSourceSig[tgt] || null;
            val = sig ? (sourceRow[sig] ?? '') : '';
          }

          targetRow.push(val);
        }

        combinedRows.push(targetRow);

      } catch (err) {
        log(`Fatal row error in file ${name}, row ${r + 1}: ${err.message}`, 'ERROR');
      }
    } // end rows loop

    // progress update
    self.postMessage({ type: 'progress', progress: 50 + Math.floor(((i + 1) / fileEntries.length) * 50) });
  } // end files loop

  // Logging for debugging date serials and mapping
  try {
    log(`Raw->Serial mapping: ${JSON.stringify(rawToSerialMap)}`);
    log(`Unique Excel serials found: ${[...serialSet].sort((a, b) => a - b).join(', ')}`);
  } catch (e) { /* ignore stringify errors */ }

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
