// ==============================
// import and constants
// ==============================
// Import XLSX only when needed (wrapped in try-catch to handle CDN blocks)
let XLSX_LOADED = false;
try {
  importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  XLSX_LOADED = true;
} catch (e) {
  console.log('XLSX library not loaded - only XML mode will be available');
}

let JSZIP_LOADED = false;
try {
  importScripts('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
  JSZIP_LOADED = typeof JSZip !== 'undefined';
} catch (e) {
  console.log('JSZip library not loaded - large XLSX streaming unavailable');
}

const TARGET_HEADERS = [
  'Pri. Claim No', 'Clinician License', 'Encounter Date', 'Pri. Patient Insurance Card No',
  'Department', 'Visit Id', 'Pri. Plan Type', 'Facility ID',
  'Patient Code', 'Clinician Name', 'Opened by', 'Source File', 'Raw Encounter Date',
  'Total Amount', 'Emirates ID No.'
];

// === Header maps (unchanged) ===
const CLINICPRO_V1_MAP = {
  'ClaimID': 'Pri. Claim No', 'Clinician License': 'Clinician License',
  'ClaimDate': 'Encounter Date', 'Insurance Company': 'Pri. Plan Type',
  'PatientCardID': 'Pri. Patient Insurance Card No', 'Clinic': 'Department',
  'Emirates ID No': 'Emirates ID No.', 'Emirates ID No.': 'Emirates ID No.',
  'Visit Id': 'Visit Id', 'Clinician Name': 'Clinician Name',
  'Opened by/Registration Staff name': 'Opened by', 'Opened by': 'Opened by',
  'FileNo': 'Patient Code',
  'InvoiceAmount': 'Total Amount'
};

const CLINICPRO_V2_MAP = {
  'ClaimID': 'Pri. Claim No', 'Clinician License': 'Clinician License',
  'ClaimDate': 'Encounter Date', 'Insurance Company': 'Pri. Plan Type',
  'Member ID': 'Pri. Patient Insurance Card No', 'Clinic': 'Department',
  'Emirates ID No': 'Emirates ID No.', 'Emirates ID No.': 'Emirates ID No.',
  'Visit Id': 'Visit Id', 'Clinician Name': 'Clinician Name',
  'OrderDoctor': 'Clinician Name', 'Updated By': 'Opened by',
  'Opened by/Registration Staff name': 'Opened by', 'Opened by': 'Opened by',
  'FileNo': 'Patient Code',
  'InvoiceAmount': 'Total Amount'
};

const INSTAHMS_MAP = {
  'Pri. Claim No': 'Pri. Claim No', 'Clinician License': 'Clinician License',
  'Encounter Date': 'Encounter Date', 'Pri. Patient Insurance Card No': 'Pri. Patient Insurance Card No',
  'Emirates ID No': 'Emirates ID No.', 'Emirates ID No.': 'Emirates ID No.',
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
  'Emirates ID No': 'Emirates ID No.',
  'Emirates ID No.': 'Emirates ID No.',
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
  if (!XLSX_LOADED) {
    throw new Error("XLSX library not available. Cannot process eligibility files.");
  }
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
async function combineReportings(fileEntries) {
  log("Starting combineReportings function");
  if (!XLSX_LOADED) {
    throw new Error("XLSX library not available. Cannot process reporting files.");
  }
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

  // Load clinician licenses JSON
  try {
    log("Fetching clinician_licenses.json");
    const resp = await fetch('../json/clinician_licenses.json');
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

  // Helpers used only inside combineReportings to keep behavior local & robust
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30); // 1899-12-30 UTC
  const rawToSerialMap = {};
  const serialSet = new Set();
  const globalSeenClaimIDs = new Set();
  // Track claims that were added with a null/zero total amount so a later file
  // with a real price can replace the row (and supply the correct facility).
  const globalNullPriceClaims = new Set();
  const globalNullPriceRowIndex = new Map(); // claimID -> index in combinedRows

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

    // Pre-pass: sum Total Amount across all rows sharing a claim ID so that
    // the combined output reflects the full claim value, not just the first row.
    const claimAmountMap = new Map();
    for (let r = startRow; r < totalRows; r++) {
      const row = sheetData[r];
      if (!Array.isArray(row) || row.length === 0) continue;
      const sourceRow = {};
      for (let c = 0; c < trimmedHeaderRow.length; c++) {
        sourceRow[headerSignature(trimmedHeaderRow[c] || '')] = row[c] ?? '';
      }
      let claimID = '';
      if (headerMap) {
        const claimSrc = Object.keys(headerMap).find(k => headerMap[k] === 'Pri. Claim No');
        if (claimSrc) claimID = (sourceRow[headerSignature(claimSrc)] ?? '').toString().trim();
      }
      if (!claimID) {
        claimID = (sourceRow['priclaimno'] || sourceRow['claimid'] || sourceRow['priclaimid'] || '')?.toString().trim();
      }
      if (!claimID) continue;
      const codifStatus = (sourceRow['codificationstatus'] || '').toString().trim().toLowerCase();
      if (codifStatus === 'not seen') continue;
      const amtSig = targetToSourceSig['Total Amount'];
      const rawAmt = amtSig ? (sourceRow[amtSig] ?? '') : (sourceRow['totalsponsoramt'] ?? sourceRow['invoiceamount'] ?? sourceRow['totalamount'] ?? '');
      const amt = parseFloat(String(rawAmt).replace(/,/g, '')) || 0;
      claimAmountMap.set(claimID, (claimAmountMap.get(claimID) || 0) + amt);
    }

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

        // Skip rows where Codification Status is "Not Seen"
        const codifStatus = (sourceRow['codificationstatus'] || '').toString().trim().toLowerCase();
        if (codifStatus === 'not seen') continue;

        if (seenClaimIDs.has(claimID)) continue;
        seenClaimIDs.add(claimID);

        // Skip if already locked globally with a non-null price.
        if (globalSeenClaimIDs.has(claimID)) continue;

        // If the claim was seen before with a null/zero price, we still allow
        // this row to proceed so a non-null price occurrence can replace it.
        // Note: both null/undefined and genuine zero amounts are treated identically
        // as "null price" — a claim with a real price (> 0) from any file always wins.
        const wasSeenWithNullPrice = globalNullPriceClaims.has(claimID);

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
          else if (tgt === 'Emirates ID No.') {
            const sig = targetToSourceSig['Emirates ID No.'];
            val = (sig ? (sourceRow[sig] ?? '') : '')
              || sourceRow[headerSignature('Emirates ID No')]
              || sourceRow[headerSignature('Emirates ID No.')]
              || '';
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
            // Use the summed total across all rows sharing this claim ID
            val = claimAmountMap.has(claimID) ? claimAmountMap.get(claimID) : '';
          }
          else {
            const sig = targetToSourceSig[tgt] || null;
            val = sig ? (sourceRow[sig] ?? '') : '';
          }

          targetRow.push(val);
        }

        const totalAmt = claimAmountMap.get(claimID) || 0;
        if (wasSeenWithNullPrice && totalAmt > 0) {
          // A better (non-null price) row is available — replace the previous null-price row.
          const prevIdx = globalNullPriceRowIndex.get(claimID);
          if (typeof prevIdx === 'number' && prevIdx >= 0 && prevIdx < combinedRows.length) {
            combinedRows[prevIdx] = targetRow;
          }
          globalNullPriceClaims.delete(claimID);
          globalNullPriceRowIndex.delete(claimID);
          globalSeenClaimIDs.add(claimID);
          log(`Replaced null-price row for claim "${claimID}" with non-null price row from "${name}"`);
        } else if (!wasSeenWithNullPrice) {
          // First occurrence of this claim across all files.
          const rowIndex = combinedRows.length;
          combinedRows.push(targetRow);
          if (totalAmt === 0) {
            globalNullPriceClaims.add(claimID);
            globalNullPriceRowIndex.set(claimID, rowIndex);
          } else {
            globalSeenClaimIDs.add(claimID);
          }
        }
        // else: wasSeenWithNullPrice && totalAmt === 0 → this file also has null price;
        //       keep the first null-price row and skip this duplicate.

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

function fullXmlDecode(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, function(_, hex) { return String.fromCodePoint(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function(_, dec) { return String.fromCodePoint(parseInt(dec, 10)); })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function fullGetAttr(attrs, name) {
  const match = new RegExp('\\b' + name + '="([^"]*)"', 'i').exec(attrs || '');
  return match ? fullXmlDecode(match[1]) : '';
}

function fullColumnIndexFromRef(ref) {
  const match = /^([A-Z]+)\d+$/i.exec(String(ref || ''));
  if (!match) return -1;
  let index = 0;
  for (const ch of match[1].toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function fullCellTextFromXml(body) {
  const pieces = [];
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
  let match;
  while ((match = re.exec(body))) pieces.push(fullXmlDecode(match[1]));
  return pieces.join('');
}

function fullParseWorksheetRowXml(rowXml, sharedStrings) {
  const row = new Map();
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi;
  let match;

  while ((match = cellRe.exec(rowXml))) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const columnIndex = fullColumnIndexFromRef(fullGetAttr(attrs, 'r'));
    if (columnIndex < 0) continue;

    const type = fullGetAttr(attrs, 't').toLowerCase();
    let value = '';

    if (type === 'inlinestr') {
      value = fullCellTextFromXml(body);
    } else {
      const valueMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body);
      const raw = valueMatch ? fullXmlDecode(valueMatch[1]) : '';

      if (type === 's') {
        const idx = Number(raw);
        value = Number.isInteger(idx) && idx >= 0 ? (sharedStrings[idx] || '') : '';
      } else if (type === 'b') {
        value = raw === '1';
      } else if (type === 'str' || type === 'e') {
        value = raw;
      } else if (raw !== '' && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
        const num = Number(raw);
        value = Number.isFinite(num) ? num : raw;
      } else if (raw !== '') {
        value = raw;
      } else {
        const formulaMatch = /<f\b[^>]*>([\s\S]*?)<\/f>/i.exec(body);
        value = formulaMatch ? '=' + fullXmlDecode(formulaMatch[1]) : '';
      }
    }

    if (value !== '' && value !== null && value !== undefined) row.set(columnIndex, value);
  }

  return row;
}

function fullStreamZipXmlElements(zipFile, tagName, onElement) {
  return new Promise(function(resolve, reject) {
    if (!zipFile) {
      resolve();
      return;
    }

    const decoder = new TextDecoder('utf-8');
    const stream = zipFile.internalStream('uint8array');
    const openToken = '<' + tagName;
    const closeToken = '</' + tagName + '>';
    let carry = '';
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    function consume(final) {
      while (true) {
        const start = carry.indexOf(openToken);
        if (start < 0) {
          if (final) carry = '';
          else if (carry.length > 8192) carry = carry.slice(-8192);
          return;
        }
        if (start > 0) carry = carry.slice(start);

        const end = carry.indexOf(closeToken);
        if (end < 0) return;

        const fullEnd = end + closeToken.length;
        const xml = carry.slice(0, fullEnd);
        carry = carry.slice(fullEnd);
        onElement(xml);
      }
    }

    stream.on('data', function(chunk) {
      if (settled) return;
      try {
        carry += decoder.decode(chunk, { stream: true });
        consume(false);
      } catch (err) {
        fail(err);
      }
    });
    stream.on('error', fail);
    stream.on('end', function() {
      if (settled) return;
      try {
        carry += decoder.decode();
        consume(true);
        settled = true;
        resolve();
      } catch (err) {
        fail(err);
      }
    });
    stream.resume();
  });
}

async function fullResolveFirstWorksheetPath(zip) {
  const workbookFile = zip.file('xl/workbook.xml');
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbookFile || !relsFile) return 'xl/worksheets/sheet1.xml';

  const values = await Promise.all([workbookFile.async('string'), relsFile.async('string')]);
  const workbookXml = values[0];
  const relsXml = values[1];
  const sheetMatch = /<sheet\b[^>]*\br:id="([^"]+)"/i.exec(workbookXml);
  if (!sheetMatch) return 'xl/worksheets/sheet1.xml';

  const relId = sheetMatch[1];
  const relRe = /<Relationship\b([^>]*?)\/?>/gi;
  let relMatch;
  while ((relMatch = relRe.exec(relsXml))) {
    const attrs = relMatch[1] || '';
    if (fullGetAttr(attrs, 'Id') !== relId) continue;

    let target = fullGetAttr(attrs, 'Target').replace(/\\/g, '/');
    if (!target) break;
    if (target.startsWith('/')) return target.replace(/^\/+/, '');
    if (target.startsWith('xl/')) return target;

    const parts = ['xl'];
    target.split('/').forEach(function(segment) {
      if (!segment || segment === '.') return;
      if (segment === '..') parts.pop();
      else parts.push(segment);
    });
    return parts.join('/');
  }

  return 'xl/worksheets/sheet1.xml';
}

async function fullLoadSharedStrings(zip) {
  const shared = [];
  const file = zip.file('xl/sharedStrings.xml');
  if (!file) return shared;
  await fullStreamZipXmlElements(file, 'si', function(xml) {
    shared.push(fullCellTextFromXml(xml));
  });
  return shared;
}

async function fullOpenStreamingXlsx(entry) {
  if (!JSZIP_LOADED) throw new Error('JSZip is required for large XLSX streaming.');
  const zip = await JSZip.loadAsync(entry.buffer);
  const sheetPath = await fullResolveFirstWorksheetPath(zip);
  const sharedStrings = await fullLoadSharedStrings(zip);
  const worksheetFile = zip.file(sheetPath);
  if (!worksheetFile) throw new Error(entry.name + ': worksheet XML not found at ' + sheetPath);

  return {
    streamRows: async function(onRow) {
      let fallbackRowIndex = 0;
      await fullStreamZipXmlElements(worksheetFile, 'row', function(rowXml) {
        const rowTag = /^<row\b([^>]*)>/i.exec(rowXml);
        const rowNumber = rowTag ? Number(fullGetAttr(rowTag[1], 'r')) : NaN;
        const rowIndex = Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber - 1 : fallbackRowIndex;
        fallbackRowIndex = Math.max(fallbackRowIndex + 1, rowIndex + 1);

        const cells = fullParseWorksheetRowXml(rowXml, sharedStrings);
        if (cells.size) onRow(rowIndex, cells);
      });
    }
  };
}

// ==============================
// Reporting (full) combiner
// ==============================
async function combineReportingsFull(fileEntries) {
  log("Starting combineReportingsFull function");
  if (!XLSX_LOADED) {
    throw new Error("XLSX library not available. Cannot process reporting files.");
  }
  if (!Array.isArray(fileEntries) || fileEntries.length === 0) {
    throw new Error("No input files provided");
  }

  const XLSX = (typeof window !== "undefined" ? window.XLSX : self.XLSX);
  let dataRowCount = 0;

  const EXCEL_MAX_ROW = 1048575;
  const EXCEL_MAX_COL = 16383;

  const normalizeHeader = (value) =>
    String(value === null || value === undefined ? '' : value)
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();

  const isMeaningfulCell = (cell) => {
    if (!cell || typeof cell !== 'object') return false;
    if (cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') return true;
    return typeof cell.f === 'string' && cell.f.trim() !== '';
  };

  const cellOutputValue = (cell) => {
    if (!cell || typeof cell !== 'object') return '';
    if (cell.v !== undefined && cell.v !== null) return cell.v;
    return typeof cell.f === 'string' && cell.f.trim() ? `=${cell.f}` : '';
  };

  const getMergeRanges = (ws) => (Array.isArray(ws?.['!merges']) ? ws['!merges'] : [])
    .filter(merge =>
      merge && merge.s && merge.e &&
      Number.isInteger(merge.s.r) && Number.isInteger(merge.e.r) &&
      Number.isInteger(merge.s.c) && Number.isInteger(merge.e.c) &&
      merge.s.r >= 0 && merge.s.c >= 0 &&
      merge.e.r >= merge.s.r && merge.e.c >= merge.s.c
    );

  const isMergedRow = (rowIndex, merges) => merges.some(merge =>
    rowIndex >= merge.s.r && rowIndex <= merge.e.r
  );

  const collectMeaningfulRows = (ws, fileName) => {
    const rows = new Map();
    let ignoredOutOfBounds = 0;

    // With XLSX dense:true, SheetJS represents the worksheet as an array of
    // row arrays. Some builds expose the dense data under !data instead, so
    // support both forms. Crucially, neither path enumerates every A1-style
    // worksheet property.
    const denseRows = Array.isArray(ws)
      ? ws
      : (Array.isArray(ws?.['!data']) ? ws['!data'] : null);

    if (!denseRows) {
      throw new Error(
        `${fileName}: worksheet could not be read in dense mode; refusing unsafe property enumeration.`
      );
    }

    for (let rowIndex = 0; rowIndex < denseRows.length; rowIndex++) {
      if (rowIndex > EXCEL_MAX_ROW) {
        ignoredOutOfBounds++;
        break;
      }

      const denseRow = denseRows[rowIndex];
      if (!Array.isArray(denseRow) || denseRow.length === 0) continue;

      let outputRow = null;
      const maxColumns = Math.min(denseRow.length, EXCEL_MAX_COL + 1);

      for (let columnIndex = 0; columnIndex < maxColumns; columnIndex++) {
        const cell = denseRow[columnIndex];
        if (!isMeaningfulCell(cell)) continue;

        if (!outputRow) outputRow = new Map();
        outputRow.set(columnIndex, cellOutputValue(cell));
      }

      if (outputRow && outputRow.size) {
        rows.set(rowIndex, outputRow);
      }
    }

    if (ignoredOutOfBounds) {
      log(
        `${fileName}: ignored worksheet content beyond Excel's supported row limit.`,
        'WARN'
      );
    }

    return rows;
  };

  const parsedFiles = [];
  const headerLabelsByKey = new Map();
  const headerKeysInOrder = [];

  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    log(`Reading reporting(full) file: ${name}`);

    let wb;
    try {
      // Dense mode stores worksheet cells in row arrays instead of creating
      // one object property per cell address (A1, B1, ...). This prevents
      // "Too many properties to enumerate" on very large reports.
      wb = XLSX.read(buffer, { type: 'array', cellDates: false, dense: true });
    } catch (err) {
      log(`Failed to read file ${name}: ${err.message}`, 'ERROR');
      continue;
    }

    if (!wb.SheetNames || wb.SheetNames.length === 0) {
      log(`File ${name} skipped: no sheets found`, 'WARN');
      continue;
    }

    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) {
      log(`File ${name} skipped: first sheet is missing`, 'WARN');
      continue;
    }

    const merges = getMergeRanges(ws);
    const meaningfulRows = collectMeaningfulRows(ws, name);
    const rowIndexes = Array.from(meaningfulRows.keys()).sort((a, b) => a - b);

    if (!rowIndexes.length) {
      log(`File ${name} skipped: no populated cells found`, 'WARN');
      continue;
    }

    let fileHeaderRowIndex = -1;
    let fileHeaderCells = null;

    for (const rowIndex of rowIndexes) {
      if (isMergedRow(rowIndex, merges)) continue;
      const cells = meaningfulRows.get(rowIndex);
      if (!cells || !cells.size) continue;

      const hasUsableValue = Array.from(cells.values()).some(value =>
        String(value === null || value === undefined ? '' : value).trim() !== ''
      );
      if (!hasUsableValue) continue;

      fileHeaderRowIndex = rowIndex;
      fileHeaderCells = cells;
      break;
    }

    if (fileHeaderRowIndex < 0 || !(fileHeaderCells instanceof Map)) {
      log(`File ${name} skipped: no non-merged populated rows found`, 'WARN');
      continue;
    }

    const sourceColumns = [];
    const headerSignatureParts = [];

    Array.from(fileHeaderCells.entries())
      .sort((a, b) => a[0] - b[0])
      .forEach(([sourceIndex, header]) => {
        const key = normalizeHeader(header);
        if (!key) return;

        sourceColumns.push({ sourceIndex, key });
        headerSignatureParts.push([sourceIndex, key]);

        if (!headerLabelsByKey.has(key)) {
          headerLabelsByKey.set(key, String(header).trim().replace(/\s+/g, ' '));
          headerKeysInOrder.push(key);
        }
      });

    if (!sourceColumns.length) {
      log(`File ${name} skipped: header row contains no usable column names`, 'WARN');
      continue;
    }

    parsedFiles.push({
      name,
      meaningfulRows,
      rowIndexes,
      merges,
      fileHeaderRowIndex,
      fileHeaderSignature: JSON.stringify(headerSignatureParts),
      sourceColumns
    });

    log(
      `${name}: discovered ${sourceColumns.length} named column(s); ` +
      `combined schema now has ${headerKeysInOrder.length} column(s).`
    );

    const progress = 10 + Math.floor(((i + 1) / fileEntries.length) * 40);
    self.postMessage({ type: 'progress', progress });
  }

  if (!parsedFiles.length || !headerKeysInOrder.length) {
    throw new Error('No non-merged rows with usable headers found in uploaded files');
  }

  // Preserve the first valid report's header order. Any column first seen in a
  // later report is appended to the end in that report's own left-to-right order.
  const outputHeaders = headerKeysInOrder.map(key => headerLabelsByKey.get(key));
  const outputIndexByKey = new Map(headerKeysInOrder.map((key, index) => [key, index]));

  // Build output in bounded worksheet segments. SheetJS serializes each
  // worksheet to XML before zipping the workbook; one extremely large sheet can
  // exceed V8's maximum string length even when input/output processing is dense.
  // Keeping each worksheet bounded prevents a single giant XML string.
  const OUTPUT_BATCH_ROWS = 5000;
  const MAX_DATA_ROWS_PER_SHEET = 50000;
  const outputSheets = [];
  let wsOut = XLSX.utils.aoa_to_sheet([outputHeaders], { dense: true });
  let outputBatch = [];
  let outputRowIndex = 1; // zero-based row 0 already contains the headers
  let currentSheetDataRows = 0;

  const finalizeCurrentSheet = () => {
    outputSheets.push(wsOut);
    wsOut = XLSX.utils.aoa_to_sheet([outputHeaders], { dense: true });
    outputRowIndex = 1;
    currentSheetDataRows = 0;
  };

  const flushOutputBatch = () => {
    if (!outputBatch.length) return;

    let offset = 0;
    while (offset < outputBatch.length) {
      const remainingCapacity = MAX_DATA_ROWS_PER_SHEET - currentSheetDataRows;

      if (remainingCapacity <= 0) {
        finalizeCurrentSheet();
        continue;
      }

      const take = Math.min(remainingCapacity, outputBatch.length - offset);
      const chunk = outputBatch.slice(offset, offset + take);

      XLSX.utils.sheet_add_aoa(wsOut, chunk, {
        origin: { r: outputRowIndex, c: 0 }
      });

      outputRowIndex += take;
      currentSheetDataRows += take;
      offset += take;

      if (currentSheetDataRows >= MAX_DATA_ROWS_PER_SHEET && offset < outputBatch.length) {
        finalizeCurrentSheet();
      }
    }

    outputBatch = [];
  };

  // De-duplicate only rows that are identical across the entire final schema.
  // Matching Claim IDs or partial field matches are not enough.
  const seenExactRows = new Set();
  const exactRowSignature = (row) => JSON.stringify(
    row.map(value => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'number') return { type: 'number', value };
      if (typeof value === 'boolean') return { type: 'boolean', value };
      return { type: 'string', value: String(value) };
    })
  );

  for (let i = 0; i < parsedFiles.length; i++) {
    const file = parsedFiles[i];

    for (const rowIndex of file.rowIndexes) {
      if (rowIndex <= file.fileHeaderRowIndex) continue;
      if (isMergedRow(rowIndex, file.merges)) continue;

      const sourceCells = file.meaningfulRows.get(rowIndex);
      if (!(sourceCells instanceof Map) || !sourceCells.size) continue;

      const repeatedHeaderSignature = JSON.stringify(
        file.sourceColumns
          .map(({ sourceIndex }) => [sourceIndex, normalizeHeader(sourceCells.get(sourceIndex) ?? '')])
          .filter(([, key]) => key)
      );
      if (repeatedHeaderSignature === file.fileHeaderSignature) continue;

      const outputRow = new Array(outputHeaders.length).fill('');
      let hasOutputValue = false;

      for (const { sourceIndex, key } of file.sourceColumns) {
        const outputIndex = outputIndexByKey.get(key);
        if (outputIndex === undefined) continue;

        const value = sourceCells.get(sourceIndex) ?? '';
        outputRow[outputIndex] = value;
        if (String(value === null || value === undefined ? '' : value).trim() !== '') {
          hasOutputValue = true;
        }
      }

      if (!hasOutputValue) continue;

      const rowSignature = exactRowSignature(outputRow);
      if (seenExactRows.has(rowSignature)) {
        continue;
      }

      seenExactRows.add(rowSignature);
      outputBatch.push(outputRow);
      dataRowCount++;

      if (outputBatch.length >= OUTPUT_BATCH_ROWS) {
        flushOutputBatch();
      }
    }

    log(
      `${file.name}: appended rows using combined ${outputHeaders.length}-column schema.`
    );

    const progress = 50 + Math.floor(((i + 1) / parsedFiles.length) * 50);
    self.postMessage({ type: 'progress', progress });
  }

  flushOutputBatch();
  if (currentSheetDataRows > 0 || outputSheets.length === 0) {
    outputSheets.push(wsOut);
  }

  const wbOut = XLSX.utils.book_new();
  outputSheets.forEach((sheet, index) => {
    const sheetName = outputSheets.length === 1
      ? 'Combined Reporting Full'
      : `Combined Full ${index + 1}`;
    XLSX.utils.book_append_sheet(wbOut, sheet, sheetName);
  });

  log(
    `Combined reporting(full) workbook created with ${dataRowCount} data rows, ` +
    `${outputHeaders.length} unique columns, across ${outputSheets.length} sheet(s)`
  );
  self.postMessage({ type: 'progress', progress: 100 });
  return wbOut;
}

