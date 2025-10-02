/*******************************
 * GLOBAL VARIABLES & CONSTANTS *
 *******************************/
const SERVICE_PACKAGE_RULES = {
  'Dental Services': ['dental', 'orthodontic'],
  'Physiotherapy': ['physio'],
  'Other OP Services': ['physio', 'diet', 'occupational', 'speech'],
  'Consultation': []  // Special handling below
};
const DATE_KEYS = ['Date', 'On'];
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

// Application state
let xmlData = null;
let xlsData = null;
let eligData = null;
const usedEligibilities = new Set();

// DOM Elements
const xmlInput = document.getElementById("xmlFileInput");
const reportInput = document.getElementById("reportFileInput");
const eligInput = document.getElementById("eligibilityFileInput");
const processBtn = document.getElementById("processBtn");
const exportInvalidBtn = document.getElementById("exportInvalidBtn");
const status = document.getElementById("uploadStatus");
const resultsContainer = document.getElementById("results");
const xmlGroup = document.getElementById("xmlReportInputGroup");
const reportGroup = document.getElementById("reportInputGroup");
const xmlRadio = document.querySelector('input[name="reportSource"][value="xml"]');
const xlsRadio = document.querySelector('input[name="reportSource"][value="xls"]');

/*************************
 * RADIO BUTTON HANDLING *
 *************************/
function handleReportSourceChange() {
  const isXmlMode = xmlRadio.checked;

  xmlGroup.style.display = isXmlMode ? 'block' : 'none';
  reportGroup.style.display = isXmlMode ? 'none' : 'block';

  if (isXmlMode) {
    xlsData = null;
    reportInput.value = '';
  } else {
    xmlData = null;
    xmlInput.value = '';
  }

  updateStatus();
}

function initializeRadioButtons() {
  xmlRadio.addEventListener('change', handleReportSourceChange);
  xlsRadio.addEventListener('change', handleReportSourceChange);
  handleReportSourceChange();
}

/*************************
 * DATE HANDLING UTILITIES *
 *************************/
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

/*****************************
 * DATA NORMALIZATION FUNCTIONS *
 *****************************/
function normalizeMemberID(id) {
  if (!id) return '';
  return String(id).trim().replace(/^0+/, '');
}

function normalizeClinician(name) {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Finds the correct header row within the first `maxScan` rows of a sheet (array-of-arrays)
// Returns an object with the detected headerRowIndex, normalized headers array, and rows as objects
function findHeaderRowFromArrays(allRows, maxScan = 10) {
  if (!Array.isArray(allRows) || allRows.length === 0) { return { headerRowIndex: -1, headers: [], rows: [] }; }

  // tokens that commonly appear in the header rows for the supported file types
  const tokens = [
    'pri. claim no', 'pri claim no', 'claimid', 'claim id', 'pri. claim id', 'pri claim id',
    'center name', 'card number', 'card number / dha member id', 'member id', 'patientcardid',
    'pri. patient insurance card no', 'institution', 'facility id', 'mr no.', 'pri. claim id'
  ];

  const scanLimit = Math.min(maxScan, allRows.length);
  let bestIndex = 0;
  let bestScore = 0;

  for (let i = 0; i < scanLimit; i++) {
    const row = allRows[i] || [];
    const joined = row.map(c => (c === null || c === undefined) ? '' : String(c)).join(' ').toLowerCase();

    let score = 0;
    for (const t of tokens) { if (joined.includes(t)) score++; }

    // prefer a row that contains multiple token hits; tie-breaker: earlier row wins
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  // If we found no meaningful header row, default to first row (index 0)
  const headerRowIndex = bestScore > 0 ? bestIndex : 0;
  const rawHeaderRow = allRows[headerRowIndex] || [];

  // normalize headers (trim strings)
  const headers = rawHeaderRow.map(h => (h === null || h === undefined) ? '' : String(h).trim());

  // assemble data rows (everything after headerRowIndex)
  const dataRows = allRows.slice(headerRowIndex + 1);

  // convert to array of objects using detected headers
  const rows = dataRows.map(rowArray => {
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c] || `Column${c+1}`;
      obj[key] = rowArray[c] === undefined || rowArray[c] === null ? '' : rowArray[c];
    }
    return obj;
  });
  return { headerRowIndex, headers, rows };
}

