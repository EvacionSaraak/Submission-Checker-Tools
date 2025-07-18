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
    'Patient Code', 'Clinician Name', 'Opened by'
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

    // Detect header row index
    let headerRowIndex = sheetData.findIndex(row => row.includes('Pri. Claim No') && row.includes('Encounter Date'));
    if (headerRowIndex === -1) continue;

    const headerRow = sheetData[headerRowIndex].map(h => h.toString().trim());

    // Determine which mapping to use by checking unique headers
    let headerMap = null;

    if (headerRow.includes('ClaimID') && headerRow.includes('ClaimDate')) {
      if (headerRow.includes('InvoiceNo')) {
        headerMap = CLINICPRO_V2_MAP;
      } else {
        headerMap = CLINICPRO_V1_MAP;
      }
    } else if (headerRow.includes('Pri. Claim No') && headerRow.includes('Encounter Date')) {
      headerMap = INSTAHMS_MAP;
    } else {
      self.postMessage({ type: 'log', message: `File ${name} skipped: unrecognized header format.` });
      continue;
    }

    // Build targetToSource mapping
    const targetToSource = {};
    for (const [src, tgt] of Object.entries(headerMap)) {
      if (headerRow.includes(src)) targetToSource[tgt] = src;
    }

    // Determine Facility ID
    let facilityID = '';
    for (let r = headerRowIndex + 1; r < Math.min(sheetData.length, headerRowIndex + 20); r++) {
      const row = sheetData[r];
      if (!row) continue;
      let visitVal = '';
      if (headerMap === CLINICPRO_V1_MAP) {
        const visitIdx = headerRow.indexOf('Visit Id');
        visitVal = visitIdx >= 0 ? (row[visitIdx] || '').toString() : '';
      } else if (headerMap === CLINICPRO_V2_MAP) {
        const invoiceIdx = headerRow.indexOf('InvoiceNo');
        visitVal = invoiceIdx >= 0 ? (row[invoiceIdx] || '').toString() : '';
      } else if (headerMap === INSTAHMS_MAP) {
        const facilityIdx = headerRow.indexOf('Facility ID');
        if (facilityIdx >= 0) {
          facilityID = (row[facilityIdx] || '').toString();
          break;
        }
      }
      const match = visitVal.match(/(MF\d{4,})/i);
      if (match) {
        facilityID = match[1];
        break;
      }
    }

    // Per-file seenClaimIDs to deduplicate within the file only
    const seenClaimIDs = new Set();

    // Process rows
    for (let r = headerRowIndex + 1; r < sheetData.length; r++) {
      const row = sheetData[r];
      if (!row || row.length === 0) continue;

      const sourceRow = {};
      headerRow.forEach((h, idx) => {
        sourceRow[h] = row[idx] ?? '';
      });

      const claimIDKey = targetToSource['Pri. Claim No'];
      const claimID = claimIDKey ? sourceRow[claimIDKey]?.toString().trim() : '';
      if (!claimID || seenClaimIDs.has(claimID)) continue;
      seenClaimIDs.add(claimID);

      const targetRow = TARGET_HEADERS.map(tgt => {
        if (tgt === 'Facility ID') return sourceRow['Facility ID'] || facilityID;
        if (tgt === 'Pri. Patient Insurance Card No') {
          return (
            sourceRow['PatientCardID']?.toString().trim() ||
            sourceRow['Member ID']?.toString().trim() ||
            (targetToSource[tgt] ? sourceRow[targetToSource[tgt]]?.toString().trim() : '')
          );
        }
        if (tgt === 'Patient Code') {
          return (
            sourceRow['FileNo']?.toString().trim() ||
            (targetToSource[tgt] ? sourceRow[targetToSource[tgt]]?.toString().trim() : '')
          );
        }
        if (tgt === 'Clinician License') {
          return sourceRow['Clinician License']?.toString().trim() || '';
        }
        if (tgt === 'Clinician Name') {
          if (headerMap === CLINICPRO_V2_MAP) {
            return sourceRow['OrderDoctor']?.toString().trim() || sourceRow['Clinician Name']?.toString().trim() || '';
          }
          return sourceRow['Clinician Name']?.toString().trim() || '';
        }
        if (tgt === 'Opened by') {
          if (headerMap === CLINICPRO_V2_MAP) {
            return sourceRow['Updated By']?.toString().trim() || '';
          }
          return sourceRow['Opened by']?.toString().trim() || sourceRow['Opened by/Registration Staff name']?.toString().trim() || '';
        }
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
