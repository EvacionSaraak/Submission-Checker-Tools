/*******************************
 * GLOBAL VARIABLES & CONSTANTS *
 *******************************/
const SERVICE_PACKAGE_RULES = {
  'Dental Services': ['dental'],
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
    const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return serial >= 60 ? new Date(date.getTime() + 86400000) : date;
  },

  _parseStringDate: function(dateStr) {
    // Remove time portion like "17/06/2025 16:10" → "17/06/2025"
    if (dateStr.includes(' ')) {
      dateStr = dateStr.split(' ')[0];
    }

    // Matches DD/MM/YYYY or DD-MM-YYYY
    const dmyMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (dmyMatch) return new Date(dmyMatch[3], dmyMatch[2] - 1, dmyMatch[1]);

    // Matches MM/DD/YYYY (not typical for your case, but included)
    const mdyMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (mdyMatch) return new Date(mdyMatch[3], mdyMatch[1] - 1, mdyMatch[2]);

    // Matches 30-Jun-2025 or 30 Jun 2025
    const textMatch = dateStr.match(/^(\d{1,2})[\/\- ]([a-z]{3,})[\/\- ](\d{2,4})$/i);
    if (textMatch) {
      const monthIndex = MONTHS.indexOf(textMatch[2].toLowerCase().substr(0, 3));
      if (monthIndex >= 0) return new Date(textMatch[3], monthIndex, textMatch[1]);
    }

    // ISO style fallback: 2025-07-01
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
  // Handle cases where ID might be a number in scientific notation
  if (typeof id === 'number') return String(id).replace(/\.0+$/, ''); 
  // Standard normalization
  return String(id)
    .replace(/\D/g, '')
    .replace(/^0+/, '')
    .trim();
}

