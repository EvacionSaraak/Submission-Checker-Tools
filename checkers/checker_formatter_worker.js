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

const facilityNameMap = {
  "Ivory": "MF4456", "Korean": "MF5708", "Lauretta": "MF4706", "Laurette": "MF4184",
  "Majestic": "MF1901", "Nazek": "MF5009", "Extramall": "MF5090", "Khabisi": "MF5020",
  "Al Yahar": "MF5357", "Ccandcare": "MF456", "Talat": "MF494", "True Life": "MF7003",
  "Al Wagan": "MF7231", "WLDY": "MF5339"
};

// Logging utility
function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const msg = `[${level}] ${timestamp} - ${message}`;
  self.postMessage({ type: 'log', message: msg });
  console.log(msg);
}

// Normalize name by removing spaces and lowercasing
function normalizeName(name) {
  return (name || '').replace(/\s+/g, '').toLowerCase();
}

// Fallback clinician lookup with facility filter & first/last name check
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

function getFacilityIDFromFileName(filename) {
  if (!filename) return '';
  const lowerName = filename.toLowerCase();
  for (const key in facilityNameMap) {
    if (lowerName.includes(key.toLowerCase())) return facilityNameMap[key];
  }
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

    let wb;
    try {
      wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    } catch (err) {
      log(`Failed to read XLSX from buffer for file ${name}: ${err.message}`, 'ERROR');
      continue;
    }

    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });

    if (!Array.isArray(sheetData) || sheetData.length < 2) {
      log(`File ${name} skipped: no or insufficient data`, 'WARN');
      continue;
    }

    let headerRowIndex = -1;
    for (let r = 0; r < sheetData.length; r++) {
      if (!Array.isArray(sheetData[r])) continue;
      const row = sheetData[r].map(h => (h === undefined || h === null) ? '' : h.toString().trim());
      if ((row.includes('Pri. Claim No') && row.includes('Encounter Date')) ||
          (row.includes('ClaimID') && row.includes('ClaimDate'))) {
        headerRowIndex = r;
        break;
      }
    }

    if (headerRowIndex === -1) {
      log(`File ${name} skipped: header row not found.`, 'WARN');
      continue;
    }

    const headerRowRaw = sheetData[headerRowIndex];
    if (!Array.isArray(headerRowRaw)) {
      log(`File ${name} skipped: header row is invalid`, 'WARN');
      continue;
    }
    const headerRow = headerRowRaw.map(h => (h === undefined || h === null) ? '' : h.toString().trim());
    const isClinicProV2 = headerRow.includes('InvoiceNo');

    const headerMap = (headerRow.includes('ClaimID') && headerRow.includes('ClaimDate'))
      ? (isClinicProV2 ? CLINICPRO_V2_MAP : CLINICPRO_V1_MAP)
      : ((headerRow.includes('Pri. Claim No') && headerRow.includes('Encounter Date')) ? INSTAHMS_MAP : null);

    if (!headerMap) {
      log(`File ${name} skipped: unrecognized header format.`, 'WARN');
      continue;
    }

    const targetToSource = {};
    for (const [src, tgt] of Object.entries(headerMap)) {
      if (headerRow.includes(src)) targetToSource[tgt] = src;
    }

    const seenClaimIDs = new Set();

    for (let r = headerRowIndex + 1; r < sheetData.length; r++) {
      const row = sheetData[r];
      if (!Array.isArray(row) || row.length === 0) continue;

      try {
        const sourceRow = {};
        headerRow.forEach((h, idx) => {
          sourceRow[h.toLowerCase().trim()] = (row[idx] === undefined || row[idx] === null) ? '' : row[idx];
        });

        const claimIDKey = targetToSource['Pri. Claim No'];
        const claimID = claimIDKey ? sourceRow[claimIDKey.toLowerCase()]?.toString().trim() : '';
        if (!claimID || seenClaimIDs.has(claimID)) continue;
        seenClaimIDs.add(claimID);

        const rawName = isClinicProV2
          ? (sourceRow['orderdoctor']?.toString().trim() || sourceRow['clinician name']?.toString().trim() || '')
          : (sourceRow['clinician name']?.toString().trim() || '');
        let clinLicense = sourceRow['clinician license']?.toString().trim() || '';
        let clinName = '';

        const facilityLicense = sourceRow['facility id']?.toString().trim() || matchedFacilityID || '';

        const normRaw = normalizeName(rawName);
        if (clinicianMapByName.has(normRaw)) {
          const ent = clinicianMapByName.get(normRaw);
          clinLicense = ent['Phy Lic'];
          clinName = ent['Clinician Name'];
        }

        if ((!clinLicense || !clinName) && rawName && facilityLicense) {
          const fb = fallbackClinicianLookupWithFacility(rawName, facilityLicense, fallbackExcel);
          if (fb) {
            clinLicense = fb.license;
            clinName = fb.name;
          }
        }

        const targetRow = TARGET_HEADERS.map((tgt) => {
          if (tgt === 'Facility ID') return facilityLicense || '';
          if (tgt === 'Pri. Patient Insurance Card No')
            return sourceRow['patientcardid'] || sourceRow['member id'] || sourceRow[targetToSource[tgt]?.toLowerCase()] || '';
          if (tgt === 'Patient Code') return sourceRow['fileno'] || sourceRow[targetToSource[tgt]?.toLowerCase()] || '';
          if (tgt === 'Clinician License') return clinLicense;
          if (tgt === 'Clinician Name') return clinName;
          if (tgt === 'Opened by')
            return isClinicProV2
              ? sourceRow['updated by'] || ''
              : sourceRow['opened by'] || sourceRow['opened by/registration staff name'] || '';
          if (tgt === 'Encounter Date') return convertToExcelDateUniversal(sourceRow[targetToSource[tgt]?.toLowerCase()]);
          if (tgt === 'Source File') return name;
          const key = targetToSource[tgt];
          return key ? sourceRow[key.toLowerCase()] || '' : '';
        });

        combinedRows.push(targetRow);
      } catch (err) {
        log(`Error processing row ${r + 1} in file ${name}: ${err.message}`, 'ERROR');
      }
    }

    self.postMessage({ type: 'progress', progress: 50 + Math.floor(((i + 1) / fileEntries.length) * 50) });
  }

  // Final validation before output
  combinedRows.forEach((row, idx) => {
    if (!Array.isArray(row)) {
      throw new Error(`Row ${idx} is not an array`);
    }
    if (row.length !== TARGET_HEADERS.length) {
      throw new Error(`Row ${idx} length mismatch: expected ${TARGET_HEADERS.length}, got ${row.length}`);
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(combinedRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Combined Reporting');
  self.postMessage({ type: 'progress', progress: 100 });
  return wb;
}
