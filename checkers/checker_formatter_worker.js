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
  "Al Yahar": "MF5357", "Ccandcare": "MF456", "Talat": "MF494", "True Life": "MF7003",
  "Al Wagan": "MF7231", "WLDY": "MF5339"
};

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const msg = `[${level}] ${timestamp} - ${message}`;
  self.postMessage({ type: 'log', message: msg });
  // console.log(msg); // Uncomment for browser debugging
}

function normalizeName(name) {
  return (name || '').replace(/\s+/g, '').toLowerCase();
}

// Finds the best header row within the first `maxScan` rows of `sheetRows` (array-of-arrays).
// Returns an object: { headerRowIndex, headers (normalized array), rows (array-of-arrays after header) }.
// Find the best matching header from detected headerRow for a given source header name.
// Normalizes both sides (lowercase, trim, remove punctuation) for robust matching.
function findHeaderMatch(headerRow, srcHeader) {
  if (!Array.isArray(headerRow) || !srcHeader) return null;
  const normalize = s => String(s || '').toLowerCase().trim().replace(/[\.\-\/,_\s]+/g, ' ');
  const targetNorm = normalize(srcHeader);
  // First try exact normalized equality
  for (const h of headerRow) { if (normalize(h) === targetNorm) return h; }
  // Next try containment both ways (header contains src or src contains header)
  for (const h of headerRow) {
    const hn = normalize(h);
    if (hn.includes(targetNorm) || targetNorm.includes(hn)) return h;
  }
  // As a last resort, try tokenized prefix match (useful for variants like "Pri Claim ID" vs "Pri. Claim ID")
  const targetTokens = targetNorm.split(' ').filter(Boolean);
  for (const h of headerRow) {
    const hn = normalize(h);
    const hTokens = hn.split(' ').filter(Boolean);
    // require at least two shared tokens to reduce false positives
    const shared = targetTokens.filter(t => hTokens.includes(t));
    if (shared.length >= Math.min(2, targetTokens.length)) return h;
  }
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

async function combineEligibilities(fileEntries) {
  const combined = [];
  let headerRow = null;
  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    log(`Reading eligibility file: ${name}`);
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (sheetData.length < 2) {
      log(`File ${name} has less than 2 rows. Skipping.`, 'WARN');
      continue;
    }
    const currentHeader = sheetData[1];
    if (!headerRow) {
      headerRow = currentHeader;
      combined.push(headerRow);
      log(`Header row captured from file: ${name}`);
    }
    for (let r = 2; r < sheetData.length; r++) {
      const row = sheetData[r];
      if (row && row.length) combined.push(row);
    }
    self.postMessage({
      type: 'progress',
      progress: Math.floor(((i + 1) / fileEntries.length) * 50)
    });
  }
  const seen = new Set();
  const uniqueRows = combined.filter(row => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  log(`Deduplicated eligibility rows: ${uniqueRows.length}`);
  const ws = XLSX.utils.aoa_to_sheet(uniqueRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Combined Eligibility');
  self.postMessage({ type: 'progress', progress: 100 });
  return wb;
}

// Modified combineReportings() — replaces the previous implementation.
// Uses findHeaderRowFromArrays + mapping tables and supports Odoo header detection (headers may be on row 2).
// Modified combineReportings() using ODOO_MAP and tolerant header matching
async function combineReportings(fileEntries, clinicianFile) {
  log("Starting combineReportings function");

  if (!Array.isArray(fileEntries) || fileEntries.length === 0) {
    log("No input files provided", "ERROR");
    throw new Error("No input files provided");
  }

  const combinedRows = [TARGET_HEADERS];
  log("Initialized combinedRows with headers");

  const clinicianMapByLicense = new Map();
  const clinicianMapByName = new Map();
  let fallbackExcel = [];

  // load clinician_licenses.json
  try {
    log("Fetching clinician_licenses.json");
    const resp = await fetch('./clinician_licenses.json');
    const clinicianData = await resp.json();
    if (!Array.isArray(clinicianData)) {
      log("Clinician data is not an array", "ERROR");
      throw new Error("Clinician data is not an array");
    }
    log(`Loaded clinician licenses: ${clinicianData.length} entries`);
    clinicianData.forEach(entry => {
      const lic = entry['Phy Lic']?.toString().trim();
      const nm = entry['Clinician Name']?.toString().trim();
      if (lic) clinicianMapByLicense.set(lic, entry);
      if (nm) clinicianMapByName.set(normalizeName(nm), entry);
    });
    log("Populated clinician maps");
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

  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    log(`Reading reporting file: ${name}`);

    const matchedFacilityID = getFacilityIDFromFileName(name);
    const isKhabisiOrYahar = matchedFacilityID === 'MF5020' || matchedFacilityID === 'MF5357';

    let wb;
    try {
      wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    } catch (err) {
      log(`Failed to read XLSX from buffer for file ${name}: ${err.message}`, 'ERROR');
      continue;
    }

    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (!Array.isArray(sheetData) || sheetData.length === 0) {
      log(`File ${name} skipped: no data`, 'WARN');
      continue;
    }

    // Use universal header row finder
    const { headerRowIndex, headers: headerRow, rows: rowsAfter } = findHeaderRowFromArrays(sheetData, 10);
    if (headerRowIndex === -1 || !Array.isArray(headerRow) || headerRow.length === 0) {
      log(`File ${name} skipped: header row not found.`, 'WARN');
      continue;
    }

    // normalize headerRow values (trimmed)
    const headerRowTrimmed = headerRow.map(h => (h === undefined || h === null) ? '' : String(h).trim());

    // Determine file type: ClinicPro v1/v2, InstaHMS, or Odoo
    const hdrLower = headerRowTrimmed.map(h => (h || '').toString().trim().toLowerCase());
    const hasClaimID = hdrLower.some(h => h === 'claimid' || h === 'claim id');
    const hasClaimDate = hdrLower.some(h => h === 'claimdate' || h === 'claim date');
    const hasPriClaimNo = hdrLower.some(h => h === 'pri. claim no' || h === 'pri claim no' || h === 'pri. claim no');
    const hasEncounterDate = hdrLower.some(h => h === 'encounter date' || h === 'encounterdate');
    const hasCenterName = hdrLower.some(h => h === 'center name');
    const hasPriClaimId = hdrLower.some(h => h === 'pri. claim id' || h === 'pri claim id' || h === 'pri. claim id');

    const isOdoo = hasCenterName && hasPriClaimId;
    const isInsta = hasPriClaimNo && hasEncounterDate;
    const isClinicPro = hasClaimID && hasClaimDate;

    if (isOdoo) log(`Odoo file detected: ${name}`, 'INFO');

    // Build header map selection
    let headerMap = null;
    if (isClinicPro) {
      const hasMemberId = hdrLower.some(h => h === 'member id');
      const isClinicProV2 = hasMemberId || isKhabisiOrYahar;
      headerMap = isClinicProV2 ? CLINICPRO_V2_MAP : CLINICPRO_V1_MAP;
    } else if (isInsta) {
      headerMap = INSTAHMS_MAP;
    } else if (isOdoo) {
      headerMap = ODOO_MAP;
    }

    if (!headerMap) {
      log(`File ${name} skipped: unrecognized header format.`, 'WARN');
      continue;
    }

    // Build mapping target -> actual source header (using tolerant findHeaderMatch)
    const targetToSource = {};
    for (const [src, tgt] of Object.entries(headerMap)) {
      const matched = findHeaderMatch(headerRowTrimmed, src);
      if (matched) targetToSource[tgt] = matched;
    }

    const seenClaimIDs = new Set();
    const startRow = headerRowIndex + 1;
    const totalRows = sheetData.length;

    for (let r = startRow; r < totalRows; r++) {
      const row = sheetData[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      try {
        // Build sourceRow keyed by normalized lowercased header keys
        const sourceRow = {};
        headerRowTrimmed.forEach((h, idx) => {
          const key = (h || '').toString().trim().toLowerCase();
          sourceRow[key] = (row[idx] === undefined || row[idx] === null) ? '' : row[idx];
        });

        // Claim ID dedupe
        const claimIDKey = (targetToSource['Pri. Claim No'] || '').toString().toLowerCase();
        const claimID = claimIDKey ? (sourceRow[claimIDKey] || '').toString().trim() : '';
        if (!claimID || seenClaimIDs.has(claimID)) continue;
        seenClaimIDs.add(claimID);

        // Facility License resolution
        let facilityLicense = (sourceRow['facility id'] || '').toString().trim() || '';
        if (!facilityLicense && sourceRow['center name']) {
          facilityLicense = getFacilityIDFromCenterName(sourceRow['center name']);
        }
        if (!facilityLicense) facilityLicense = matchedFacilityID || '';

        // Clinician keys (using mapped source header names)
        const clinLicenseKey = (targetToSource['Clinician License'] || 'Clinician License').toString().toLowerCase();
        const clinNameKey = (targetToSource['Clinician Name'] || 'Clinician Name').toString().toLowerCase();

        let clinLicense = (sourceRow[clinLicenseKey] || '').toString().trim();
        let clinName = (sourceRow[clinNameKey] || '').toString().trim();

        // ClinicPro V2 special: OrderDoctor fallback
        if (!clinName && sourceRow['orderdoctor']) clinName = sourceRow['orderdoctor'].toString().trim();

        // Fallbacks from clinician maps
        if (clinLicense && !clinName && clinicianMapByLicense.has(clinLicense)) {
          clinName = clinicianMapByLicense.get(clinLicense)['Clinician Name'];
          log(`Filled name from license: ${clinLicense} => ${clinName}`);
        }
        if (clinName && !clinLicense && clinicianMapByName.has(normalizeName(clinName))) {
          clinLicense = clinicianMapByName.get(normalizeName(clinName))['Phy Lic'];
          log(`Filled license from name: ${clinName} => ${clinLicense}`);
        }

        // Additional fallback using fallbackExcel
        if ((!clinName || !clinLicense) && clinName && facilityLicense) {
          const fb = fallbackClinicianLookupWithFacility(clinName, facilityLicense, fallbackExcel);
          if (fb) {
            clinLicense = fb.license || clinLicense;
            clinName = fb.name || clinName;
            log(`Fallback matched: ${clinName} (${clinLicense})`);
          }
        }

        if (!clinName && !clinLicense) {
          log(`[SKIP] Both Clinician fields missing: File ${name} Row ${r + 1} claimID:${claimID}`, "WARN");
          continue;
        }

        // Collect blank-fields rows
        const missingFields = [];
        if (!clinName) missingFields.push('Clinician Name');
        if (!clinLicense) missingFields.push('Clinician License');
        if (missingFields.length > 0) {
          blankFieldsRows.push({
            claimID,
            missingFields,
            file: name,
            row: r + 1,
            rawClinicianName: clinName,
            facilityLicense,
          });
        }

        // Build targetRow
        const targetRow = TARGET_HEADERS.map((tgt) => {
          try {
            if (tgt === 'Facility ID') return facilityLicense || '';
            if (tgt === 'Pri. Patient Insurance Card No') {
              return (sourceRow['patientcardid'] || sourceRow['member id'] || sourceRow[(targetToSource[tgt] || '').toLowerCase()]) || '';
            }
            if (tgt === 'Patient Code') {
              return (sourceRow['fileno'] || sourceRow[(targetToSource[tgt] || '').toLowerCase()]) || '';
            }
            if (tgt === 'Clinician License') return clinLicense || '';
            if (tgt === 'Clinician Name') return clinName || '';
            if (tgt === 'Opened by') {
              if (isOdoo) return '';
              const mapped = (targetToSource[tgt] || '').toLowerCase();
              return mapped ? (sourceRow[mapped] || '') : (sourceRow['opened by'] || sourceRow['opened by/registration staff name'] || sourceRow['updated by'] || '');
            }
            if (tgt === 'Encounter Date') {
              const src = (targetToSource[tgt] || '').toLowerCase();
              return convertToExcelDateUniversal(sourceRow[src]);
            }
            if (tgt === 'Source File') return name;
            const key = targetToSource[tgt];
            return key ? (sourceRow[key.toLowerCase()] || '') : '';
          } catch (cellErr) {
            log(`Cell error in file ${name}, row ${r + 1}, column ${tgt}: ${cellErr.message}`, 'ERROR');
            return '';
          }
        });

        if (!Array.isArray(targetRow)) {
          log(`targetRow is not an array in file ${name}, row ${r + 1}`, 'ERROR');
          continue;
        }
        if (targetRow.length !== TARGET_HEADERS.length) {
          log(`Malformed row length in file ${name}, row ${r + 1}: expected ${TARGET_HEADERS.length}, got ${targetRow.length}`, 'ERROR');
          continue;
        }

        combinedRows.push(targetRow);
      } catch (err) {
        log(`Fatal row error in file ${name}, row ${r + 1}: ${err.message}`, 'ERROR');
      }
    } // end rows loop

    self.postMessage({ type: 'progress', progress: 50 + Math.floor(((i + 1) / fileEntries.length) * 50) });
  } // end files loop

  // Log blank clinician rows summary
  if (blankFieldsRows.length > 0) {
    log(`Rows with missing clinician fields (Name or License):`);
    // console.log(blankFieldsRows);
  }

  // Final validations
  for (const [idx, row] of combinedRows.entries()) {
    if (!Array.isArray(row)) {
      log(`Row ${idx} is not an array: ${JSON.stringify(row)}`, 'ERROR');
      throw new Error(`Invalid row at index ${idx}: not an array`);
    }
    if (row.length !== TARGET_HEADERS.length) {
      log(`Row ${idx} length ${row.length} does not match headers length ${TARGET_HEADERS.length}: ${JSON.stringify(row)}`, 'ERROR');
      throw new Error(`Invalid row length at index ${idx}`);
    }
  }

  try {
    const ws = XLSX.utils.aoa_to_sheet(combinedRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Combined Reporting');
    self.postMessage({ type: 'progress', progress: 100 });
    return wb;
  } catch (sheetErr) {
    log(`Error converting to worksheet: ${sheetErr.message}`, 'ERROR');
    throw sheetErr;
  }
}