function normalizeClinician(name) {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/*******************************
 * ELIGIBILITY MATCHING FUNCTIONS *
 *******************************/
function prepareEligibilityMap(eligData) {
  const eligMap = new Map();
  
  eligData.forEach(e => {
    // Extract member ID from the correct column based on header
    const memberID = normalizeMemberID(
      e['Card Number / DHA Member ID'] || 
      e['Card Number'] || 
      e['_5'] || // Fallback for Daman files
      e['MemberID'] ||
      e['Member ID'] ||
      e['Patient Insurance Card No']
    );

    if (!memberID) return;

    if (!eligMap.has(memberID)) {
      eligMap.set(memberID, []);
    }

    // Standardize eligibility record format
    const eligRecord = {
      'Eligibility Request Number': e['Eligibility Request Number'],
      'Card Number / DHA Member ID': memberID,
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
  
  const eligibilities = eligMap.get(normalizeMemberID(memberID)) || [];

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
    const memberID = normalizeMemberID(claim.memberID);
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
    if (!row.claimID || row.claimID.trim() === '') return null; // ✅ Skip blank Claim ID

    const claimDate = DateHandler.parse(row.claimDate);
    const formattedDate = DateHandler.format(claimDate);
    const memberID = normalizeMemberID(row.memberID);
    const eligibility = findEligibilityForClaim(eligMap, claimDate, memberID, [row.clinician]);

    let status = 'invalid';
    const remarks = [];
    const department = (row.department || row.clinic || '').toLowerCase();

    if (!eligibility) {
      remarks.push(`No matching eligibility found for ${memberID} on ${formattedDate}`);
    } else if (eligibility.Status?.toLowerCase() !== 'eligible') {
      remarks.push(`Eligibility status: ${eligibility.Status}`);
    } else {
      const serviceCategory = eligibility['Service Category']?.trim() || '';
      const consultationStatus = eligibility['Consultation Status']?.trim()?.toLowerCase() || '';
      const dept = department.toLowerCase();

      const matchesCategory = (() => {
        if (serviceCategory === 'Consultation' && consultationStatus === 'elective') {
          const excluded = ['dental', 'physiotherapy', 'dietician', 'occupational therapy', 'speech therapy'];
          return !excluded.includes(dept);
        }
        if (serviceCategory === 'Dental Services') { return dept.includes('dental'); }
        if (serviceCategory === 'Physiotherapy') { return dept.includes('physio'); }
        if (serviceCategory === 'Other OP Services') { return ['physio', 'dietician', 'occupational', 'speech'].some(term => dept.includes(term)); }
        return true; // allow all else
      })();

      if (!matchesCategory) {
        remarks.push(`Invalid for category: ${serviceCategory}, department: ${row.department || row.clinic}`);
      } else {
        status = 'valid';
      }
    }

    return {
      claimID: row.claimID,
      memberID: row.memberID,
      encounterStart: formattedDate,
      packageName: eligibility?.['Package Name'] || '',
      provider: eligibility?.['Payer Name'] || '',
      clinician: eligibility?.['Clinician'] || '',
      serviceCategory: eligibility?.['Service Category'] || '',
      consultationStatus: eligibility?.['Consultation Status'] || '',
      status: eligibility?.Status || '',
      remarks,
      finalStatus: status,
      fullEligibilityRecord: eligibility
    };
  });

  return results.filter(r => r); // ✅ Remove nulls from skipped blank claimIDs
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

        // Dynamic header row detection
        let headerRow = 0;
        let foundHeaders = false;
        
        while (headerRow < allRows.length && !foundHeaders) {
          const currentRow = allRows[headerRow];
          
          // Check for Insta report headers (row 4)
          if (currentRow.some(cell => String(cell).includes('Pri. Claim No'))) {
            foundHeaders = true;
            break;
          }
          
          // Check for eligibility headers (row 2)
          if (currentRow.some(cell => String(cell).includes('Card Number / DHA Member ID'))) {
            foundHeaders = true;
            break;
          }
          
          headerRow++;
        }

        // Fallback to first row if no headers found
        if (!foundHeaders) headerRow = 0;
        
        const headers = allRows[headerRow].map(h => h.trim());
        console.log(`Headers: ${headers}`);
        const dataRows = allRows.slice(headerRow + 1);
        
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
        
        const isCsvReport = allRows[3]?.some(h => h.includes('Pri. Claim No'));
        const headers = isCsvReport ? allRows[3] : allRows[0];
        console.log(`Headers: ${headers}`);
        const dataRows = isCsvReport ? allRows.slice(4) : allRows.slice(1);
        
        resolve(dataRows.map(row => {
          const obj = {};
          headers.forEach((header, index) => {
            obj[header] = row[index] || '';
          });
          return obj;
        }));
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

  return rawData.map(row => {
    if (isInsta) {
      // InstaHMS report format
      return {
        claimID: row['Pri. Claim No'] || '',
        memberID: row['Pri. Patient Insurance Card No'] || '',
        claimDate: row['Encounter Date'] || '',
        clinician: row['Clinician License'] || '',
        insuranceCompany: row['Pri. Payer Name'] || '',
        department: row['Department'] || '',
        packageName: row['Pri. Payer Name'] || ''  // <-- important
      };
    } else {
      // ClinicPro report format (starts from row 1)
      return {
        claimID: row['ClaimID'] || '',
        memberID: row['PatientCardID'] || '', // patient ID for eligibility match
        claimDate: row['ClaimDate'] || '',
        clinician: row['Clinician License'] || '',
        insuranceCompany: row['Insurance Company'] || '',
        department: row['Clinic'] || ''
      };
    }
  });
}

/********************
 * UI RENDERING FUNCTIONS *
 ********************/
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
    } else if (eligMap.has(normalizeMemberID(result.memberID))) {
      detailsCell = `<button class="details-btn show-all-eligibilities" data-member="${normalizeMemberID(result.memberID)}" data-clinicians="${(result.clinicians || [result.clinician || '']).join(',')}">View All</button>`;
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
    if (result.remarks.length > 0) console.log('Rendering packageName:', result.packageName);
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

  initEligibilityModal(results, eligMap);  // updated call
}

function initEligibilityModal(results, eligMap) {
  const existingModal = document.getElementById('eligibilityModal');
  if (existingModal) existingModal.remove();

  const modalHTML = `
    <div id="eligibilityModal" class="modal hidden">
      <div class="modal-content eligibility-modal">
        <span class="close">&times;</span>
        <div class="modal-scrollable">
          <h3>Eligibility Details</h3>
          <div id="eligibilityModalContent" class="eligibility-details-container"></div>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  const modal = document.getElementById('eligibilityModal');
  const modalContent = document.getElementById('eligibilityModalContent');
  const closeBtn = modal.querySelector('.close');

  // Individual eligibility match
  document.querySelectorAll('.eligibility-details').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = parseInt(btn.dataset.index);
      const record = results[index].fullEligibilityRecord;
      const memberID = results[index].memberID;

      if (record) {
        modalContent.innerHTML = formatEligibilityDetails(record, memberID);
        modal.classList.remove('hidden');
      }
    });
  });

  // Show all eligibilities under a member ID
  document.querySelectorAll('.show-all-eligibilities').forEach(btn => {
    btn.addEventListener('click', () => {
      const memberID = btn.dataset.member;
      const claimClinicians = btn.dataset.clinicians?.split(',').map(normalizeClinician);
      const eligibilities = [...(eligMap.get(memberID) || [])];

      eligibilities.sort((a, b) => {
        const dateA = DateHandler.parse(a['Answered On'] || a['Ordered On']);
        const dateB = DateHandler.parse(b['Answered On'] || b['Ordered On']);
        return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
      });

      const details = eligibilities.map((e, idx) => {
        return `
          <table class="eligibility-details">
            <tbody>
              <tr><th>#${idx + 1}</th><td></td></tr>
              <tr><th>Eligibility Request Number</th><td>${e['Eligibility Request Number']}</td></tr>
              <tr><th>Answered On</th><td>${DateHandler.format(DateHandler.parse(e['Answered On']))}</td></tr>
              <tr><th>Ordered On</th><td>${DateHandler.format(DateHandler.parse(e['Ordered On']))}</td></tr>
              <tr><th>Status</th><td>${e.Status}</td></tr>
              <tr><th>Clinician</th><td>${e.Clinician}</td></tr>
              <tr><th>Claim Clinician(s)</th><td>${claimClinicians.join(', ')}</td></tr>
              <tr><th>Service Category</th><td>${e['Service Category']}</td></tr>
              <tr><th>Package</th><td>${e['Package Name']}</td></tr>
              <tr><th>Payer Name</th><td>${e['Provider Name']}</td></tr>
            </tbody>
          </table>
        `;
      }).join('<hr>');

      modalContent.innerHTML = `
        <div class="form-row">
          <strong>Member ID:</strong> ${memberID}
        </div>
        ${details}
      `;
      modal.classList.remove('hidden');
    });
  });

  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.add('hidden');
  });
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
      xlsData = normalizeReportData(rawData).filter(r => r.claimID && r.claimID.trim() !== '');
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

    renderResults(results, eligMap);  // ✅ Pass eligMap here
    updateStatus(`Processed ${results.length} claims`);
  } catch (error) {
    console.error('Processing error:', error);
    updateStatus('Processing failed');
    resultsContainer.innerHTML = `<div class="error">${error.message}</div>`;
  }
}

function handleExportInvalidClick() {
  alert('Export functionality will be implemented in next version');
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
