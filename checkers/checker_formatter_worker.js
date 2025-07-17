importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

const DateHandler = {
  parse: function(input) {
    if (!input) return null;
    if (input instanceof Date) return isNaN(input) ? null : input;
    if (typeof input === 'number') return this._parseExcelDate(input);

    const cleanStr = input.toString().trim().replace(/[,.]/g, '');
    const parsed = this._parseStringDate(cleanStr) || new Date(cleanStr);
    if (isNaN(parsed)) return null;
    return parsed;
  },

  format: function(date) {
    if (!(date instanceof Date) || isNaN(date)) return '';
    const d = date.getDate().toString().padStart(2, '0');
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const y = date.getFullYear();
    return `${d}/${m}/${y}`;
  },

  _parseExcelDate: function(serial) {
    const utcDays = Math.floor(serial) - 25569;
    const ms = utcDays * 86400 * 1000;
    const date = new Date(ms);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  },

  _parseStringDate: function(dateStr) {
    if (dateStr.includes(' ')) dateStr = dateStr.split(' ')[0];

    const dmyMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (dmyMatch) return new Date(dmyMatch[3], dmyMatch[2] - 1, dmyMatch[1]);

    const textMatch = dateStr.match(/^(\d{1,2})[\/\- ]([a-z]{3,})[\/\- ](\d{2,4})$/i);
    if (textMatch) {
      const monthIndex = MONTHS.indexOf(textMatch[2].toLowerCase().substr(0, 3));
      if (monthIndex >= 0) return new Date(textMatch[3], monthIndex, textMatch[1]);
    }

    const isoMatch = dateStr.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
    if (isoMatch) return new Date(isoMatch[1], isoMatch[2] - 1, isoMatch[3]);

    return null;
  }
};

self.onmessage = async e => {
  const data = e.data;
  if (data.type !== 'start') return;

  const { mode, files, fileTypes } = data;

  try {
    // Log start
    self.postMessage({ type: 'log', message: `Processing started in mode: ${mode}, files: ${files.length}` });

    const combineFn = mode === 'eligibility' ? combineEligibilities : combineReportings;
    const wb = await combineFn(files, fileTypes || []);
    const wbArray = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const wbUint8 = new Uint8Array(wbArray);
    self.postMessage({ type: 'result', workbookData: wbUint8 }, [wbUint8.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message });
  }
};

async function combineEligibilities(fileEntries) {
  const combinedRows = [];
  let headerRow = null;

  for (let i = 0; i < fileEntries.length; i++) {
    const { name, buffer } = fileEntries[i];
    self.postMessage({ type: 'log', message: `Reading eligibility file ${i + 1}: ${name}` });

    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

    if (sheetData.length < 2) {
      self.postMessage({ type: 'log', message: `File ${name} has less than 2 rows, skipping.` });
      continue;
    }

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

  // Remove exact duplicate rows
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

  const CLINICIAN_LICENSE_MAP = {
    "PranJal Sharma": "GD25271",
    "Hiba Sirelkhatim Mahgoub": "GD36723",
    "Shimaa Ibrahim Rashed": "GD25730",
    "Vaqar Miyan Khan": "GD19319",
    "Vinod Venugopal Menon": "GD44108",
    "Aalaa Salim Ahmed Salim": "GD45251",
    "Mozher Habib": "GD11562",
    "Sami Wajih Mousa Owais": "GD40942",
    "Isameldeen  Yassin Abdelmageed": "GD45348",
    "Rhea Mahajan": "GD43977",
    "Reem H A Ammoura": "GD25389",
    "Zakia Abualhassan Osman Aidam": "GD45711",
    "Khaled Mohammad Jamal Al Deri": "GD41075",
    "Juhi Jaiswal Ramesh Shankar": "GD44353"
  };

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

    // Determine facility ID from Visit Id in first 20 rows
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

      // Get clinician info and fill license if missing
      let clinicianName = sourceRow['Clinician Name']?.toString().trim() || '';
      let clinicianLicense = sourceRow['Clinician License']?.toString().trim() || '';

      if (!clinicianLicense && clinicianName && CLINICIAN_LICENSE_MAP[clinicianName]) {
        clinicianLicense = CLINICIAN_LICENSE_MAP[clinicianName];
      }

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
        if (tgtHeader === 'Clinician License') {
          targetRow.push(clinicianLicense);
          continue;
        }
        if (tgtHeader === 'Clinician Name') {
          targetRow.push(clinicianName);
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
