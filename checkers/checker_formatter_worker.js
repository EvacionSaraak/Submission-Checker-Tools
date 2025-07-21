importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

// Logging utility
function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const msg = `[${level}] ${timestamp} - ${message}`;
  self.postMessage({ type: 'log', message: msg });
  console.log(msg);
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

async function combineReportings(fileEntries, clinicianFile) {
  const TARGET_HEADERS = [
    'Pri. Claim No', 'Clinician License', 'Encounter Date', 'Pri. Patient Insurance Card No',
    'Department', 'Visit Id', 'Pri. Plan Type', 'Facility ID',
    'Patient Code', 'Clinician Name', 'Opened by', 'Source File'
  ];

  const facilityNameMap = {
    "Ivory": "MF4456", "Korean": "MF5708", "Lauretta": "MF4706", "Laurette": "MF4184",
    "Majestic": "MF1901", "Nazek": "MF5009", "Extramall": "MF5090", "Khabisi": "MF5020",
    "Al Yahar": "MF5357", "Ccandcare": "MF456", "Talat": "MF494", "True Life": "MF7003",
    "Al Wagan": "MF7231", "WLDY": "MF5339"
  };

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

  function normalizeName(name) {
    return (name || '').replace(/\s+/g, '').toLowerCase();
  }

  const clinicianMapByLicense = new Map();
  const clinicianMapByName = new Map();
  try {
    const resp = await fetch('./clinician_licenses.json');
    const clinicianData = await resp.json();
    clinicianData.forEach(entry => {
      const lic = entry['Phy Lic']?.toString().trim();
      const nm = entry['Clinician Name']?.toString().trim();
      if (lic) clinicianMapByLicense.set(lic, entry);
      if (nm) clinicianMapByName.set(normalizeName(nm), entry);
    });
  } catch (err) {
    log(`Failed to load clinician_licenses.json: ${err.message}`, 'ERROR');
  }

  let fallbackExcel = [];
  if (clinicianFile) {
    const wbClin = XLSX.read(clinicianFile, { type: 'array' });
    const wsClin = wbClin.Sheets[wbClin.SheetNames[0]];
    fallbackExcel = XLSX.utils.sheet_to_json(wsClin, { defval: '' }).map(r => ({
      lic: r['Phy Lic']?.toString().trim(),
      nm: (r['Clinician Name'] || '').trim().replace(/\s+/g, ' '),
      raw: r
    }));
  }

  function fallbackClinicianLookup(rawName) {
    const normRaw = normalizeName(rawName);
    for (const row of fallbackExcel) {
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

  const combinedRows = [TARGET_HEADERS];

  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    const matchedFacilityID = getFacilityIDFromFileName(name);
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (sheetData.length < 2) continue;

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
    const headerMap = headerRow.includes('ClaimID') && headerRow.includes('ClaimDate')
      ? (headerRow.includes('InvoiceNo') ? CLINICPRO_V2_MAP : CLINICPRO_V1_MAP)
      : (headerRow.includes('Pri. Claim No') ? INSTAHMS_MAP : null);
    if (!headerMap) {
      log(`File ${name} skipped: unrecognized header format.`, 'WARN');
      continue;
    }

    const targetToSource = {};
    for (const [src, tgt] of Object.entries(headerMap)) {
      if (headerRow.includes(src)) targetToSource[tgt] = src;
    }

    let facilityID = '';
    for (let r = headerRowIndex + 1; r < Math.min(sheetData.length, headerRowIndex + 20); r++) {
      const row = sheetData[r]; if (!row) continue;
      const visitVal = headerMap === CLINICPRO_V1_MAP
        ? row[headerRow.indexOf('Visit Id')] || ''
        : (headerMap === CLINICPRO_V2_MAP
          ? row[headerRow.indexOf('InvoiceNo')] || ''
          : row[headerRow.indexOf('Facility ID')] || '');
      const match = visitVal.toString().match(/(MF\d{4,})/i);
      if (match) { facilityID = match[1]; break; }
    }

    const seenClaimIDs = new Set();

    for (let r = headerRowIndex + 1; r < sheetData.length; r++) {
      const row = sheetData[r]; if (!row || row.length === 0) continue;

      const sourceRow = {};
      headerRow.forEach((h, idx) => sourceRow[h.toLowerCase()] = row[idx] ?? '');

      const claimIDKey = targetToSource['Pri. Claim No'];
      const claimID = claimIDKey ? sourceRow[claimIDKey.toLowerCase()]?.toString().trim() : '';
      if (!claimID || seenClaimIDs.has(claimID)) continue;
      seenClaimIDs.add(claimID);

      const rawName = (headerMap === CLINICPRO_V2_MAP)
        ? sourceRow['orderdoctor']?.toString().trim() || sourceRow['clinician name']?.toString().trim()
        : sourceRow['clinician name']?.toString().trim() || '';
      let clinLicense = sourceRow['clinician license']?.toString().trim() || '';
      let clinName = '';

      const normRaw = normalizeName(rawName);
      if (clinicianMapByName.has(normRaw)) {
        const ent = clinicianMapByName.get(normRaw);
        clinLicense = ent['Phy Lic'];
        clinName = ent['Clinician Name'];
      }
      if (!clinLicense || !clinName) {
        const fb = fallbackClinicianLookup(rawName);
        if (fb) { clinLicense = fb.license; clinName = fb.name; }
      }

      try {
        const targetRow = TARGET_HEADERS.map((tgt, colIndex) => {
          try {
            if (tgt === 'Facility ID') {
              const curr = sourceRow['facility id']?.toString().trim();
              return curr || matchedFacilityID || facilityID || '';
            }
            if (tgt === 'Pri. Patient Insurance Card No') {
              return sourceRow['patientcardid'] || sourceRow['member id'] || sourceRow[targetToSource[tgt]?.toLowerCase()] || '';
            }
            if (tgt === 'Patient Code') {
              return sourceRow['fileno'] || sourceRow[targetToSource[tgt]?.toLowerCase()] || '';
            }
            if (tgt === 'Clinician License') return clinLicense;
            if (tgt === 'Clinician Name') return clinName;
            if (tgt === 'Opened by') {
              return (headerMap === CLINICPRO_V2_MAP)
                ? sourceRow['updated by'] || ''
                : sourceRow['opened by'] || sourceRow['opened by/registration staff name'] || '';
            }
            if (tgt === 'Encounter Date') {
              const rawDate = sourceRow[targetToSource[tgt]?.toLowerCase()];
              return convertToExcelDateUniversal(rawDate);
            }
            if (tgt === 'Source File') return name;

            const key = targetToSource[tgt];
            return key ? sourceRow[key.toLowerCase()] || '' : '';
          } catch (cellErr) {
            log(`Cell error in ${name} | row ${r + 1} | column ${colIndex + 1} (${tgt}): ${cellErr.message}`, 'ERROR');
            return '';
          }
        });

        if (targetRow.length !== TARGET_HEADERS.length) {
          log(`Skipping malformed row in ${name}, row ${r + 1}`, 'WARN');
        } else {
          combinedRows.push(targetRow);
        }
      } catch (rowErr) {
        log(`Fatal row error in ${name}, row ${r + 1}: ${rowErr.message}`, 'ERROR');
      }
    }

    self.postMessage({ type: 'progress', progress: 50 + Math.floor(((i + 1) / fileEntries.length) * 50) });
  }

  const ws = XLSX.utils.aoa_to_sheet(combinedRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Combined Reporting');
  self.postMessage({ type: 'progress', progress: 100 });
  return wb;
}
