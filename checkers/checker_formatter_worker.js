importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

self.onmessage = async e => {
  const data = e.data;
  if (data.type !== 'start') return;

  const { mode, files } = data;

  try {
    const fileEntries = files.map((buf, i) => ({
      name: `File_${i}`,
      buffer: buf
    }));

    const workbook = (mode === 'eligibility')
      ? await combineEligibilities(fileEntries)
      : await combineReportings(fileEntries);

    const wbData = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    self.postMessage({ type: 'result', workbookData: wbData }, [wbData.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message });
  }
};

async function combineEligibilities(fileEntries) {
  const combinedRows = [];
  let headerRow = null;

  for (let i = 0; i < fileEntries.length; i++) {
    const { buffer } = fileEntries[i];
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

    if (sheetData.length < 2) continue;
    const currentHeader = sheetData[1];
    if (!headerRow) {
      headerRow = currentHeader;
      combinedRows.push(headerRow);
    }

    for (let r = 2; r < sheetData.length; r++) {
      const row = sheetData[r];
      if (!row || row.length === 0) continue;
      combinedRows.push(row);
    }

    self.postMessage({ type: 'progress', progress: Math.floor(((i + 1) / fileEntries.length) * 50) });
  }

  const uniqueRows = [];
  const seen = new Set();
  for (const row of combinedRows) {
    const key = JSON.stringify(row);
    if (!seen.has(key)) {
      uniqueRows.push(row);
      seen.add(key);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(uniqueRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Combined Eligibility');
  self.postMessage({ type: 'progress', progress: 100 });
  return wb;
}

async function combineReportings(fileEntries) {
  const TARGET_HEADERS = [
    'Pri. Claim No',
    'Clinician License',
    'Encounter Date',
    'Pri. Patient Insurance Card No',
    'Department',
    'Visit Id',
    'Pri. Plan Type',
    'Facility ID',
    'Patient Code',
    'Clinician Name',
    'Opened by'
  ];

  const CLINICPRO_MAP = {
    'ClaimID': 'Pri. Claim No',
    'Clinician License': 'Clinician License',
    'ClaimDate': 'Encounter Date',
    'Insurance Company': 'Pri. Plan Type',
    'PatientCardID': 'Pri. Patient Insurance Card No',
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
  const seenClaimIDs = new Set();

  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    const isCSV = name.toLowerCase().endsWith('.csv');
    const isClinicPro = !isCSV;
    const headerMap = isClinicPro ? CLINICPRO_MAP : INSTAHMS_MAP;

    const wb = XLSX.read(buffer, { type: 'array', cellDates: false, raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (sheetData.length < 2) continue;

    const headerRow = sheetData[0].map(h => h.toString().trim());
    const targetToSource = {};
    for (const [src, tgt] of Object.entries(headerMap)) {
      if (headerRow.includes(src)) targetToSource[tgt] = src;
    }

    let facilityID = '';
    for (let r = 1; r < Math.min(sheetData.length, 20); r++) {
      const row = sheetData[r];
      const visitIdx = headerRow.indexOf('Visit Id');
      const visitVal = row?.[visitIdx]?.toString() || '';
      const match = visitVal.match(/(MF\d{4,})/i);
      if (match) {
        facilityID = match[1];
        break;
      }
    }

    for (let r = 1; r < sheetData.length; r++) {
      const row = sheetData[r];
      if (!row || row.length === 0) continue;

      const sourceRow = {};
      headerRow.forEach((h, idx) => {
        sourceRow[h] = row[idx] ?? '';
      });

      let claimID = '';
      if (targetToSource['Pri. Claim No']) {
        claimID = sourceRow[targetToSource['Pri. Claim No']]?.toString().trim() || '';
      }
      if (!claimID || seenClaimIDs.has(claimID)) continue;
      seenClaimIDs.add(claimID);

      const targetRow = [];
      for (const tgtHeader of TARGET_HEADERS) {
        if (tgtHeader === 'Facility ID') {
          targetRow.push(sourceRow['Facility ID'] || facilityID);
          continue;
        }
        if (tgtHeader === 'Pri. Patient Insurance Card No') {
          let val = sourceRow['PatientCardID']?.toString().trim() || '';
          if (!val) val = sourceRow['Member ID']?.toString().trim() || '';
          if (!val && targetToSource[tgtHeader]) val = sourceRow[targetToSource[tgtHeader]]?.toString().trim() || '';
          targetRow.push(val);
          continue;
        }
        if (tgtHeader === 'Patient Code') {
          let val = sourceRow['FileNo']?.toString().trim() || '';
          if (!val && targetToSource[tgtHeader]) val = sourceRow[targetToSource[tgtHeader]]?.toString().trim() || '';
          targetRow.push(val);
          continue;
        }
        const srcHdr = targetToSource[tgtHeader];
        const val = srcHdr ? (sourceRow[srcHdr]?.toString().trim() || '') : '';
        targetRow.push(val);
      }

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