/*******************************
 * ELIGIBILITY MATCHING FUNCTIONS *
 *******************************/
function prepareEligibilityMap(eligData) {
  const eligMap = new Map();

  eligData.forEach(e => {
    const rawID =
      e['Card Number / DHA Member ID'] ||
      e['Card Number'] ||
      e['_5'] ||
      e['MemberID'] ||
      e['Member ID'] ||
      e['Patient Insurance Card No'];

    if (!rawID) return;

    const memberID = normalizeMemberID(rawID); // ✅ only strips leading zeroes

    if (!eligMap.has(memberID)) eligMap.set(memberID, []);

    const eligRecord = {
      'Eligibility Request Number': e['Eligibility Request Number'],
      'Card Number / DHA Member ID': rawID, // preserve original for display
      'Answered On': e['Answered On'],
      'Ordered On': e['Ordered On'],
      'Status': e['Status'],
      'Clinician': e['Clinician'],
      'Payer Name': e['Payer Name'],
      'Service Category': e['Service Category'],
      'Package Name': e['Package Name']
    };

    eligMap.get(memberID).push(eligRecord);
  });

  return eligMap;
}

function findEligibilityForClaim(eligMap, claimDate, memberID, claimClinicians) {
  if (!claimDate) return null;

  const normalizedID = normalizeMemberID(memberID); // ✅ Strip leading zeroes only
  const eligibilities = eligMap.get(normalizedID) || [];

  for (const e of eligibilities) {
    const reqNum = e['Eligibility Request Number'];
    if (usedEligibilities.has(reqNum)) continue;

    const eligDate = DateHandler.parse(e['Answered On'] || e['Ordered On']);
    if (!eligDate) continue;

    if (DateHandler.isSameDay(claimDate, eligDate)) {
      if (checkClinicianMatch(claimClinicians, e.Clinician)) {
        usedEligibilities.add(reqNum);
        return e;
      }
    }
  }

  return null;
}

function checkClinicianMatch(claimClinicians, eligClinician) {
  if (!eligClinician || !claimClinicians?.length) return true;
  const normElig = normalizeClinician(eligClinician);
  return claimClinicians.some(c => normalizeClinician(c) === normElig);
}

/************************
 * VALIDATION FUNCTIONS *
 ************************/
function isServiceCategoryValid(serviceCategory, consultationStatus, rawPackage) {
  if (!serviceCategory) return { valid: true };

  const category = serviceCategory.trim().toLowerCase();
  const pkgRaw = rawPackage || '';
  const pkg = pkgRaw.toLowerCase();

  // Consultation rule: allow anything EXCEPT the restricted types
  if (category === 'consultation' && consultationStatus?.toLowerCase() === 'elective') {
    const disallowed = ['dental', 'physio', 'diet', 'occupational', 'speech'];
    if (disallowed.some(term => pkg.includes(term))) {
      return {
        valid: false,
        reason: `Consultation (Elective) cannot include restricted service types. Found: "${pkgRaw}"`
      };
    }
    return { valid: true };
  }

  // Check other rules based on category
  const allowedKeywords = SERVICE_PACKAGE_RULES[serviceCategory];
  if (allowedKeywords && allowedKeywords.length > 0) {
    // If package name is present, at least one keyword must match
    if (pkg && !allowedKeywords.some(keyword => pkg.includes(keyword))) {
      return {
        valid: false,
        reason: `${serviceCategory} category requires related package. Found: "${pkgRaw}"`
      };
    }
  }

  // If no special rule or package is empty, accept
  return { valid: true };
}

