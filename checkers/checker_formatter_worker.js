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

    self.postMessage({ type: 'progress', progress: Math.floor(((i + 1) / fileEntries.length) * 50) });
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
  const TARGET_HEADERS = [
    'Pri. Claim No', 'Clinician License', 'Encounter Date', 'Pri. Patient Insurance Card No',
    'Department', 'Visit Id', 'Pri. Plan Type', 'Facility ID',
    'Patient Code', 'Clinician Name', 'Opened by', 'Source File'
  ];

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

  const clinicianMapByLicense = new Map(), clinicianMapByName = new Map();
  if (clinicianFile) {
    const wbClinician = XLSX.read(clinicianFile.buffer, { type: 'array', cellDates: true });
    const wsClinician = wbClinician.Sheets[wbClinician.SheetNames[0]];
    const dataClinician = XLSX.utils.sheet_to_json(wsClinician, { defval: '', raw: false });
    dataClinician.forEach(row => {
      const license = row['Clinician License']?.toString().trim();
      const name = row['Clinician Name']?.toString().trim();
      if (license) clinicianMapByLicense.set(license, row);
      if (name) clinicianMapByName.set(name, row);
    });
  }

  const CLINICPRO_V1_MAP = {
    'ClaimID': 'Pri. Claim No', 'Clinician License': 'Clinician License', 'ClaimDate': 'Encounter Date',
    'Insurance Company': 'Pri. Plan Type', 'PatientCardID': 'Pri. Patient Insurance Card No',
    'Clinic': 'Department', 'Visit Id': 'Visit Id', 'Clinician Name': 'Clinician Name',
    'Opened by/Registration Staff name': 'Opened by', 'Opened by': 'Opened by', 'FileNo': 'Patient Code'
  };

  const CLINICPRO_V2_MAP = {
    'ClaimID': 'Pri. Claim No', 'Clinician License': 'Clinician License', 'ClaimDate': 'Encounter Date',
    'Insurance Company': 'Pri. Plan Type', 'Member ID': 'Pri. Patient Insurance Card No',
    'Clinic': 'Department', 'Visit Id': 'Visit Id', 'Clinician Name': 'Clinician Name',
    'OrderDoctor': 'Clinician Name', 'Updated By': 'Opened by',
    'Opened by/Registration Staff name': 'Opened by', 'Opened by': 'Opened by',
    'FileNo': 'Patient Code'
  };

  const INSTAHMS_MAP = {
    'Pri. Claim No': 'Pri. Claim No', 'Clinician License': 'Clinician License',
    'Encounter Date': 'Encounter Date', 'Pri. Patient Insurance Card No': 'Pri. Patient Insurance Card No',
    'Department': 'Department', 'Visit Id': 'Visit Id', 'Pri. Plan Type': 'Pri. Plan Type',
    'Facility ID': 'Facility ID', 'Patient Code': 'Patient Code', 'Clinician Name': 'Clinician Name',
    'Opened by': 'Opened by'
  };

  const combinedRows = [TARGET_HEADERS];

  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (sheetData.length < 2) continue;

    let headerRowIndex = -1;
    for (let r = 0; r < sheetData.length; r++) {
      const row = sheetData[r].map(h => h.toString().trim());
      if ((row.includes('Pri. Claim No') && row.includes('Encounter Date')) || (row.includes('ClaimID') && row.includes('ClaimDate'))) {
        headerRowIndex = r;
        break;
      }
    }

    if (headerRowIndex === -1) {
      log(`File ${name} skipped: header row not found.`, 'WARN');
      continue;
    }

    const headerRow = sheetData[headerRowIndex].map(h => h.toString().trim());
    let headerMap = null;
    headerMap = (headerRow.includes('ClaimID') && headerRow.includes('ClaimDate'))
      ? (headerRow.includes('InvoiceNo') ? CLINICPRO_V2_MAP : CLINICPRO_V1_MAP)
      : (headerRow.includes('Pri. Claim No') && headerRow.includes('Encounter Date') ? INSTAHMS_MAP : null);

    if (!headerMap) {
      log(`File ${name} skipped: unrecognized header format.`, 'WARN');
      continue;
    }

    const targetToSource = {};
    for (const [src, tgt] of Object.entries(headerMap))
      if (headerRow.includes(src)) targetToSource[tgt] = src;

    let facilityID = '';
    for (let r = headerRowIndex + 1; r < Math.min(sheetData.length, headerRowIndex + 20); r++) {
      const row = sheetData[r];
      if (!row) continue;
      let visitVal = headerMap === CLINICPRO_V1_MAP
        ? row[headerRow.indexOf('Visit Id')] || ''
        : headerMap === CLINICPRO_V2_MAP
          ? row[headerRow.indexOf('InvoiceNo')] || ''
          : row[headerRow.indexOf('Facility ID')] || '';
      const match = visitVal.toString().match(/(MF\d{4,})/i);
      if (match) {
        facilityID = match[1];
        break;
      }
    }

    const seenClaimIDs = new Set();

    for (let r = headerRowIndex + 1; r < sheetData.length; r++) {
      const row = sheetData[r];
      if (!row || row.length === 0) continue;

      const sourceRow = {};
      headerRow.forEach((h, idx) => sourceRow[h] = row[idx] ?? '');

      const claimIDKey = targetToSource['Pri. Claim No'];
      const claimID = claimIDKey ? sourceRow[claimIDKey]?.toString().trim() : '';
      if (!claimID || seenClaimIDs.has(claimID)) continue;
      seenClaimIDs.add(claimID);

      let clinLicense = sourceRow['Clinician License']?.toString().trim() || '';
      let clinName = headerMap === CLINICPRO_V2_MAP
        ? sourceRow['OrderDoctor']?.toString().trim() || sourceRow['Clinician Name']?.toString().trim() || ''
        : sourceRow['Clinician Name']?.toString().trim() || '';

      if ((!clinLicense || !clinName) && clinicianFile) {
        if (!clinLicense && clinName && clinicianMapByName.has(clinName))
          clinLicense = clinicianMapByName.get(clinName)['Clinician License'] || '';
        if (!clinName && clinLicense && clinicianMapByLicense.has(clinLicense))
          clinName = clinicianMapByLicense.get(clinLicense)['Clinician Name'] || '';
      }

      const targetRow = TARGET_HEADERS.map(tgt => {
        if (tgt === 'Facility ID') return sourceRow['Facility ID'] || facilityID;
        if (tgt === 'Pri. Patient Insurance Card No') return sourceRow['PatientCardID'] || sourceRow['Member ID'] || sourceRow[targetToSource[tgt]] || '';
        if (tgt === 'Patient Code') return sourceRow['FileNo'] || sourceRow[targetToSource[tgt]] || '';
        if (tgt === 'Clinician License') return clinLicense;
        if (tgt === 'Clinician Name') return clinName;
        if (tgt === 'Opened by') return headerMap === CLINICPRO_V2_MAP
          ? sourceRow['Updated By'] || ''
          : sourceRow['Opened by'] || sourceRow['Opened by/Registration Staff name'] || '';
        if (tgt === 'Encounter Date') return convertToExcelDateUniversal(sourceRow[targetToSource[tgt]]);
        if (tgt === 'Source File') return name;
        const srcKey = targetToSource[tgt];
        return srcKey ? sourceRow[srcKey] || '' : '';
      });

      combinedRows.push(targetRow);
    }

    self.postMessage({ type: 'progress', progress: 50 + Math.floor(((i + 1) / fileEntries.length) * 50) });
  }

  const ws = XLSX.utils.aoa_to_sheet(combinedRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Combined Reporting');
  self.postMessage({ type: 'progress', progress: 100 });
  return wb;
}
