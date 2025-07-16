importScripts('https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js');

const MODE_ELIGIBILITY = 'eligibility';
const MODE_REPORTING = 'reporting';

let mode = MODE_ELIGIBILITY;

function normalizeClaimID(id) {
  return id ? id.trim() : '';
}

function getReportingHeaders() {
  return [
    "Pri. Claim No", "Clinician License", "Encounter Date", "Pri. Patient Insurance Card No",
    "Department", "Visit Id", "Pri. Plan Type", "Facility ID", "Patient Code", "Clinician Name", "Opened by"
  ];
}

function parseDate(input) {
  // Use a simplified date parse here or embed DateHandler logic if needed
  if (!input) return null;
  if (typeof input === 'number') return XLSX.SSF.parse_date_code(input);
  let d = new Date(input);
  return isNaN(d) ? null : d;
}

// Extract rows from Eligibility sheet (skip first row - headers on second row)
function extractEligibilityRows(sheet) {
  const json = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 1 }); // skip first row (0-based)
  // Filter out completely empty rows
  return json.filter(row => row.some(cell => cell !== null && cell !== undefined && cell.toString().trim() !== ''));
}

// Extract rows from Reporting sheets (detect headers dynamically)
function extractReportingRows(sheet) {
  // Find header row (usually row 0 or 1)
  const range = XLSX.utils.decode_range(sheet['!ref']);
  let headerRowIndex = 0;
  for (let R = range.s.r; R <= range.e.r; ++R) {
    const row = XLSX.utils.sheet_to_json(sheet, { header: 1, range: R + ':' + R })[0];
    if (!row) continue;
    const hasRequiredHeaders = ['ClaimID', 'Pri. Claim No', 'Encounter Date', 'Clinician License'].some(h =>
      row.includes(h));
    if (hasRequiredHeaders) {
      headerRowIndex = R;
      break;
    }
  }
  // Extract rows from headerRowIndex + 1 to end
  return XLSX.utils.sheet_to_json(sheet, { header: 1, range: headerRowIndex + 1 + ':' + range.e.r });
}

// Merge Eligibility rows (remove duplicates - exact row match)
function mergeEligibilityRows(allRows) {
  const uniqueSet = new Set();
  const merged = [];
  for (const row of allRows) {
    const key = JSON.stringify(row);
    if (!uniqueSet.has(key)) {
      uniqueSet.add(key);
      merged.push(row);
    }
  }
  return merged;
}

// Merge Reporting rows (remove duplicates by ClaimID - keep first)
function mergeReportingRows(allRows, claimIDIndex) {
  const seen = new Set();
  const merged = [];
  for (const row of allRows) {
    const claimID = normalizeClaimID(row[claimIDIndex]);
    if (!claimID || seen.has(claimID)) continue;
    seen.add(claimID);
    merged.push(row);
  }
  return merged;
}

// Map ClinicPro / InstaHMS columns to unified reporting headers
function mapReportingRow(row, headers) {
  // headers = actual header array for this row set
  // This is simplified; real mapping might need more checks

  const headerMap = {};
  headers.forEach((h, i) => { headerMap[h] = i; });

  // Map fields to output columns:
  const output = [];

  // Pri. Claim No
  output.push(row[headerMap['ClaimID']] || row[headerMap['Pri. Claim No']] || '');

  // Clinician License
  output.push(row[headerMap['Clinician License']] || row[headerMap['Clinician License']] || '');

  // Encounter Date
  output.push(row[headerMap['Encounter Date']] || '');

  // Pri. Patient Insurance Card No
  output.push(row[headerMap['Pri. Patient Insurance Card No']] || '');

  // Department (ClinicPro can be Clinic)
  output.push(row[headerMap['Department']] || row[headerMap['Clinic']] || '');

  // Visit Id (optional)
  output.push(row[headerMap['Visit Id']] || '');

  // Pri. Plan Type (Insurance Company)
  output.push(row[headerMap['Pri. Plan Type']] || row[headerMap['Insurance Company']] || '');

  // Facility ID
  output.push(row[headerMap['Facility ID']] || '');

  // Patient Code (PatientCardID or Member ID for ClinicPro)
  output.push(row[headerMap['Patient Code']] || row[headerMap['PatientCardID']] || row[headerMap['Member ID']] || '');

  // Clinician Name
  output.push(row[headerMap['Clinician Name']] || '');

  // Opened by
  output.push(row[headerMap['Opened by']] || row[headerMap['Opened by/Registration Staff name']] || '');

  return output;
}

