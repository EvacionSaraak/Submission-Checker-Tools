// checker_formatter.js

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const DateHandler = {
  parse: function(input) {
    if (!input) return null;
    if (input instanceof Date) return isNaN(input) ? null : input;
    if (typeof input === 'number') return this._parseExcelDate(input);

    const cleanStr = input.toString().trim().replace(/[,.]/g, '');
    const parsed = this._parseStringDate(cleanStr) || new Date(cleanStr);
    if (isNaN(parsed)) {
      console.warn('Unrecognized date:', input);
      return null;
    }
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
    const utcDays = Math.floor(serial) - 25569; // 25569 = days between 1899-12-30 and 1970-01-01
    const ms = utcDays * 86400 * 1000;
    const date = new Date(ms);
  
    // Manually extract date parts from UTC (avoid local time shift)
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  },

  _parseStringDate: function(dateStr) {
    if (dateStr.includes(' ')) {
      dateStr = dateStr.split(' ')[0];
    }

    // Matches DD/MM/YYYY or DD-MM-YYYY
    const dmyMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (dmyMatch) return new Date(dmyMatch[3], dmyMatch[2] - 1, dmyMatch[1]);

    // Matches MM/DD/YYYY
    const mdyMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (mdyMatch) return new Date(mdyMatch[3], mdyMatch[1] - 1, mdyMatch[2]);

    // Matches 30-Jun-2025 or 30 Jun 2025
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

// Elements and state
const eligibilitySection = document.getElementById('eligibility-section');
const reportSection = document.getElementById('report-section');
const combineButton = document.getElementById('combine-button');
const messageBox = document.getElementById('messageBox');
let mode = 'eligibility';

document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener('change', e => {
    mode = e.target.value;
    eligibilitySection.classList.toggle('hidden', mode !== 'eligibility');
    reportSection.classList.toggle('hidden', mode !== 'report');
    messageBox.textContent = '';
  });
});

combineButton.addEventListener('click', async () => {
  messageBox.textContent = '';
  try {
    if (mode === 'eligibility') {
      const files = document.getElementById('eligibility-files').files;
      if (files.length) await combineEligibilityFiles(files);
      else messageBox.textContent = 'No eligibility files selected.';
    } else {
      const files = document.getElementById('report-files').files;
      if (files.length) await combineReportFiles(files);
      else messageBox.textContent = 'No report files selected.';
    }
  } catch (err) {
    console.error(err);
    messageBox.textContent = 'An error occurred during processing.';
  }
});

// --- Eligibility combining with exact row duplicate removal ---
async function combineEligibilityFiles(fileList) {
  const mergedRows = [];
  let headers;

  for (const file of fileList) {
    const data = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(data, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // Header is on second row => index 1
    const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!headers) headers = json[1];
    const dataRows = json.slice(2);

    mergedRows.push(...dataRows);
  }

  // Remove exact duplicate rows (full row match)
  const uniqueRows = Array.from(new Set(mergedRows.map(row => JSON.stringify(row))))
                          .map(str => JSON.parse(str));

  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...uniqueRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Eligibility');
  XLSX.writeFile(workbook, 'EligibilityCombined.xlsx');
}

// --- Reporting combining with duplicate claim ID removal ---
async function combineReportFiles(fileList) {
  const finalHeaders = [
    "Pri. Claim No", "Clinician License", "Encounter Date", "Pri. Patient Insurance Card No",
    "Department", "Visit Id", "Pri. Plan Type", "Facility ID", "Patient Code", "Clinician Name", "Opened by"
  ];
  const mergedRows = [];
  const seenClaimIds = new Set();

  for (const file of fileList) {
    const data = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(data, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    // Auto-detect header row index based on known headers
    const headerRowIndex = allRows.findIndex(row =>
      row.includes("Clinician License") || row.includes("Pri. Claim No") || row.includes("ClaimID")
    );

    if (headerRowIndex < 0) {
      console.warn(`No header row found in file: ${file.name}`);
      continue;
    }

    const headers = allRows[headerRowIndex];
    const dataRows = allRows.slice(headerRowIndex + 1);

    for (const row of dataRows) {
      const rowObj = Object.fromEntries(headers.map((key, i) => [key, row[i]]));

      // Get claim ID: ClinicPro = ClaimID, InstaHMS = Pri. Claim No
      const claimId = rowObj["Pri. Claim No"] || rowObj["ClaimID"];
      if (!claimId) continue; // skip rows without claim id

      // Skip duplicates (keep first occurrence)
      if (seenClaimIds.has(claimId)) continue;
      seenClaimIds.add(claimId);

      // Extract mapped fields with fallback logic
      const clinicianLicense = rowObj["Clinician License"] || '';
      const rawEncounterDate = rowObj["Encounter Date"] || rowObj["ClaimDate"] || '';
      const parsedDate = DateHandler.parse(rawEncounterDate);
      const encounterDate = DateHandler.format(parsedDate);

      // Patient Insurance Card No
      const patientInsuranceCardNo = rowObj["Pri. Patient Insurance Card No"] || rowObj["Member ID"] || '';

      // Department fallback: ClinicPro may have Clinic or Department
      const department = rowObj["Department"] || rowObj["Clinic"] || '';

      const visitId = rowObj["Visit Id"] || ''; // may be blank

      // Pri. Plan Type mapping for ClinicPro = Insurance Company
      // InstaHMS uses Pri. Plan Type directly
      let priPlanType = '';
      if ("Insurance Company" in rowObj) priPlanType = rowObj["Insurance Company"];
      else if ("Pri. Plan Type" in rowObj) priPlanType = rowObj["Pri. Plan Type"];

      // Facility ID fallback
      const facilityId = rowObj["Facility ID"] || rowObj["Institution"] || '';

      // Patient Code priority: ClinicPro: PatientCardID or Member ID; InstaHMS: Patient Code
      let patientCode = '';
      if ("PatientCardID" in rowObj && rowObj["PatientCardID"]) {
        patientCode = rowObj["PatientCardID"];
      } else if ("Patient Code" in rowObj && rowObj["Patient Code"]) {
        patientCode = rowObj["Patient Code"];
      } else if ("Member ID" in rowObj && rowObj["Member ID"]) {
        patientCode = rowObj["Member ID"];
      } else if ("FileNo" in rowObj && rowObj["FileNo"]) {
        patientCode = rowObj["FileNo"];
      }

      const clinicianName = rowObj["Clinician Name"] || '';
      // Opened by: ClinicPro "Opened by/Registration Staff name", InstaHMS "Opened by" or "Updated By"
      let openedBy = '';
      if ("Opened by/Registration Staff name" in rowObj && rowObj["Opened by/Registration Staff name"]) {
        openedBy = rowObj["Opened by/Registration Staff name"];
      } else if ("Opened by" in rowObj && rowObj["Opened by"]) {
        openedBy = rowObj["Opened by"];
      } else if ("Updated By" in rowObj && rowObj["Updated By"]) {
        openedBy = rowObj["Updated By"];
      }

      mergedRows.push([
        claimId,
        clinicianLicense,
        encounterDate,
        patientInsuranceCardNo,
        department,
        visitId,
        priPlanType,
        facilityId,
        patientCode,
        clinicianName,
        openedBy
      ]);
    }
  }

  const worksheet = XLSX.utils.aoa_to_sheet([finalHeaders, ...mergedRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Reports');
  XLSX.writeFile(workbook, 'ReportsCombined.xlsx');
}

// Utility to read file as ArrayBuffer for XLSX
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = e => reject(e);
    reader.readAsArrayBuffer(file);
  });
}
