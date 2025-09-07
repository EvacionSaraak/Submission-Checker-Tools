importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

const TARGET_HEADERS = [
  'Pri. Claim No', 'Clinician License', 'Encounter Date', 'Pri. Patient Insurance Card No',
  'Department', 'Visit Id', 'Pri. Plan Type', 'Facility ID',
  'Patient Code', 'Clinician Name', 'Opened by', 'Source File'
];

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

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const msg = `[${level}] ${timestamp} - ${message}`;
  self.postMessage({ type: 'log', message: msg });
  // console.log(msg); // Uncomment for browser debugging
}

function normalizeName(name) { return (name || '').replace(/\s+/g, '').toLowerCase(); }

function normalizeExcelSerial(v, is1904=false){
  if(v==null||v==='') return '';
  if(typeof v==='number'&&!isNaN(v)) return Math.round(v);
  if(Object.prototype.toString.call(v)==='[object Date]'&&!isNaN(v)){
    let b=is1904?Date.UTC(1904,0,1):Date.UTC(1899,11,30);
    let u=Date.UTC(v.getFullYear(),v.getMonth(),v.getDate());
    return Math.round((u-b)/86400000);
  }
  let s=String(v).trim(),m;
  if(m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/)) return normalizeExcelSerial(new Date(+m[1],+m[2]-1,+m[3]),is1904);
  if(m=s.match(/^(\d{2})-(\d{2})-(\d{4})$/)) return normalizeExcelSerial(new Date(+m[3],+m[2]-1,+m[1]),is1904);
  if(m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)) return normalizeExcelSerial(new Date(+m[3],+m[1]-1,+m[2]),is1904);
  let d=new Date(s);
  if(!isNaN(d)) return normalizeExcelSerial(d,is1904);
  let n=Number(s.replace(/[^\d.]/g,'')); 
  return !isNaN(n)&&n>0?Math.round(n):'';
}

