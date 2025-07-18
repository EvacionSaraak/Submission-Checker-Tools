importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

// Logging function
function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const msg = `[${level}] ${timestamp} - ${message}`;
  self.postMessage({ type: 'log', message: msg });
  console.log(msg);
}

self.onmessage = async e => {
  if (e.data.type !== 'start') return;
  const { mode, files } = e.data;

  try {
    log(`Processing started in mode: ${mode}, ${files.length} file(s)`);
    const combineFn = mode === 'eligibility' ? combineEligibilities : combineReportings;
    const wb = await combineFn(files);
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

async function combineReportings(fileEntries) {
  const TARGET_HEADERS = [
    'Pri. Claim No', 'Clinician License', 'Encounter Date', 'Pri. Patient Insurance Card No',
    'Department', 'Visit Id', 'Pri. Plan Type', 'Facility ID',
    'Patient Code', 'Clinician Name', 'Opened by', 'Source File'
  ];

  const CLINICPRO_V1_MAP = {
    'ClaimID': 'Pri. Claim No',
    'Clinician License': 'Clinician License',
    'ClaimDate': 'Encounter Date',
    'Insurance Company': 'Pri. Plan Type',
    'PatientCardID': 'Pri. Patient Insurance Card No',
    'Clinic': 'Department',
    'Visit Id': 'Visit Id',
    'Clinician Name': 'Clinician Name',
    'Opened by/Registration Staff name': 'Opened by',
    'Opened by': 'Opened by',
    'FileNo': 'Patient Code'
  };

  const CLINICPRO_V2_MAP = {
    'ClaimID': 'Pri. Claim No',
    'Clinician License': 'Clinician License',
    'ClaimDate': 'Encounter Date',
    'Insurance Company': 'Pri. Plan Type',
    'Member ID': 'Pri. Patient Insurance Card No',
    'Clinic': 'Department',
    'Visit Id': 'Visit Id',
    'Clinician Name': 'Clinician Name',
    'Opened by/Registration Staff name': 'Opened by',
    'Opened by': 'Opened by',
    'FileNo': 'Patient Code'
  };

  const INSTAHMS_MAP = {
    'Pri. Claim No': 'Pri. Claim No',
    'Clinician License': 'Clinician License',
    'Encounter Date': 'Encounter Date',
    'Pri. Patient Insurance Card No': 'Pri. Patient Insurance Card No',
    'Department': 'Department',
    'Visit Id': 'Visit Id',
    'Pri. Plan Type': 'Pri. Plan Type',
    'Facility ID': 'Facility ID',
    'Patient Code': 'Patient Code',
    'Clinician Name': 'Clinician Name',
    'Opened by': 'Opened by'
  };

  const combinedRows = [TARGET_HEADERS];

  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
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
      self.postMessage({ type: 'log', message: `File ${name} skipped: header row not found.` });
      continue;
    }

    const headerRow = sheetData[headerRowIndex].map(h => h.toString().trim());
    let headerMap = null;

    headerMap = (headerRow.includes('ClaimID') && headerRow.includes('ClaimDate'))
      ? (headerRow.includes('InvoiceNo') ? CLINICPRO_V2_MAP : CLINICPRO_V1_MAP)
      : (headerRow.includes('Pri. Claim No') && headerRow.includes('Encounter Date') ? INSTAHMS_MAP : null);

    if (!headerMap) {
      self.postMessage({ type: 'log', message: `File ${name} skipped: unrecognized header format.` });
      continue;
    }

    const targetToSource = {};
    for (const [src, tgt] of Object.entries(headerMap)) if (headerRow.includes(src)) targetToSource[tgt] = src;

    let facilityID = '';
    for (let r = headerRowIndex + 1; r < Math.min(sheetData.length, headerRowIndex + 20); r++) {
      const row = sheetData[r];
      if (!row) continue;
      let visitVal = headerMap === CLINICPRO_V1_MAP
        ? (headerRow.indexOf('Visit Id') >= 0 ? (row[headerRow.indexOf('Visit Id')] || '').toString() : '')
        : headerMap === CLINICPRO_V2_MAP
          ? (headerRow.indexOf('InvoiceNo') >= 0 ? (row[headerRow.indexOf('InvoiceNo')] || '').toString() : '')
          : (headerRow.indexOf('Facility ID') >= 0 ? (row[headerRow.indexOf('Facility ID')] || '').toString() : '');

      if (headerMap === INSTAHMS_MAP && facilityID) break;

      const match = visitVal.match(/(MF\d{4,})/i);
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

      const targetRow = TARGET_HEADERS.map(tgt => {
        if (tgt === 'Facility ID') return sourceRow['Facility ID'] || facilityID;
        if (tgt === 'Pri. Patient Insurance Card No') return sourceRow['PatientCardID']?.toString().trim() || sourceRow['Member ID']?.toString().trim() || (targetToSource[tgt] ? sourceRow[targetToSource[tgt]]?.toString().trim() : '');
        if (tgt === 'Patient Code') return sourceRow['FileNo']?.toString().trim() || (targetToSource[tgt] ? sourceRow[targetToSource[tgt]]?.toString().trim() : '');
        if (tgt === 'Clinician License') return sourceRow['Clinician License']?.toString().trim() || '';
        if (tgt === 'Clinician Name') return headerMap === CLINICPRO_V2_MAP ? (sourceRow['OrderDoctor']?.toString().trim() || sourceRow['Clinician Name']?.toString().trim() || '') : (sourceRow['Clinician Name']?.toString().trim() || '');
        if (tgt === 'Opened by') return headerMap === CLINICPRO_V2_MAP ? (sourceRow['Updated By']?.toString().trim() || '') : (sourceRow['Opened by']?.toString().trim() || sourceRow['Opened by/Registration Staff name']?.toString().trim() || '');
        if (tgt === 'Source File') return name;
        const srcKey = targetToSource[tgt];
        return srcKey ? (sourceRow[srcKey]?.toString().trim() || '') : '';
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
