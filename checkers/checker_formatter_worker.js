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

  isSameDay: function(date1, date2) {
    if (!date1 || !date2) return false;
    return date1.getDate() === date2.getDate() &&
           date1.getMonth() === date2.getMonth() &&
           date1.getFullYear() === date2.getFullYear();
  },

  _parseExcelDate: function(serial) {
    const utcDays = Math.floor(serial) - 25569;
    const ms = utcDays * 86400 * 1000;
    const date = new Date(ms);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  },

  _parseStringDate: function(dateStr) {
    if (dateStr.includes(' ')) dateStr = dateStr.split(' ')[0];

    // DD/MM/YYYY or DD-MM-YYYY
    const dmyMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (dmyMatch) return new Date(dmyMatch[3], dmyMatch[2] - 1, dmyMatch[1]);

    // 30-Jun-2025 or 30 Jun 2025
    const textMatch = dateStr.match(/^(\d{1,2})[\/\- ]([a-z]{3,})[\/\- ](\d{2,4})$/i);
    if (textMatch) {
      const monthIndex = MONTHS.indexOf(textMatch[2].toLowerCase().substr(0, 3));
      if (monthIndex >= 0) return new Date(textMatch[3], monthIndex, textMatch[1]);
    }

    // ISO: 2025-07-01
    const isoMatch = dateStr.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
    if (isoMatch) return new Date(isoMatch[1], isoMatch[2] - 1, isoMatch[3]);

    return null;
  }
};

self.onmessage = async e => {
  const data = e.data;
  if (data.type !== 'start') return;

  const { mode, files } = data;

  try {
    if (mode === 'eligibility') {
      const combinedWb = await combineEligibilities(files);

      // Ensure wbArray is a valid transferable Uint8Array
      const wbArray = XLSX.write(combinedWb, { bookType: 'xlsx', type: 'array' });
      const wbData = new Uint8Array(wbArray); // Ensure it's a transferable object
      self.postMessage({ type: 'result', workbookData: wbData }, [wbData.buffer]);

    } else if (mode === 'reporting') {
      const combinedWb = await combineReportings(files);

      const wbArray = XLSX.write(combinedWb, { bookType: 'xlsx', type: 'array' });
      const wbData = new Uint8Array(wbArray); // Ensure it's a transferable object
      self.postMessage({ type: 'result', workbookData: wbData }, [wbData.buffer]);

    } else {
      throw new Error(`Unknown mode: ${mode}`);
    }

  } catch (err) {
    self.postMessage({ type: 'error', error: err.message });
  }
};

async function combineEligibilities(fileBuffers) {
  const combinedRows = [];
  let headerRow = null;

  for (let i = 0; i < fileBuffers.length; i++) {
    const buf = fileBuffers[i];
    try {
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

      if (sheetData.length < 2) throw new Error(`File ${i + 1} has no data rows.`);

      // Header is on second row (index 1)
      const currentHeader = sheetData[1];

      if (!headerRow) {
        headerRow = currentHeader;
        combinedRows.push(headerRow);
      }

      // Append rows from index 2 (data rows)
      for (let r = 2; r < sheetData.length; r++) {
        const row = sheetData[r];
        if (!row || row.length === 0) continue;
        combinedRows.push(row);
      }

      self.postMessage({ type: 'progress', progress: Math.floor(((i + 1) / fileBuffers.length) * 50) });

    } catch (err) {
      throw new Error(`Failed to read eligibility file #${i + 1}: ${err.message}`);
    }
  }

  // Remove exact duplicate rows by stringifying row arrays
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

async function combineReportings(fileBuffers) {
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
    'Facility ID': 'Facility ID',
    'PatientCardID': 'Patient Code',
    'Member ID': 'Patient Code',
    'Clinic': 'Department',
    'Visit Id': 'Visit Id',
    'Clinician Name': 'Clinician Name',
    'Opened by/Registration Staff name': 'Opened by',
    'Opened by': 'Opened by'
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

  for (let i = 0; i < fileBuffers.length; i++) {
    const buf = fileBuffers[i];
    try {
      const wb = XLSX.read(buf, { type: 'array', cellDates: false, raw: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const sheetData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // Find header row
      let headerRowIndex = -1;
      let headerRow = null;
      for (let r = 0; r < Math.min(5, sheetData.length); r++) {
        const row = sheetData[r].map(h => h.toString().trim());
        if (row.includes('ClaimID') || row.includes('Pri. Claim No')) {
          headerRowIndex = r;
          headerRow = row;
          break;
        }
      }
      if (headerRowIndex === -1) throw new Error(`Cannot find header row in reporting file #${i + 1}`);

      const isClinicPro = headerRow.some(h => Object.keys(CLINICPRO_MAP).includes(h));
      const isInstaHMS = headerRow.some(h => Object.keys(INSTAHMS_MAP).includes(h));
      const headerMap = isClinicPro ? CLINICPRO_MAP : INSTAHMS_MAP;

      // Map: target => source field
      const targetToSource = {};
      for (const [src, tgt] of Object.entries(headerMap)) {
        if (headerRow.includes(src)) {
          if (!targetToSource[tgt]) targetToSource[tgt] = src; // prefer first match
        }
      }

      for (let r = headerRowIndex + 1; r < sheetData.length; r++) {
        const row = sheetData[r];
        if (!row || row.length === 0) continue;

        const sourceRow = {};
        headerRow.forEach((h, idx) => {
          sourceRow[h] = row[idx] ?? '';
        });

        let claimID = targetToSource['Pri. Claim No'] ? sourceRow[targetToSource['Pri. Claim No']]?.toString().trim() : '';
        if (!claimID || seenClaimIDs.has(claimID)) continue;
        seenClaimIDs.add(claimID);

        const targetRow = [];
        for (const tgt of TARGET_HEADERS) {
          let value = '';

          if (tgt === 'Patient Code') {
            if (isClinicPro) {
              value = sourceRow['PatientCardID']?.toString().trim() || sourceRow['Member ID']?.toString().trim() || '';
            } else {
              const src = targetToSource[tgt];
              value = src ? sourceRow[src]?.toString().trim() || '' : '';
            }
          } else if (tgt === 'Encounter Date') {
            const src = targetToSource[tgt];
            const rawDate = src ? sourceRow[src] : '';
            const parsed = DateHandler.parse(rawDate);
            value = parsed ? DateHandler.format(parsed) : '';
          } else {
            const src = targetToSource[tgt];
            value = src ? sourceRow[src]?.toString().trim() || '' : '';
          }

          targetRow.push(value);
        }

        combinedRows.push(targetRow);
      }

      self.postMessage({ type: 'progress', progress: 50 + Math.floor(((i + 1) / fileBuffers.length) * 50) });

    } catch (err) {
      throw new Error(`Failed to read reporting file #${i + 1}: ${err.message}`);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(combinedRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Combined Reporting');
  self.postMessage({ type: 'progress', progress: 100 });
  return wb;
}