function findHeaderRowFromArrays(sheetRows, maxScan = 10) {
  if (!Array.isArray(sheetRows) || sheetRows.length === 0) { return { headerRowIndex: -1, headers: [], rows: [] }; }
  const tokens = [
    'pri. claim no', 'pri claim no', 'claimid', 'claim id', 'pri. claim id', 'pri claim id',
    'center name', 'card number', 'card number / dha member id', 'member id', 'patientcardid',
    'pri. patient insurance card no', 'institution', 'facility id', 'mr no.', 'pri. claim id',
    'encounter date', 'claimdate', 'adm/reg. date', 'adm/reg date'
  ];
  const limit = Math.min(maxScan, sheetRows.length);
  let bestIndex = 0;
  let bestScore = 0;
  for (let i = 0; i < limit; i++) {
    const row = sheetRows[i];
    if (!Array.isArray(row)) continue;
    const joined = row.map(c => (c === undefined || c === null) ? '' : String(c)).join(' ').toLowerCase();
    let score = 0;
    for (const t of tokens) { if (joined.includes(t)) score++; }
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

// REPLACEMENT: safer tolerant header matcher
function findHeaderMatch(headerRow, srcHeader) {
  if (!Array.isArray(headerRow) || !srcHeader) return null;

  // normalize: lowercase, trim, remove zero-width, collapse punctuation/whitespace to single space
  const normalize = s => String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')   // zero-width
    .replace(/\u00A0/g, ' ')                 // NBSP
    .toLowerCase()
    .trim()
    .replace(/[\.\-\/,_\s]+/g, ' ');

  const targetNorm = normalize(srcHeader);
  const targetTokens = targetNorm.split(' ').filter(Boolean);

  // 1) exact normalized equality (strongest)
  for (const h of headerRow) {
    if (normalize(h) === targetNorm) return h;
  }

  // 2) token-overlap: require at least two shared tokens, or all tokens if target has <=2 tokens
  //    (this prevents short-substring accidental matches like "clinic" <> "clinician license")
  for (const h of headerRow) {
    const hn = normalize(h);
    const hTokens = hn.split(' ').filter(Boolean);
    if (hTokens.length === 0 || targetTokens.length === 0) continue;

    // count shared tokens (exact token equality)
    const shared = targetTokens.filter(t => hTokens.includes(t));
    const required = Math.min(2, targetTokens.length); // if target has 1 token -> require 1, else 2
    if (shared.length >= required) return h;
  }

  // No safe match found
  return null;
}

function fallbackClinicianLookupWithFacility(rawName, facilityLicense, fallbackExcel) {
  if (!rawName || !facilityLicense || !Array.isArray(fallbackExcel) || fallbackExcel.length === 0) return null;
  const normRaw = normalizeName(rawName);
  const filtered = fallbackExcel.filter(row => row.facilityLicense?.toLowerCase() === facilityLicense.toLowerCase());
  for (const row of filtered) {
    const normExcel = normalizeName(row.nm);
    if (normRaw === normExcel) {
      const inpWords = rawName.trim().split(/\s+/);
      const exWords = row.nm.trim().split(/\s+/);
      if (inpWords.length >= 2 && exWords.length >= 2 &&
        inpWords[0].toLowerCase() === exWords[0].toLowerCase() &&
        inpWords[inpWords.length - 1].toLowerCase() === exWords[exWords.length - 1].toLowerCase()) {
        return { license: row.lic, name: row.nm };
      }
    }
  }
  return null;
}

// Extract Facility ID from an Odoo Center Name string.
// Tries to match MF\d+ first; then matches facilityNameMap keys as substring (case-insensitive).
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

// Helper: simple tolerant presence check for a header name in detected headerRow
// Returns the matched header string from headerRow if found, otherwise null.
function headerExists(headerRow, srcHeader) {
  if (!Array.isArray(headerRow) || headerRow.length === 0) return null;
  // use the previously defined tolerant match function if available; fall back to normalized exact
  if (typeof findHeaderMatch === 'function') {
    return findHeaderMatch(headerRow, srcHeader);
  }
  // fallback normalization (lowercase trimmed, remove punctuation)
  const normalize = s => String(s || '').toLowerCase().trim().replace(/[\.\-\/,_\s]+/g, ' ');
  const target = normalize(srcHeader);
  for (const h of headerRow) {
    if (normalize(h) === target) return h;
  }
  return null;
}

// Helper: read various input types and return first sheet as array-of-arrays (header:1)
async function readXlsxFile(input) {
  if (!input) return [];

  // Accept: File/Blob, ArrayBuffer, or an object with .buffer (Uint8/ArrayBuffer)
  let buffer = null;
  try {
    if (input instanceof ArrayBuffer) {
      buffer = input;
    } else if (typeof input.arrayBuffer === 'function') {
      // File/Blob-like
      buffer = await input.arrayBuffer();
    } else if (input.buffer) {
      // custom object { name, buffer }
      buffer = input.buffer;
    } else if (input.data) {
      buffer = input.data;
    } else {
      throw new Error('Unsupported input type for readXlsxFile');
    }
  } catch (err) {
    throw new Error(`readXlsxFile: failed to obtain buffer - ${err.message}`);
  }

  // Parse workbook
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  if (!wb || !wb.SheetNames || wb.SheetNames.length === 0) return [];

  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];

  // Return as array-of-arrays (first row = header row)
  const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  return sheetData;
}


function convertToExcelDateUniversal(value) {
  if (!value) return '';
  if (!isNaN(value) && typeof value !== 'object') {
    const num = Number(value);
    if (num > 20000 && num < 60000) return Math.floor(num);
  }
  let date;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) date = value;
  else if (typeof value === 'string') {
    const v = value.trim();
    const dmy = v.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dmy) date = new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}`);
    else if (v.match(/^(\d{4})-(\d{2})-(\d{2})$/)) date = new Date(v);
    else if (v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)) {
      const mdy = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      date = new Date(`${mdy[3]}-${mdy[1]}-${mdy[2]}`);
    }
    else if (!isNaN(Date.parse(v))) date = new Date(v);
  }
  if (!date || isNaN(date)) return '';
  const base = new Date(Date.UTC(1899, 11, 30));
  return Math.floor((date - base) / (1000 * 60 * 60 * 24));
}

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

function normalizeHeadersForCombining(headers) {
  const mapping = {
    // ClinicPro
    "claimid": "Pri. Claim No",
    "claimdate": "Encounter Date",
    "insurance company": "Pri. Plan Type",
    "patientcardid": "Pri. Patient Insurance Card No",
    "member id": "Pri. Patient Insurance Card No",
    "clinic": "Department",
    "fileno": "Patient Code",
    "clinician license": "Clinician License",
    "opened by/registration staff name": "Opened by",
    "clinician name": "Clinician Name",
    // Odoo
    "invoice no": "Pri. Claim No",
    "date": "Encounter Date",
    "payer": "Pri. Plan Type",
    "patient card no": "Pri. Patient Insurance Card No",
    "department": "Department",
    "file number": "Patient Code",
    "doctor license": "Clinician License",
    "created by": "Opened by",
    // InstaHMS
    "pri. claim no": "Pri. Claim No",
    "encounter date": "Encounter Date",
    "pri. plan type": "Pri. Plan Type",
    "pri. patient insurance card no": "Pri. Patient Insurance Card No",
    "department": "Department",
    "patient code": "Patient Code",
    "clinician license": "Clinician License",
    "opened by": "Opened by",
    "clinician name": "Clinician Name",
    "visit id": "Visit Id",
    "facility id": "Facility ID"
  };

  const lowerHeaders = headers.map(h => (h || '').toString().trim().toLowerCase());
  const normalizedHeaders = lowerHeaders.map(h => mapping[h] || h);

  // Example detection of Odoo file by header tokens
  const isOdoo = lowerHeaders.includes('pri. claim id') &&
                 (lowerHeaders.includes('adm/reg') || lowerHeaders.includes('adm/reg. date') || lowerHeaders.includes('adm reg'));

  return { headers: normalizedHeaders, isOdoo };
}

function headerSignature(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')   // remove zero-width
    .replace(/\u00A0/g, ' ')                 // NBSP -> space
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');              // remove non-alphanumerics
}

// Converts a JS Date, Excel serial number, or string into Excel serial number
function toExcelSerial(value, sourceType = 0) {
  if (value === null || value === undefined || value === '') return '';
  let dateObj;
  if (typeof value === 'number') return Math.floor(value);
  if (value instanceof Date) {
    dateObj = value;
  } else if (typeof value === 'string') {
    if (sourceType === 2) {
      // Insta: parse as DMY
      const [d, m, y] = value.split(/[\/\-\.]/).map(s => parseInt(s, 10));
      if (!d || !m || !y) return '';
      dateObj = new Date(y, m - 1, d);
    } else {
      // Odoo / ClinicPro: parse normally
      const parsed = Date.parse(value);
      if (isNaN(parsed)) return '';
      dateObj = new Date(parsed);
    }
  } else {
    return '';
  }

  // Excel serial number: days since 1899-12-31
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const diff = (dateObj - epoch) / (1000 * 60 * 60 * 24);
  return Math.floor(diff);
}

function logRawToSerialMap(combinedRows, headersWithRaw) {
  const encIdx = headersWithRaw.indexOf('Encounter Date');
  const rawIdx = headersWithRaw.indexOf('Raw Encounter Date');
  const map = {};
  for (let i = 1; i < combinedRows.length; i++) {
    const row = combinedRows[i];
    const raw = (row[rawIdx] !== undefined && row[rawIdx] !== null) ? String(row[rawIdx]) : '';
    const serial = (row[encIdx] !== undefined && row[encIdx] !== null) ? String(row[encIdx]) : '';
    if (!raw) continue;
    if (!map[raw]) map[raw] = [];
    if (serial && !map[raw].includes(serial)) map[raw].push(serial);
  }
  // sort serials numerically for each raw
  for (const k in map) map[k] = map[k].sort((a,b)=>Number(a)-Number(b));
  log(`Raw->Serial mapping: ${JSON.stringify(map)}`);
}

// Must match your last working version
function detectFileTypeFromHeaders(headers) {
  const low = headers.map(h => (h || '').toString().trim().toLowerCase());
  const has = (token) => low.some(h => h.includes(token));

  // ClinicPro signature
  if (has('claimid') && has('claimdate')) return 'clinicpro';

  // InstaHMS signature
  if (has('pri. claim no') && has('encounter date')) return 'instahms';

  // Odoo signature (more strict)
  if (has('pri. claim id') && (has('adm/reg') || has('adm/reg. date') || has('adm reg'))) return 'odoo';

  return 'unknown';
}

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

async function combineReportings(fileEntries, clinicianFile) {
  log("Starting combineReportings function");
  if (!Array.isArray(fileEntries) || fileEntries.length === 0) {
    log("No input files provided", "ERROR");
    throw new Error("No input files provided");
  }

  const headersWithRaw = [...TARGET_HEADERS, 'Raw Encounter Date'];
  const combinedRows = [headersWithRaw];
  log("Initialized combinedRows with headers");

  const clinicianMapByLicense = new Map(), clinicianMapByName = new Map();
  let fallbackExcel = [];

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

  const allSerials = new Set();

  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    log(`Reading reporting file: ${name}`);
    let wb;
    try { wb = XLSX.read(buffer, { type: 'array', cellDates: true }); } 
    catch (err) { log(`Failed to read XLSX from buffer for file ${name}: ${err.message}`, 'ERROR'); continue; }
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (!sheetData || sheetData.length === 0) { log(`File ${name} skipped: no data`, 'WARN'); continue; }

    const { headerRowIndex, headers: headerRow } = findHeaderRowFromArrays(sheetData, 10);
    if (!headerRow || headerRow.length === 0) { log(`File ${name} skipped: header row not found.`, 'WARN'); continue; }

    const headerRowTrimmed = headerRow.map(h => (h || '').toString().trim());
    const normalizedHeaders = headerRowTrimmed.map(h => headerSignature(h));

    const isInsta = headerRowTrimmed.some(h => h.toLowerCase() === 'pri. claim no') &&
                    headerRowTrimmed.some(h => h.toLowerCase() === 'encounter date');
    const isOdoo = headerRowTrimmed.some(h => h.toLowerCase() === 'pri. claim id');
    const isClinicPro = headerRowTrimmed.some(h => h.toLowerCase() === 'claimid');

    let headerMap = null;
    if (isClinicPro) headerMap = CLINICPRO_V2_MAP;
    else if (isInsta) headerMap = INSTAHMS_MAP;
    else if (isOdoo) headerMap = ODOO_MAP;
    else { log(`File ${name} skipped: unrecognized header format.`, 'WARN'); continue; }

    const targetToNormalizedSource = {};
    for (const [src, tgt] of Object.entries(headerMap)) {
      const srcSig = headerSignature(src);
      targetToNormalizedSource[tgt] = normalizedHeaders.includes(srcSig) ? srcSig : null;
    }

    const encounterSig = targetToNormalizedSource['Encounter Date'];
    const encounterColIndex = encounterSig ? normalizedHeaders.indexOf(encounterSig) : -1;
    const seenClaimIDs = new Set();
    const startRow = headerRowIndex + 1;
    const totalRows = sheetData.length;

    // Determine file type for toExcelSerial
    let fileType = isOdoo ? 0 : isClinicPro ? 1 : 2; // 0 = Odoo, 1 = ClinicPro, 2 = Insta

    for (let r = startRow; r < totalRows; r++) {
      const row = sheetData[r]; 
      if (!Array.isArray(row) || row.length === 0) continue;

      try {
        const sourceRow = {};
        for (let c = 0; c < row.length; c++) {
          const key = normalizedHeaders[c] || `col${c}`;
          sourceRow[key] = row[c] ?? '';
        }

        const claimIDKey = targetToNormalizedSource['Pri. Claim No'];
        const claimID = claimIDKey ? String(sourceRow[claimIDKey] ?? '').trim() : '';
        if (!claimID || seenClaimIDs.has(claimID)) continue;
        seenClaimIDs.add(claimID);

        let facilityID = '';
        if (isInsta) facilityID = String(sourceRow[targetToNormalizedSource['Facility ID']] ?? '').trim();
        else facilityID = getFacilityIDFromFileName(name);

        const clinLicenseKey = targetToNormalizedSource['Clinician License'];
        const clinNameKey = targetToNormalizedSource['Clinician Name'];
        let clinLicense = clinLicenseKey ? String(sourceRow[clinLicenseKey] ?? '').trim() : '';
        let clinName = clinNameKey ? String(sourceRow[clinNameKey] ?? '').trim() : '';
        if (!clinName && sourceRow['orderdoctor']) clinName = String(sourceRow['orderdoctor']).trim();
        if (clinLicense && !clinName && clinicianMapByLicense.has(clinLicense))
          clinName = clinicianMapByLicense.get(clinLicense)['Clinician Name'];
        if (clinName && !clinLicense && clinicianMapByName.has(normalizeName(clinName)))
          clinLicense = clinicianMapByName.get(normalizeName(clinName))['Phy Lic'];
        if ((!clinName || !clinLicense) && clinName && facilityID) {
          const fb = fallbackClinicianLookupWithFacility(clinName, facilityID, fallbackExcel);
          if (fb) { clinLicense = fb.license || clinLicense; clinName = fb.name || clinName; }
        }
        if (!clinName && !clinLicense) continue;

        let rawEncounterVal = '';
        let normalizedEncounter = '';
        if (encounterColIndex >= 0) {
          const cellAddr = XLSX.utils.encode_cell({ r: r, c: encounterColIndex });
          const cell = ws[cellAddr];
          if (cell !== undefined) {
            rawEncounterVal = cell.v;
            normalizedEncounter = toExcelSerial(rawEncounterVal, fileType);
          } else {
            rawEncounterVal = sourceRow[encounterSig] ?? '';
            normalizedEncounter = toExcelSerial(rawEncounterVal, fileType);
          }
        }

        if (normalizedEncounter !== '' && normalizedEncounter !== null)
          allSerials.add(normalizedEncounter);

        const targetRow = [];
        for (let col = 0; col < headersWithRaw.length; col++) {
          const tgt = headersWithRaw[col];
          let val = '';
          if (tgt === 'Facility ID') val = facilityID || '';
          else if (tgt === 'Pri. Patient Insurance Card No')
            val = (sourceRow[targetToNormalizedSource[tgt]] ?? '') ||
                  (sourceRow[targetToNormalizedSource[tgt]?.toLowerCase()] ?? '');
          else if (tgt === 'Patient Code') val = sourceRow[targetToNormalizedSource[tgt]] ?? '';
          else if (tgt === 'Clinician License') val = clinLicense || '';
          else if (tgt === 'Clinician Name') val = clinName || '';
          else if (tgt === 'Opened by') val = isOdoo ? '' : (sourceRow[targetToNormalizedSource[tgt]] ?? sourceRow['updatedby'] ?? '');
          else if (tgt === 'Encounter Date') val = normalizedEncounter;
          else if (tgt === 'Raw Encounter Date') val = rawEncounterVal;
          else if (tgt === 'Source File') val = name;
          else val = sourceRow[targetToNormalizedSource[tgt]] ?? '';
          targetRow.push(val);
        }

        combinedRows.push(targetRow);

      } catch (err) {
        log(`Fatal row error in file ${name}, row ${r + 1}: ${err.message}`, 'ERROR');
      }
    }

    self.postMessage({ type: 'progress', progress: 50 + Math.floor(((i + 1) / fileEntries.length) * 50) });
  }

  const serialList = [...allSerials].map(s => Number(s)).filter(n => !isNaN(n)).sort((a, b) => a - b);
  log(`Unique Excel serials found: ${serialList.join(', ')}`);

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