function validateXmlClaims(xmlClaims, eligMap) {
  console.log(`Validating ${xmlClaims.length} XML claims`);
  return xmlClaims.map(claim => {
    const claimDate = DateHandler.parse(claim.encounterStart);
    const formattedDate = DateHandler.format(claimDate);
    const memberID = claim.memberID;
    const eligibility = findEligibilityForClaim(eligMap, claimDate, memberID, claim.clinicians);

    let status = 'invalid';
    const remarks = [];

    if (!eligibility) {
      remarks.push(`No matching eligibility found for ${memberID} on ${formattedDate}`);
    } else if (eligibility.Status?.toLowerCase() !== 'eligible') {
      remarks.push(`Eligibility status: ${eligibility.Status}`);
    } else if (!checkClinicianMatch(claim.clinicians, eligibility.Clinician)) {
      status = 'unknown';
      remarks.push('Clinician mismatch');
    } else {
      status = 'valid';
    }

    return {
      claimID: claim.claimID,
      memberID: claim.memberID,
      encounterStart: formattedDate,
      clinician: eligibility?.['Clinician'] || '',
      serviceCategory: eligibility?.['Service Category'] || '',
      consultationStatus: eligibility?.['Consultation Status'] || '',
      status: eligibility?.Status || '',
      remarks,
      finalStatus: status,
      fullEligibilityRecord: eligibility
    };
  });
}

function validateReportClaims(reportData, eligMap) {
  console.log(`Validating ${reportData.length} report rows`);

  const results = reportData.map(row => {
    if (!row.claimID || String(row.claimID).trim() === '') return null; // Skip blank Claim ID

    const memberID = String(row.memberID || '').trim();
    const claimDateRaw = row.claimDate;

    // Parse and format the claimDate for display, regardless of source
    const claimDate = DateHandler.parse(claimDateRaw);
    const formattedDate = DateHandler.format(claimDate);

    // VVIP IDs: mark as valid with a special remark, but do NOT skip
    const isVVIP = memberID.startsWith('(VVIP)');

    if (isVVIP) {
      return {
        claimID: row.claimID,
        memberID,
        encounterStart: formattedDate,  // use formatted date here
        packageName: row.packageName || '',
        provider: row.provider || '',
        clinician: row.clinician || '',
        serviceCategory: '',
        consultationStatus: '',
        status: 'VVIP',
        remarks: ['VVIP member, eligibility check bypassed'],
        finalStatus: 'valid',
        fullEligibilityRecord: null
      };
    }

    // Proceed with normal eligibility lookup
    const eligibility = findEligibilityForClaim(eligMap, claimDate, memberID, [row.clinician]);

    let status = 'invalid';
    const remarks = [];
    const department = (row.department || row.clinic || '').toLowerCase();

    if (!eligibility) remarks.push(`No matching eligibility found for ${memberID} on ${formattedDate}`);
    else if (eligibility.Status?.toLowerCase() !== 'eligible') remarks.push(`Eligibility status: ${eligibility.Status}`);
    else {
      const serviceCategory = eligibility['Service Category']?.trim() || '';
      const consultationStatus = eligibility['Consultation Status']?.trim()?.toLowerCase() || '';
      const dept = department;

      const matchesCategory = isServiceCategoryValid(serviceCategory, consultationStatus, department).valid;

      if (!matchesCategory) remarks.push(`Invalid for category: ${serviceCategory}, department: ${row.department || row.clinic}`);
      else status = 'valid';
    }

    return {
      claimID: row.claimID,
      memberID,
      encounterStart: formattedDate,
      packageName: eligibility?.['Package Name'] || row.packageName || '',
      provider: eligibility?.['Payer Name'] || row.provider || '',
      clinician: eligibility?.['Clinician'] || row.clinician || '',
      serviceCategory: eligibility?.['Service Category'] || '',
      consultationStatus: eligibility?.['Consultation Status'] || '',
      status: eligibility?.Status || '',
      remarks,
      finalStatus: status,
      fullEligibilityRecord: eligibility
    };
  });

  return results.filter(r => r); // Remove null entries from blank Claim ID rows
}

/*********************
 * FILE PARSING FUNCTIONS *
 *********************/
