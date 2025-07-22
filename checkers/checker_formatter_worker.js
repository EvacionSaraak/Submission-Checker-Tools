importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

// Large constant arrays moved to top (as per your previous requests)
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

function normalizeName(name) {
  return (name || '').replace(/\s+/g, '').toLowerCase();
}

function fallbackClinicianLookup(rawName, fallbackExcel) {
  const normRaw = normalizeName(rawName);
  for (const row of fallbackExcel) {
    const normExcel = normalizeName(row.nm);
    if (normRaw === normExcel) {
      const inpWords = rawName.trim().split(/\s+/);
      const exWords = row.nm.trim().split(/\s+/);
      if (
        inpWords.length >= 2 && exWords.length >= 2 &&
        inpWords[0].toLowerCase() === exWords[0].toLowerCase() &&
        inpWords[inpWords.length - 1].toLowerCase() === exWords[exWords.length - 1].toLowerCase()
      ) {
        return { license: row.lic, name: row.nm };
      }
    }
  }
  return null;
}

function getFacilityIDFromFileName(filename) {
  const lowerName = filename.toLowerCase();
  for (const key of Object.keys(facilityNameMap)) {
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
  if (!date && typeof value === 'string') {
    const v = value.trim();
    const dmy = v.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dmy) date = new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}`);
    const ymd = !date && v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) date = new Date(v);
    const mdy = !date && v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (mdy) date = new Date(`${mdy[3]}-${mdy[1]}-${mdy[2]}`);
    if (!date && !isNaN(Date.parse(v))) date = new Date(v);
  }
  if (!date || isNaN(date)) return '';
  const base = new Date(Date.UTC(1899, 11, 30));
  return Math.floor((date - base) / (1000 * 60 * 60 * 24));
}

self.onmessage = async e => {
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

  try {
    const ws = XLSX.utils.aoa_to_sheet(uniqueRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Combined Eligibility');
    self.postMessage({ type: 'progress', progress: 100 });
    return wb;
  } catch (err) {
    log(`Error generating combined eligibility sheet: ${err.message}`, 'ERROR');
    throw err;
  }
}

async function combineReportings(fileEntries, clinicianFile) {
  log('Starting combineReportings function');

  const combinedRows = [TARGET_HEADERS];
  log('Initialized combinedRows with headers');

  const clinicianMapByLicense = new Map();
  const clinicianMapByName = new Map();
  let fallbackExcel = [];

  log('Fetching clinician_licenses.json');
  try {
    const resp = await fetch('./clinician_licenses.json');
    const clinicianData = await resp.json();
    log(`Loaded clinician licenses: ${clinicianData.length} entries`);

    clinicianData.forEach(entry => {
      const lic = entry['Clinician License']?.toString().trim();
      const nm = entry['Clinician Name']?.toString().trim();
      if (lic) clinicianMapByLicense.set(lic, entry);
      if (nm) clinicianMapByName.set(normalizeName(nm), entry);
    });
    log('Populated clinician maps');
  } catch (err) {
    log(`Failed to load clinician_licenses.json: ${err.message}`, 'ERROR');
  }

  if (clinicianFile) {
    log('Reading fallback clinician file');
    const wbClin = XLSX.read(clinicianFile.buffer, { type: 'array' });
    const wsClin = wbClin.Sheets[wbClin.SheetNames[0]];
    fallbackExcel = XLSX.utils.sheet_to_json(wsClin, { defval: '' }).map(r => ({
      lic: r['Clinician License']?.toString().trim(),
      nm: (r['Clinician Name'] || '').trim().replace(/\s+/g, ' '),
      facilityLicense: r['Facility License']?.toString().trim() || '',
      raw: r
    }));
  }

  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    log(`Reading reporting file: ${name}`);
    const matchedFacilityID = getFacilityIDFromFileName(name);
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });

    if (sheetData.length < 2) {
      log(`File ${name} skipped: less than 2 rows`, 'WARN');
      continue;
    }

    let headerRowIndex = -1;
    for (let r = 0; r < sheetData.length; r++) {
      const row = sheetData[r].map(h => h.toString().trim());
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

    const headerRow = sheetData[headerRowIndex].map(h => h.toString().trim());
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
      if (!row || row.length === 0) continue;

      try {
        const sourceRow = {};
        headerRow.forEach((h, idx) => sourceRow[h.toLowerCase().trim()] = row[idx] ?? '');

        const claimIDKey = targetToSource['Pri. Claim No'];
        const claimID = claimIDKey ? sourceRow[claimIDKey.toLowerCase()]?.toString().trim() : '';
        if (!claimID || seenClaimIDs.has(claimID)) continue;
        seenClaimIDs.add(claimID);

        const rawName = isClinicProV2
          ? sourceRow['orderdoctor']?.toString().trim() || sourceRow['clinician name']?.toString().trim()
          : sourceRow['clinician name']?.toString().trim() || '';
        let clinLicense = sourceRow['clinician license']?.toString().trim() || '';
        let clinName = '';

        const normRaw = normalizeName(rawName);
        if (clinicianMapByName.has(normRaw)) {
          const ent = clinicianMapByName.get(normRaw);
          clinLicense = ent['Clinician License'] || clinLicense;
          clinName = ent['Clinician Name'] || clinName;
        }

        if (!clinLicense || !clinName) {
          const fb = fallbackClinicianLookup(rawName, fallbackExcel);
          if (fb) {
            clinLicense = fb.license;
            clinName = fb.name;
          }
        }

        const targetRow = TARGET_HEADERS.map((tgt, colIndex) => {
          try {
            if (tgt === 'Facility ID') return sourceRow['facility id']?.toString().trim() || matchedFacilityID || '';
            if (tgt === 'Pri. Patient Insurance Card No') return sourceRow['patientcardid'] || sourceRow['member id'] || sourceRow[targetToSource[tgt]?.toLowerCase()] || '';
            if (tgt === 'Patient Code') return sourceRow['fileno'] || sourceRow[targetToSource[tgt]?.toLowerCase()] || '';
            if (tgt === 'Clinician License') return clinLicense;
            if (tgt === 'Clinician Name') return clinName;
            if (tgt === 'Opened by') return isClinicProV2 ? sourceRow['updated by'] || '' : sourceRow['opened by'] || sourceRow['opened by/registration staff name'] || '';
            if (tgt === 'Encounter Date') return convertToExcelDateUniversal(sourceRow[targetToSource[tgt]?.toLowerCase()]);
            if (tgt === 'Source File') return name;
            const key = targetToSource[tgt];
            return key ? sourceRow[key.toLowerCase()] || '' : '';
          } catch (cellErr) {
            log(`Cell error in file ${name}, row ${r + 1}, column ${colIndex} (${tgt}): ${cellErr.message}`, 'ERROR');
            return '';
          }
        });

        if (targetRow.length === TARGET_HEADERS.length) {
          combinedRows.push(targetRow);
        } else {
          log(`Malformed row in file ${name}, row ${r + 1}: expected ${TARGET_HEADERS.length} cols, got ${targetRow.length}`, 'WARN');
        }
      } catch (err) {
        log(`Fatal row error in file ${name}, row ${r + 1}: ${err.message}`, 'ERROR');
      }
    }

    self.postMessage({ type: 'progress', progress: 50 + Math.floor(((i + 1) / fileEntries.length) * 50) });
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