// ==============================
// combineXMLs function
// ==============================
async function combineXMLs(fileEntries) {
  log("Starting XML combining");
  if (!fileEntries || !fileEntries.length) {
    log("No XML files provided", "ERROR");
    throw new Error("No XML files provided");
  }

  self.postMessage({ type: 'progress', progress: 10 });

  // We'll parse each XML, extract the Claim elements, and merge them
  const parser = new DOMParser();
  let combinedClaims = [];
  let firstXmlDoc = null;
  let parseErrors = 0;

  for (let i = 0; i < fileEntries.length; i++) {
    const entry = fileEntries[i];
    log(`Processing XML file ${i + 1}/${fileEntries.length}: ${entry.name}`);
    
    try {
      // Convert ArrayBuffer to string
      const textDecoder = new TextDecoder('utf-8');
      const xmlString = textDecoder.decode(entry.buffer);
      
      // Parse the XML
      const xmlDoc = parser.parseFromString(xmlString, "text/xml");
      
      // Check for parsing errors
      const parserError = xmlDoc.querySelector('parsererror');
      if (parserError) {
        log(`XML parsing error in ${entry.name}: ${parserError.textContent}`, 'ERROR');
        parseErrors++;
        continue;
      }
      
      // Store the first successfully parsed document as template
      if (!firstXmlDoc) {
        firstXmlDoc = xmlDoc;
      }
      
      // Extract all Claim elements that are direct children of the root
      const root = xmlDoc.documentElement;
      if (root) {
        // Get all direct child elements named "Claim"
        const children = root.children || root.childNodes;
        for (let j = 0; j < children.length; j++) {
          const child = children[j];
          if (child.nodeType === 1 && child.tagName === 'Claim') {
            combinedClaims.push(child);
          }
        }
      }
      
      log(`Found ${combinedClaims.length - (i > 0 ? combinedClaims.length : 0)} claim(s) in ${entry.name}`);
      
    } catch (err) {
      log(`Error processing ${entry.name}: ${err.message}`, 'ERROR');
      parseErrors++;
    }
    
    const progress = 10 + (80 * (i + 1) / fileEntries.length);
    self.postMessage({ type: 'progress', progress: Math.floor(progress) });
  }

  if (parseErrors === fileEntries.length) {
    log(`All ${parseErrors} file(s) failed to parse`, "ERROR");
    throw new Error(`Failed to parse all ${parseErrors} XML file(s)`);
  }

  if (combinedClaims.length === 0) {
    log("No claims found in any XML file", "ERROR");
    throw new Error(`Successfully parsed ${fileEntries.length - parseErrors} file(s), but found no claims`);
  }

  log(`Total claims collected: ${combinedClaims.length} from ${fileEntries.length - parseErrors} file(s)`);
  self.postMessage({ type: 'progress', progress: 90 });

  // Build the combined XML structure using the first parsed document as template
  const serializer = new XMLSerializer();
  const rootNode = firstXmlDoc.documentElement.cloneNode(true);
  
  // Remove all existing Claim children from root (only direct children)
  const children = Array.from(rootNode.children || rootNode.childNodes);
  for (const child of children) {
    if (child.nodeType === 1 && child.tagName === 'Claim') {
      rootNode.removeChild(child);
    }
  }
  
  // Update the RecordCount in Header if it exists
  const headerRecordCount = rootNode.querySelector('Header > RecordCount');
  if (headerRecordCount) {
    headerRecordCount.textContent = combinedClaims.length.toString();
  }
  
  // Add all combined claims to the root node
  combinedClaims.forEach(claim => {
    const importedClaim = rootNode.ownerDocument.importNode(claim, true);
    rootNode.appendChild(importedClaim);
  });

  // Serialize the combined XML
  const combinedXmlString = serializer.serializeToString(rootNode);
  
  // Add XML declaration
  const finalXml = '<?xml version="1.0" encoding="utf-8"?>\n' + combinedXmlString;
  
  log(`Combined XML created with ${combinedClaims.length} claims`);
  self.postMessage({ type: 'progress', progress: 100 });
  
  // Return the XML string as a Uint8Array
  const encoder = new TextEncoder();
  return encoder.encode(finalXml);
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
  const { mode, files } = e.data;
  try {
    log(`Processing started in mode: ${mode}, ${files.length} file(s)`);
    
    if (mode === 'xml') {
      // XML mode is now handled in main thread (DOMParser not available in workers)
      log('XML mode should be processed in main thread, not worker', 'WARN');
      throw new Error('XML mode should be processed in main thread');
    } else {
      // Handle eligibility/reporting modes - returns workbook
      let combineFn = combineReportings;
      if (mode === 'eligibility') combineFn = combineEligibilities;
      else if (mode === 'reporting_full') combineFn = combineReportingsFull;
      const wb = await combineFn(files);
      const wbArray = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const wbUint8 = new Uint8Array(wbArray);
      self.postMessage({ type: 'result', workbookData: wbUint8 }, [wbUint8.buffer]);
      log(`Processing complete for mode: ${mode}`, 'SUCCESS');
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message });
    log(`Error during processing: ${err.message}`, 'ERROR');
  }
};