async function parseXmlFile(file) {
  console.log(`Parsing XML file: ${file.name}`);
  const text = await file.text();
  const xmlDoc = new DOMParser().parseFromString(text, "application/xml");

  const claims = Array.from(xmlDoc.querySelectorAll("Claim")).map(claim => ({
    claimID: claim.querySelector("ID")?.textContent.trim() || '',
    memberID: claim.querySelector("MemberID")?.textContent.trim() || '',
    encounterStart: claim.querySelector("Encounter Start")?.textContent.trim(),
    clinicians: Array.from(claim.querySelectorAll("Clinician")).map(c => c.textContent.trim())
  }));

  return { claims };
}

async function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

        // Helper: detect likely title rows
        function isLikelyTitleRow(row) {
          const emptyCount = row.filter(c => String(c).trim() === '').length;
          return emptyCount > 4; // skip if more than 4 empty cells
        }

        // Detect header row dynamically
        let headerRow = 0;
        let foundHeaders = false;

        while (headerRow < allRows.length && !foundHeaders) {
          const currentRow = allRows[headerRow].map(c => String(c).trim());

          // Skip likely title rows
          if (isLikelyTitleRow(currentRow)) {
            headerRow++;
            continue;
          }

          // Check for known headers
          if (currentRow.some(cell => cell.includes('Pri. Claim No')) ||
              currentRow.some(cell => cell.includes('Pri. Claim ID')) ||
              currentRow.some(cell => cell.includes('Card Number / DHA Member ID'))) {
            foundHeaders = true;
            break;
          }

          // Fallback: treat row with >= 3 non-empty cells as header
          const nonEmptyCells = currentRow.filter(c => c !== '');
          if (nonEmptyCells.length >= 3) {
            foundHeaders = true;
            break;
          }
          headerRow++;
        }

        // Default to first row if none detected
        if (!foundHeaders) headerRow = 0;

        // Trim headers
        const headers = allRows[headerRow].map(h => String(h).trim());
        console.log(`Headers: ${headers}`);

        // Extract data rows
        const dataRows = allRows.slice(headerRow + 1);

        // Map rows to objects
        const jsonData = dataRows.map(row => {
          const obj = {};
          headers.forEach((header, index) => {
            obj[header] = row[index] || '';
          });
          return obj;
        });

        resolve(jsonData);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function parseCsvFile(file) {
  console.log(`Parsing CSV file: ${file.name}`);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = function(e) {
      try {
        const text = e.target.result;
        const workbook = XLSX.read(text, { type: 'string' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

        // Dynamically detect header row by scanning first 5 rows
        let headerRowIndex = -1;
        for (let i = 0; i < 5; i++) {
          const row = allRows[i];
          if (!row) continue;
          const joined = row.join(',').toLowerCase();
          if (joined.includes('pri. claim no') || joined.includes('claimid') || joined.includes('claim id')) {
            headerRowIndex = i;
            break;
          }
        }

        if (headerRowIndex === -1) throw new Error("Could not detect header row in CSV");

        const headers = allRows[headerRowIndex];
        const dataRows = allRows.slice(headerRowIndex + 1);

        console.log(`Detected header at row ${headerRowIndex + 1}:`, headers);

        const rawParsed = dataRows.map(row => {
          const obj = {};
          headers.forEach((header, index) => {
            obj[header] = row[index] || '';
          });
          return obj;
        });

        // Deduplicate based on claim ID
        const seen = new Set();
        const uniqueRows = [];

        const claimIdHeader = headers.find(h =>
          h.toLowerCase().replace(/\s+/g, '') === 'claimid' ||
          h.toLowerCase().includes('claim')  // fallback if no exact match
        );

        if (!claimIdHeader) throw new Error("Could not find a Claim ID column");

        rawParsed.forEach(row => {
          const claimID = row[claimIdHeader];
          if (claimID && !seen.has(claimID)) {
            seen.add(claimID);
            uniqueRows.push(row);
          }
        });

        resolve(uniqueRows);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function normalizeReportData(rawData) {
  // Check if data is from InstaHMS (has 'Pri. Claim No' header)
  const isInsta = rawData[0]?.hasOwnProperty('Pri. Claim No');
  const isOdoo = rawData[0]?.hasOwnProperty('Pri. Claim ID');

  return rawData.map(row => {
    if (isInsta) {
      // InstaHMS report format
      return {
        claimID: row['Pri. Claim No'] || '',
        memberID: row['Pri. Patient Insurance Card No'] || '',
        claimDate: row['Encounter Date'] || '',
        clinician: row['Clinician License'] || '',
        department: row['Department'] || '',
        packageName: row['Pri. Payer Name'] || '', // ✅ shown in table as "Package"
        insuranceCompany: row['Pri. Payer Name'] || ''
      };
    } else if (isOdoo) {
      // InstaHMS report format
      return {
        claimID: row['Pri. Claim ID'] || '',
        memberID: row['Pri. Member ID'] || '',
        claimDate: row['Adm/Reg. Date'] || '',
        clinician: row['Admitting License'] || '',
        department: row['Admitting Department'] || '',
        packageName: row['Pri. Sponsor'] || '',
        insuranceCompany: row['Pri. Plan Type'] || ''
      };
    } else {
      // ClinicPro report format (starts from row 1)
      return {
        claimID: row['ClaimID'] || '',
        memberID: row['PatientCardID'] || '', // patient ID for eligibility match
        claimDate: row['ClaimDate'] || '',
        clinician: row['Clinician License'] || '',
        packageName: row['Insurance Company'] || '', // ✅ shown in table as "Package"
        insuranceCompany: row['Insurance Company'] || '',
        department: row['Clinic'] || ''
      };
    }
  });
}

/********************
 * UI RENDERING FUNCTIONS *
 ********************/
// renderResults: no normalization of memberID in button data attributes
function renderResults(results, eligMap) {
  resultsContainer.innerHTML = '';

  if (!results || results.length === 0) {
    resultsContainer.innerHTML = '<div class="no-results">No claims to display</div>';
    return;
  }

  const tableContainer = document.createElement('div');
  tableContainer.className = 'analysis-results';
  tableContainer.style.overflowX = 'auto';

  const table = document.createElement('table');
  table.className = 'shared-table';

  const isXmlMode = xmlRadio.checked;
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>Claim ID</th>
      <th>Member ID</th>
      <th>Encounter Date</th>
      ${!isXmlMode ? '<th>Package</th><th>Provider</th>' : ''}
      <th>Clinician</th>
      <th>Service Category</th>
      <th>Status</th>
      <th class="wrap-col">Remarks</th>
      <th>Details</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const statusCounts = { valid: 0, invalid: 0, unknown: 0 };

  results.forEach((result, index) => {
    // Skip rows where Member ID is missing/empty
    if (!result.memberID || result.memberID.trim() === '') return;
  
    statusCounts[result.finalStatus]++;
  
    const row = document.createElement('tr');
    row.className = result.finalStatus;
  
    const statusBadge = result.status 
      ? `<span class="status-badge ${result.status.toLowerCase() === 'eligible' ? 'eligible' : 'ineligible'}">${result.status}</span>`
      : '';
  
    const remarksHTML = result.remarks.length > 0
      ? result.remarks.map(r => `<div>${r}</div>`).join('')
      : '<div class="source-note">No remarks</div>';
  
    let detailsCell = '<div class="source-note">N/A</div>';
    if (result.fullEligibilityRecord?.['Eligibility Request Number']) {
      detailsCell = `<button class="details-btn eligibility-details" data-index="${index}">${result.fullEligibilityRecord['Eligibility Request Number']}</button>`;
    } else if (eligMap.has(result.memberID)) {
      detailsCell = `<button class="details-btn show-all-eligibilities" data-member="${result.memberID}" data-clinicians="${(result.clinicians || [result.clinician || '']).join(',')}">View All</button>`;
    }
  
    row.innerHTML = `
      <td>${result.claimID}</td>
      <td>${result.memberID}</td>
      <td>${result.encounterStart}</td>
      ${!isXmlMode ? `<td class="description-col">${result.packageName}</td><td class="description-col">${result.provider}</td>` : ''}
      <td class="description-col">${result.clinician}</td>
      <td class="description-col">${result.serviceCategory}</td>
      <td class="description-col">${statusBadge}</td>
      <td class="wrap-col">${remarksHTML}</td>
      <td>${detailsCell}</td>
    `;
    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  tableContainer.appendChild(table);
  resultsContainer.appendChild(tableContainer);

  const summary = document.createElement('div');
  summary.className = 'loaded-count';
  summary.innerHTML = `
    Processed ${results.length} claims: 
    <span class="valid">${statusCounts.valid} valid</span>, 
    <span class="unknown">${statusCounts.unknown} unknown</span>, 
    <span class="invalid">${statusCounts.invalid} invalid</span>
  `;
  resultsContainer.prepend(summary);

  initEligibilityModal(results, eligMap);
}

function initEligibilityModal(results, eligMap) {
  // Create modal if it doesn't exist
  let modal = document.getElementById('eligibility-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'eligibility-modal';
    modal.className = 'modal';
    modal.style.display = 'none';

    const content = document.createElement('div');
    content.className = 'modal-content';

    const closeBtn = document.createElement('span');
    closeBtn.className = 'close-modal';
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cursor = 'pointer';
    closeBtn.onclick = () => modal.style.display = 'none';

    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'modal-details';

    content.appendChild(closeBtn);
    content.appendChild(detailsDiv);
    modal.appendChild(content);
    document.body.appendChild(modal);
  }

  // Event delegation: listen on the table container
  resultsContainer.addEventListener('click', e => {
    const btn = e.target.closest('.show-all-eligibilities');
    if (!btn) return;

    const memberId = btn.dataset.member;
    const clinicians = btn.dataset.clinicians ? btn.dataset.clinicians.split(',') : [];
    const eligibilities = eligMap.get(memberId) || [];

    console.log('Modal button clicked!');
    console.log('Member ID:', memberId);
    console.log('Clinicians:', clinicians);
    console.log('Eligibilities:', eligibilities);

    const detailsDiv = modal.querySelector('.modal-details');
    detailsDiv.innerHTML = `<h3>Eligibilities for ${memberId}</h3>` +
      eligibilities.map(e => `
        <div>
          <strong>Request #:</strong> ${e['Eligibility Request Number'] || 'N/A'}<br>
          <strong>Clinician:</strong> ${clinicians.join(', ')}<br>
          <strong>Package:</strong> ${e['Package Name'] || 'N/A'}
        </div>
      `).join('<hr>');

    modal.style.display = 'block';
  });

  // Close modal by clicking outside
  window.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
}

function formatEligibilityDetails(record, memberID) {
  // Using existing eligibility-details table class
  let html = `
    <div class="form-row">
      <strong>Member:</strong> ${memberID}
      <span class="status-badge ${record.Status.toLowerCase() === 'eligible' ? 'eligible' : 'ineligible'}">
        ${record.Status}
      </span>
    </div>
    <table class="eligibility-details">
      <tbody>
  `;

  Object.entries(record).forEach(([key, value]) => {
    if (!value && value !== 0) return;

    // Format dates using existing date-value class
    if (key.includes('Date') || key.includes('On')) {
      value = `<span class="date-value">${DateHandler.format(DateHandler.parse(value)) || value}</span>`;
    }

    html += `
      <tr>
        <th>${key}</th>
        <td>${value}</td>
      </tr>
    `;
  });

  html += `
      </tbody>
    </table>
  `;

  return html;
}

function updateStatus(message) {
  status.textContent = message || 'Ready';
}

function updateProcessButtonState() {
  const hasEligibility = !!eligData;
  const hasReportData = xmlRadio.checked ? !!xmlData : !!xlsData;
  processBtn.disabled = !hasEligibility || !hasReportData;
  exportInvalidBtn.disabled = !hasEligibility || !hasReportData;
}


/************************
 * EXPORT FUNCTIONALITY *
 ************************/
function exportInvalidEntries(results) {
  // Filter only invalid entries
  const invalidEntries = results.filter(r => r && r.finalStatus === 'invalid');

  if (invalidEntries.length === 0) {
    alert('No invalid entries to export.');
    return;
  }

  // Map data to plain objects for export
  const exportData = invalidEntries.map(entry => ({
    'Claim ID': entry.claimID,
    'Member ID': entry.memberID,
    'Encounter Date': entry.encounterStart,
    'Package Name': entry.packageName || '',
    'Provider': entry.provider || '',
    'Clinician': entry.clinician || '',
    'Service Category': entry.serviceCategory || '',
    'Consultation Status': entry.consultationStatus || '',
    'Eligibility Status': entry.status || '',
    'Final Status': entry.finalStatus,
    'Remarks': entry.remarks.join('; ')
  }));

  // Create a new workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportData);

  XLSX.utils.book_append_sheet(wb, ws, 'Invalid Claims');

  // Generate XLSX file and trigger download
  XLSX.writeFile(wb, `invalid_claims_${new Date().toISOString().slice(0,10)}.xlsx`);
}


/********************
 * EVENT HANDLERS *
 ********************/
async function handleFileUpload(event, type) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    updateStatus(`Loading ${type} file...`);

    if (type === 'xml') {
      xmlData = await parseXmlFile(file);
      updateStatus(`Loaded ${xmlData.claims.length} XML claims`);
    } 
    else if (type === 'eligibility') {
      eligData = await parseExcelFile(file);
      updateStatus(`Loaded ${eligData.length} eligibility records`);
    }
    else {
      const rawData = file.name.endsWith('.csv') 
        ? await parseCsvFile(file) 
        : await parseExcelFile(file);
      xlsData = normalizeReportData(rawData).filter(r => {
        return r.claimID !== null && r.claimID !== undefined && String(r.claimID).trim() !== '';
      });
      console.log(xlsData);
      updateStatus(`Loaded ${xlsData.length} report rows`);
    }

    updateProcessButtonState();
  } catch (error) {
    console.error(`${type} file error:`, error);
    updateStatus(`Error loading ${type} file`);
  }
}

async function handleProcessClick() {
  if (!eligData) {
    updateStatus('Error: Missing eligibility file');
    return alert('Please upload eligibility file first');
  }

  try {
    updateStatus('Processing...');
    usedEligibilities.clear();

    const eligMap = prepareEligibilityMap(eligData);
    const results = xmlRadio.checked
      ? validateXmlClaims(xmlData.claims, eligMap)
      : validateReportClaims(xlsData, eligMap);

    window.lastValidationResults = results;  // <-- Save here

    renderResults(results, eligMap);  // ✅ Pass eligMap here
    updateStatus(`Processed ${results.length} claims`);
  } catch (error) {
    console.error('Processing error:', error);
    updateStatus('Processing failed');
    resultsContainer.innerHTML = `<div class="error">${error.message}</div>`;
  }
}

function handleExportInvalidClick() {
  if (!window.lastValidationResults) {
    alert('Please run the validation first.');
    return;
  }
  exportInvalidEntries(window.lastValidationResults);
}

/********************
 * INITIALIZATION *
 ********************/
function initializeEventListeners() {
  xmlInput.addEventListener('change', (e) => handleFileUpload(e, 'xml'));
  reportInput.addEventListener('change', (e) => handleFileUpload(e, 'report'));
  eligInput.addEventListener('change', (e) => handleFileUpload(e, 'eligibility'));
  processBtn.addEventListener('click', handleProcessClick);
  exportInvalidBtn.addEventListener('click', handleExportInvalidClick);
  initializeRadioButtons();
}

document.addEventListener('DOMContentLoaded', () => {
  initializeEventListeners();
  updateStatus('Ready to process files');
});