self.onmessage = async function (e) {
  if (e.data.type === 'start') {
    mode = e.data.mode;
    const files = e.data.files;
    let allRows = [];
    let headers = null;
    let totalFiles = files.length;

    for (let i = 0; i < files.length; i++) {
      try {
        const fileData = files[i];
        const workbook = XLSX.read(fileData, { type: 'array' });
        // For eligibility, single sheet expected
        // For reporting, multiple sheets possibly, we merge all

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          if (mode === MODE_ELIGIBILITY) {
            const rows = extractEligibilityRows(sheet);
            allRows = allRows.concat(rows);
          } else {
            if (!headers) {
              // get header row first
              const range = XLSX.utils.decode_range(sheet['!ref']);
              let headerRowIndex = 0;
              // Detect header row
              for (let R = range.s.r; R <= range.e.r; ++R) {
                const row = XLSX.utils.sheet_to_json(sheet, { header: 1, range: R + ':' + R })[0];
                if (!row) continue;
                if (row.includes('Pri. Claim No') || row.includes('ClaimID') || row.includes('Encounter Date')) {
                  headerRowIndex = R;
                  headers = XLSX.utils.sheet_to_json(sheet, { header: 1, range: R + ':' + R })[0];
                  break;
                }
              }
            }
            const rows = extractReportingRows(sheet);
            // Map each row to unified output columns
            for (const row of rows) {
              const mapped = mapReportingRow(row, headers);
              allRows.push(mapped);
            }
          }
        }

        self.postMessage({ type: 'progress', progress: ((i + 1) / totalFiles) * 100 });
      } catch (err) {
        self.postMessage({ type: 'error', error: `Error processing file: ${files[i].name || 'unknown'}` });
      }
    }

    // Merge & remove duplicates
    if (mode === MODE_ELIGIBILITY) {
      allRows = mergeEligibilityRows(allRows);
      // Prepend header row from first file if possible (or static)
      const eligibilityHeader = [
        "Payer Name","Member Name","Transcation Id","Eligibility Request Number","Card Number / DHA Member ID","EID",
        "Ordered On","Answered On","Mobile Number","Authorization Number","Status","Denial Code/Rule ID","Denial Description/Rule Description",
        "Clinician","Clinician Name","Provider License","Provider Name","User Name","Submitted via Emirates Id","Read By Card Reader",
        "Service Category","Consultation Status","Reffering Clinician","Refferal Letter Reference No","Has Multiple Policy","Rule Ansswered",
        "VOI Number","VOI Message","Card Number","PolicyId","PolicyName","EffectiveDate","ExpiryDate","Package Name","Card Network",
        "Network Billing Reference","Question","Answer"
      ];
      allRows.unshift(eligibilityHeader);
    } else {
      // Reporting
      // Remove duplicates by ClaimID index
      const claimIDIndex = 0; // "Pri. Claim No" is first col in mapping
      allRows = mergeReportingRows(allRows, claimIDIndex);
      // Prepend unified headers
      allRows.unshift(getReportingHeaders());
    }

    // Build XLSX workbook for output
    const outWB = XLSX.utils.book_new();
    const outWS = XLSX.utils.aoa_to_sheet(allRows);
    XLSX.utils.book_append_sheet(outWB, outWS, 'Combined');

    // Write workbook to binary
    const wbout = XLSX.write(outWB, { bookType: 'xlsx', type: 'array' });

    self.postMessage({ type: 'done', data: wbout }, [wbout.buffer]);
  }
};
