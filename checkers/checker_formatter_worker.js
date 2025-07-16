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

    const dmy = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (dmy) return new Date(dmy[3], dmy[2] - 1, dmy[1]);

    const textMatch = dateStr.match(/^(\d{1,2})[\/\- ]([a-z]{3,})[\/\- ](\d{2,4})$/i);
    if (textMatch) {
      const mIndex = MONTHS.indexOf(textMatch[2].toLowerCase().substr(0, 3));
      if (mIndex >= 0) return new Date(textMatch[3], mIndex, textMatch[1]);
    }

    const iso = dateStr.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
    if (iso) return new Date(iso[1], iso[2] - 1, iso[3]);

    return null;
  }
};

self.onmessage = async e => {
  const data = e.data;
  if (data.type !== 'start') return;

  const { mode, files } = data;

  try {
    const buffers = await Promise.all(files.map(f => f.arrayBuffer()));

    if (mode === 'eligibility') {
      const wb = await combineEligibilities(buffers);
      const wbData = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      self.postMessage({ type: 'result', workbookData: wbData }, [wbData]);
    } else if (mode === 'reporting') {
      const wb = await combineReportings(buffers);
      const wbData = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      self.postMessage({ type: 'result', workbookData: wbData }, [wbData]);
    } else {
      throw new Error(`Unknown mode: ${mode}`);
    }

  } catch (err) {
    self.postMessage({ type: 'error', error: err.message });
  }
};

function findHeaderRow(sheetData, maxScan = 5) {
  for (let i = 0; i < Math.min(sheetData.length, maxScan); i++) {
    const row = sheetData[i];
    if (!Array.isArray(row)) continue;
    const normalized = row.map(v => v?.toString().toLowerCase().trim());
    if (normalized.includes('claimid') || normalized.includes('pri. claim no')) return i;
  }
  return 0;
}

async function combineEligibilities(buffers) {
  const combined = [];
  let header = null;

  for (let i = 0; i < buffers.length; i++) {
    const wb = XLSX.read(buffers[i], { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheet = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

    if (sheet.length < 2) continue;

    const detectedHeader = sheet[1];
    if (!header) {
      header = detectedHeader;
      combined.push(header);
    }

    for (let j = 2; j < sheet.length; j++) {
      const row = sheet[j];
      if (row && row.length > 0) combined.push(row);
    }

    self.postMessage({ type: 'progress', progress: Math.floor(((i + 1) / buffers.length) * 50) });
  }

  const deduped = [];
  const seen = new Set();
  for (const row of combined) {
    const key = JSON.stringify(row);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(row);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(deduped);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Combined Eligibility');
  self.postMessage({ type: 'progress', progress: 100 });
  return wb;
}

async function combineReportings(buffers) {
  const headers = [
    'Pri. Claim No', 'Clinician License', 'Encounter Date',
    'Pri. Patient Insurance Card No', 'Department', 'Visit Id',
    'Pri. Plan Type', 'Facility ID', 'Patient Code',
    'Clinician Name', 'Opened by'
  ];

  const output = [headers];
  const seenClaimIDs = new Set();

  for (let i = 0; i < buffers.length; i++) {
    const wb = XLSX.read(buffers[i], { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    const hIndex = findHeaderRow(data);
    const headerRow = data[hIndex].map(v => v.toString().trim());
    const rows = data.slice(hIndex + 1);

    const isClinicPro = headerRow.includes('ClaimID') || headerRow.includes('Insurance Company');

    for (const row of rows) {
      const rowObj = {};
      headerRow.forEach((h, idx) => rowObj[h] = row[idx] ?? '');

      const claimID = rowObj['ClaimID'] || rowObj['Pri. Claim No'];
      if (!claimID || seenClaimIDs.has(claimID)) continue;

      seenClaimIDs.add(claimID);

      const targetRow = headers.map(h => {
        if (h === 'Patient Code') {
          return (rowObj['PatientCardID'] || rowObj['Member ID'] || '').toString().trim();
        }

        if (h === 'Encounter Date') {
          const parsed = DateHandler.parse(rowObj['ClaimDate'] || rowObj[h]);
          return DateHandler.format(parsed);
        }

        return rowObj[h] || rowObj[headerRow.find(k => k.toLowerCase() === h.toLowerCase())] || '';
      });

      output.push(targetRow);
    }

    self.postMessage({ type: 'progress', progress: 50 + Math.floor(((i + 1) / buffers.length) * 50) });
  }

  const ws = XLSX.utils.aoa_to_sheet(output);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Combined Reporting');
  self.postMessage({ type: 'progress', progress: 100 });
  return wb;
}
