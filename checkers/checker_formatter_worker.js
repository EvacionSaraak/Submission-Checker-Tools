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
    // Excel date serial to JS Date (corrected for 1900 leap year bug)
    const utcDays = Math.floor(serial) - 25569;
    const ms = utcDays * 86400 * 1000;
    const date = new Date(ms);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  },

  _parseStringDate: function(dateStr) {
    if (dateStr.includes(' ')) dateStr = dateStr.split(' ')[0];

    // Matches dd/mm/yyyy or dd-mm-yyyy
    const dmyMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (dmyMatch) return new Date(dmyMatch[3], dmyMatch[2] - 1, dmyMatch[1]);

    // Matches dd mmm yyyy e.g. 12 Jan 2023
    const textMatch = dateStr.match(/^(\d{1,2})[\/\- ]([a-z]{3,})[\/\- ](\d{2,4})$/i);
    if (textMatch) {
      const monthIndex = MONTHS.indexOf(textMatch[2].toLowerCase().substr(0, 3));
      if (monthIndex >= 0) return new Date(textMatch[3], monthIndex, textMatch[1]);
    }

    // Matches ISO yyyy-mm-dd
    const isoMatch = dateStr.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
    if (isoMatch) return new Date(isoMatch[1], isoMatch[2] - 1, isoMatch[3]);

    return null;
  }
};

// Helper: normalize header string for flexible matching
function normalizeHeader(h) {
  return h.toString().trim().toLowerCase().replace(/[^\w]/g, '');
}

self.onmessage = async e => {
  const data = e.data;
  if (data.type !== 'start') return;

  const { mode, files, fileTypes } = data;

  try {
    if (mode === 'eligibility') {
      const wb = await combineEligibilities(files);
      const wbArray = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const wbUint8 = new Uint8Array(wbArray);
      self.postMessage({ type: 'result', workbookData: wbUint8 }, [wbUint8.buffer]);
    } else if (mode === 'reporting') {
      const wb = await combineReportings(files);
      const wbArray = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const wbUint8 = new Uint8Array(wbArray);
      self.postMessage({ type: 'result', workbookData: wbUint8 }, [wbUint8.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: err.message });
  }
};

async function combineEligibilities(fileEntries) {
  const combinedRows = [];
  let headerRow = null;

  for (let i = 0; i < fileEntries.length; i++) {
    const { buffer, name } = fileEntries[i];
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

  // Remove exact duplicate rows (stringify entire row)
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

    if (sheetData.length < 2) {
      self.postMessage({ type: 'log', message: `File ${name} skipped: less than 2 rows` });
      continue;
    }

    const headerRow = sheetData[0].map(h => h.toString().trim());
    // normalize headers for matching
    const normalizedHeaderRow = headerRow.map(normalizeHeader);

    // Normalize keys from headerMap for matching
    const normalizedHeaderMap = {};
    for (const [src, tgt] of Object.entries(headerMap)) {
      normalizedHeaderMap[normalizeHeader(src)] = tgt;
    }

    // Build targetToSource mapping: target header -> actual header in sheet
    const targetToSource = {};
    for (let col = 0; col < normalizedHeaderRow.length; col++) {
      const normHdr = normalizedHeaderRow[col];
      if (normHdr in normalizedHeaderMap) {
        const tgtHeader = normalizedHeaderMap[normHdr];
        targetToSource[tgtHeader] = headerRow[col]; // original header in sheet
      }
    }

    self.postMessage({ type: 'log', message: `File: ${name} headers: ${headerRow.join(', ')}` });
    self.postMessage({ type: 'log', message: `File: ${name} targetToSource: ${JSON.stringify(targetToSource)}` });

    // Detect Facility ID for ClinicPro files (search Visit Id for MFxxxx)
    let facilityID = '';
    if (isClinicPro) {
      const visitIdx = headerRow.findIndex(h => h === targetToSource['Visit Id']);
      for (let r = 1; r < Math.min(sheetData.length, 20); r++) {
        const row = sheetData[r];
        const visitVal = row?.[visitIdx]?.toString() || '';
        const match = visitVal.match(/(MF\d{4,})/i);
        if (match) {
          facilityID = match[1];
          break;
        }
      }
    }

    for (let r = 1; r < sheetData.length; r++) {
      const row = sheetData[r];
      if (!row || row.length === 0) continue;

      // Build sourceRow object: header -> value
      const sourceRow = {};
      for (let col = 0; col < headerRow.length; col++) {
        sourceRow[headerRow[col]] = row[col] ?? '';
      }

      // Get Claim ID and skip if blank or duplicate
      let claimID = '';
      if (targetToSource['Pri. Claim No']) {
        claimID = sourceRow[targetToSource['Pri. Claim No']]?.toString().trim() || '';
      }
      if (!claimID) continue;
      if (seenClaimIDs.has(claimID)) continue;
      seenClaimIDs.add(claimID);

      // Build target row in order
      const targetRow = [];
      for (const tgtHeader of TARGET_HEADERS) {
        if (tgtHeader === 'Facility ID') {
          targetRow.push(sourceRow['Facility ID'] || facilityID || '');
          continue;
        }
        if (tgtHeader === 'Pri. Patient Insurance Card No') {
          // For ClinicPro, try PatientCardID then Member ID
          let val = '';
          if (isClinicPro) {
            val = sourceRow[targetToSource['Pri. Patient Insurance Card No']]?.toString().trim() || '';
            if (!val) {
              val = sourceRow['PatientCardID']?.toString().trim() || '';
              if (!val) val = sourceRow['Member ID']?.toString().trim() || '';
            }
          } else {
            // InstaHMS direct
            val = sourceRow[targetToSource['Pri. Patient Insurance Card No']]?.toString().trim() || '';
          }
          targetRow.push(val);
          continue;
        }
        if (tgtHeader === 'Patient Code') {
          let val = sourceRow[targetToSource['Patient Code']]?.toString().trim() || '';
          if (isClinicPro && !val) val = sourceRow['FileNo']?.toString().trim() || '';
          targetRow.push(val);
          continue;
        }
        const srcHdr = targetToSource[tgtHeader];
        const val = srcHdr ? (sourceRow[srcHdr]?.toString().trim() || '') : '';
        targetRow.push(val);
      }

      // Fix date formatting for Encounter Date (convert Excel serial or strings to dd/mm/yyyy)
      const encounterDateIdx = TARGET_HEADERS.indexOf('Encounter Date');
      if (encounterDateIdx >= 0) {
        let rawDate = targetRow[encounterDateIdx];
      
        if (typeof rawDate === 'string' && rawDate.trim() === '') {
          targetRow[encounterDateIdx] = '';
        } else {
          // Try convert string numbers to actual number
          if (typeof rawDate === 'string' && !isNaN(rawDate)) {
            rawDate = Number(rawDate);
          }
          const parsedDate = DateHandler.parse(rawDate);
          targetRow[encounterDateIdx] = parsedDate ? DateHandler.format(parsedDate) : '';
        }
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
