/*******************************
 * GLOBAL VARIABLES & CONSTANTS *
 *******************************/
console.log('Initializing global variables and constants');
const VALID_SERVICES = ['Consultation', 'Dental Services', 'Physiotherapy'];
const DATE_KEYS = ['Date', 'On'];
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

// Application state
let xmlData = null;
let xlsData = null;
let eligData = null;
const usedEligibilities = new Set();
console.log('Global variables initialized');

// DOM Elements
console.log('Initializing DOM elements');
const xmlInput = document.getElementById("xmlFileInput");
const reportInput = document.getElementById("reportFileInput");
const eligInput = document.getElementById("eligibilityFileInput");
const processBtn = document.getElementById("processBtn");
const status = document.getElementById("uploadStatus");
const resultsContainer = document.getElementById("results");
console.log('DOM elements initialized');

/*************************
 * DATE HANDLING UTILITIES *
 *************************/
console.log('Creating DateHandler utility');
const DateHandler = {
  parse: function(input) {
    console.debug(`Parsing date input: ${input}`);
    if (!input) {
      console.debug('Empty date input');
      return null;
    }
    if (input instanceof Date) {
      console.debug('Input is already Date object');
      return isNaN(input) ? null : input;
    }
    if (typeof input === 'number') {
      console.debug('Parsing Excel serial date');
      return this._parseExcelDate(input);
    }
    
    const cleanStr = input.toString().trim().replace(/[,.]/g, '');
    console.debug(`Cleaned date string: ${cleanStr}`);
    return this._parseStringDate(cleanStr) || new Date(cleanStr);
  },

  format: function(date) {
    if (!date) {
      console.debug('No date to format');
      return '';
    }
    const d = date.getDate().toString().padStart(2, '0');
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const y = date.getFullYear();
    const formatted = `${d}/${m}/${y}`;
    console.debug(`Formatted date: ${formatted}`);
    return formatted;
  },

  isSameDay: function(date1, date2) {
    if (!date1 || !date2) {
      console.debug('One or both dates missing for comparison');
      return false;
    }
    const same = date1.getDate() === date2.getDate() && 
                date1.getMonth() === date2.getMonth() && 
                date1.getFullYear() === date2.getFullYear();
    console.debug(`Date comparison result: ${same}`);
    return same;
  },

  _parseExcelDate: function(serial) {
    console.debug(`Parsing Excel serial date: ${serial}`);
    const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return serial >= 60 ? new Date(date.getTime() + 86400000) : date;
  },

  _parseStringDate: function(dateStr) {
    console.debug(`Attempting to parse date string: ${dateStr}`);
    
    const dmyMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (dmyMatch) {
      console.debug('DMY format matched');
      return new Date(dmyMatch[3], dmyMatch[2]-1, dmyMatch[1]);
    }
    
    const mdyMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (mdyMatch) {
      console.debug('MDY format matched');
      return new Date(mdyMatch[3], mdyMatch[1]-1, mdyMatch[2]);
    }
    
    const textMatch = dateStr.match(/^(\d{1,2})[\/\- ]([a-z]{3})[\/\- ](\d{2,4})$/i);
    if (textMatch) {
      console.debug('Text month format matched');
      const monthIndex = MONTHS.indexOf(textMatch[2].toLowerCase().substr(0,3));
      if (monthIndex >= 0) return new Date(textMatch[3], monthIndex, textMatch[1]);
    }
    
    console.debug('No known date format matched');
    return null;
  }
};
console.log('DateHandler utility created');

/*****************************
 * DATA NORMALIZATION FUNCTIONS *
 *****************************/
function normalizeMemberID(id) {
  console.debug(`Normalizing member ID: ${id}`);
  if (!id) {
    console.debug('Empty member ID');
    return '';
  }
  const normalized = id.toString().replace(/\D/g, '').replace(/^0+/, '');
  console.debug(`Normalized to: ${normalized}`);
  return normalized;
}

function normalizeClinician(name) {
  console.debug(`Normalizing clinician name: ${name}`);
  if (!name) {
    console.debug('Empty clinician name');
    return '';
  }
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  console.debug(`Normalized to: ${normalized}`);
  return normalized;
}

/*******************************
 * ELIGIBILITY MATCHING FUNCTIONS *
 *******************************/
function findEligibilityForClaim(eligibilities, claimDate, memberID) {
  console.group(`Finding eligibility for claim - Member: ${memberID}, Date: ${DateHandler.format(claimDate)}`);
  
  if (!claimDate || !memberID) {
    console.debug('Invalid claim date or member ID');
    console.groupEnd();
    return null;
  }

  for (const e of eligibilities) {
    const reqNum = e['Eligibility Request Number'];
    console.debug(`Checking eligibility request: ${reqNum}`);

    if (usedEligibilities.has(reqNum)) {
      console.debug('Eligibility already used - skipping');
      continue;
    }
    
    const eligID = normalizeMemberID(e['Card Number / DHA Member ID']);
    console.debug(`Eligibility member ID: ${eligID}`);
    
    if (eligID !== memberID) {
      console.debug('Member ID mismatch - skipping');
      continue;
    }
    
    const eligDate = DateHandler.parse(e['Answered On'] || e['Ordered On']);
    console.debug(`Eligibility date: ${DateHandler.format(eligDate)}`);
    
    if (!DateHandler.isSameDay(claimDate, eligDate)) {
      console.debug('Date mismatch - skipping');
      continue;
    }
    
    console.debug('Found matching eligibility');
    usedEligibilities.add(reqNum);
    console.groupEnd();
    return e;
  }

  console.debug('No matching eligibility found');
  console.groupEnd();
  return null;
}

function checkClinicianMatch(claimClinicians, eligClinician) {
  console.group('Checking clinician match');
  console.debug('Claim clinicians:', claimClinicians);
  console.debug('Eligibility clinician:', eligClinician);

  if (!eligClinician || !claimClinicians?.length) {
    console.debug('No clinician data to compare');
    console.groupEnd();
    return true;
  }

  const normElig = normalizeClinician(eligClinician);
  const matchFound = claimClinicians.some(c => normalizeClinician(c) === normElig);

  console.debug(`Clinician match ${matchFound ? 'found' : 'not found'}`);
  console.groupEnd();
  return matchFound;
}

/************************
 * VALIDATION FUNCTIONS *
 ************************/
function validateXmlClaims(xmlClaims, eligData) {
  console.group('Validating XML claims');
  console.log(`Processing ${xmlClaims.length} XML claims`);
  
  const results = xmlClaims.map((claim, index) => {
    console.group(`Claim ${index + 1}: ${claim.claimID}`);
    
    const claimDate = DateHandler.parse(claim.encounterStart);
    console.debug(`Claim date: ${DateHandler.format(claimDate)}`);
    
    const memberID = normalizeMemberID(claim.memberID);
    console.debug(`Member ID: ${memberID}`);
    
    const eligibility = findEligibilityForClaim(eligData, claimDate, memberID);
    console.debug('Eligibility record:', eligibility);

    let status = 'invalid';
    const remarks = [];
    
    if (!eligibility) {
      remarks.push('No matching eligibility');
      console.debug('No eligibility found');
    } else if (eligibility.Status?.toLowerCase() !== 'eligible') {
      remarks.push(`Invalid status: ${eligibility.Status}`);
      console.debug('Ineligible status');
    } else if (!checkClinicianMatch(claim.clinicians, eligibility.Clinician)) {
      status = 'unknown';
      remarks.push('Clinician mismatch');
      console.debug('Clinician mismatch');
    } else {
      status = 'valid';
      console.debug('Valid claim');
    }

    const result = {
      claimID: claim.claimID,
      memberID: claim.memberID,
      encounterStart: DateHandler.format(claimDate),
      packageName: eligibility?.['Package Name'] || '',
      status: eligibility?.Status || '',
      remarks,
      finalStatus: status,
      fullEligibilityRecord: eligibility
    };

    console.debug('Validation result:', result);
    console.groupEnd();
    return result;
  });

  console.log(`Validation complete. ${results.length} claims processed`);
  console.groupEnd();
  return results;
}

function validateReportClaims(reportData, eligData) {
  console.group('Validating report claims');
  console.log(`Processing ${reportData.length} report rows`);
  
  const results = reportData.map((row, index) => {
    console.group(`Row ${index + 1}: ${row.claimID}`);
    
    const claimDate = DateHandler.parse(row.claimDate);
    console.debug(`Claim date: ${DateHandler.format(claimDate)}`);
    
    const memberID = normalizeMemberID(row.memberID);
    console.debug(`Member ID: ${memberID}`);
    
    const eligibility = findEligibilityForClaim(eligData, claimDate, memberID);
    console.debug('Eligibility record:', eligibility);

    let status = 'invalid';
    const remarks = [];
    
    if (!eligibility) {
      remarks.push('No matching eligibility');
      console.debug('No eligibility found');
    } else if (eligibility.Status?.toLowerCase() !== 'eligible') {
      remarks.push(`Invalid status: ${eligibility.Status}`);
      console.debug('Ineligible status');
    } else {
      status = 'valid';
      console.debug('Valid claim');
    }

    const result = {
      claimID: row.claimID,
      memberID: row.memberID,
      encounterStart: DateHandler.format(claimDate),
      packageName: eligibility?.['Package Name'] || '',
      status: eligibility?.Status || '',
      remarks,
      finalStatus: status,
      fullEligibilityRecord: eligibility
    };

    console.debug('Validation result:', result);
    console.groupEnd();
    return result;
  });

  console.log(`Validation complete. ${results.length} rows processed`);
  console.groupEnd();
  return results;
}

/*********************
 * FILE PARSING FUNCTIONS *
 *********************/
async function parseXmlFile(file) {
  console.group(`Parsing XML file: ${file.name}`);
  try {
    console.log('Reading file content');
    const text = await file.text();
    
    console.log('Parsing XML document');
    const xmlDoc = new DOMParser().parseFromString(text, "application/xml");
    
    console.log('Extracting claims');
    const claims = Array.from(xmlDoc.querySelectorAll("Claim")).map(claim => {
      const claimID = claim.querySelector("ID")?.textContent.trim() || '';
      const memberID = claim.querySelector("MemberID")?.textContent.trim() || '';
      const encounterStart = claim.querySelector("Encounter Start")?.textContent.trim();
      const clinicians = Array.from(claim.querySelectorAll("Clinician")).map(c => c.textContent.trim());
      
      console.debug(`Parsed claim: ${claimID}`);
      return { claimID, memberID, encounterStart, clinicians };
    });

    console.log(`Successfully parsed ${claims.length} claims`);
    console.groupEnd();
    return { claims };
  } catch (error) {
    console.error('XML parsing error:', error);
    console.groupEnd();
    throw new Error('Failed to parse XML file');
  }
}

async function parseExcelFile(file) {
  console.group(`Parsing Excel file: ${file.name}`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = function(e) {
      try {
        console.log('Processing Excel data');
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        
        console.log('Getting first worksheet');
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        
        console.log('Converting to JSON');
        const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        
        console.log(`Parsed ${jsonData.length} rows`);
        console.groupEnd();
        resolve(jsonData);
      } catch (error) {
        console.error('Excel parsing error:', error);
        console.groupEnd();
        reject(error);
      }
    };
    
    reader.onerror = () => {
      console.error('FileReader error:', reader.error);
      console.groupEnd();
      reject(reader.error);
    };
    
    console.log('Reading file as array buffer');
    reader.readAsArrayBuffer(file);
  });
}

async function parseCsvFile(file) {
  console.group(`Parsing CSV file: ${file.name}`);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = function(e) {
      try {
        console.log('Processing CSV data');
        const text = e.target.result;
        const workbook = XLSX.read(text, { type: 'string' });
        
        console.log('Getting first worksheet');
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        
        console.log('Getting all rows');
        const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        console.debug('First few rows:', allRows.slice(0, 3));
        
        // Determine if this is CSV report (headers on row 4) or ClinicPro (headers on row 1)
        const isCsvReport = allRows[3]?.some(h => h.includes('Pri. Claim No'));
        console.log(`Detected format: ${isCsvReport ? 'CSV Report' : 'ClinicPro'}`);
        
        let headers, dataRows;
        if (isCsvReport) {
          console.log('Processing CSV report format');
          headers = allRows[3];
          dataRows = allRows.slice(4);
        } else {
          console.log('Processing ClinicPro format');
          headers = allRows[0];
          dataRows = allRows.slice(1);
        }
        
        console.debug('Headers:', headers);
        
        // Map rows to objects using proper headers
        const jsonData = dataRows.map(row => {
          const obj = {};
          headers.forEach((header, index) => {
            obj[header] = row[index] || '';
          });
          return obj;
        });
        
        console.log(`Parsed ${jsonData.length} data rows`);
        console.groupEnd();
        resolve(jsonData);
      } catch (error) {
        console.error('CSV parsing error:', error);
        console.groupEnd();
        reject(error);
      }
    };
    
    reader.onerror = () => {
      console.error('FileReader error:', reader.error);
      console.groupEnd();
      reject(reader.error);
    };
    
    console.log('Reading file as text');
    reader.readAsText(file);
  });
}

function normalizeReportData(rawData) {
  console.group('Normalizing report data');
  
  // Check if data is from CSV report or ClinicPro by looking for distinctive columns
  const isCsvReport = rawData[0]?.hasOwnProperty('Pri. Claim No');
  console.log(`Report type: ${isCsvReport ? 'CSV Report' : 'ClinicPro'}`);
  
  const normalizedData = rawData.map(row => {
    if (isCsvReport) {
      // CSV Report format
      return {
        claimID: row['Pri. Claim No'] || '',
        memberID: row['Pri. Patient Insurance Card No'] || '',
        claimDate: row['Encounter Date'] || '',
        clinician: row['Clinician License'] || '',
        insuranceCompany: row['Pri. Payer Name'] || '',
        department: row['Department'] || ''
      };
    } else {
      // ClinicPro format
      return {
        claimID: row['ClaimID'] || '',
        memberID: row['Member ID'] || '',
        claimDate: row['ClaimDate'] || '',
        clinician: row['Clinician'] || '',
        insuranceCompany: row['Insurance Company'] || '',
        department: row['Institution'] || ''
      };
    }
  });
  
  console.debug('First normalized row:', normalizedData[0]);
  console.log(`Normalized ${normalizedData.length} rows`);
  console.groupEnd();
  return normalizedData;
}

/********************
 * UI RENDERING FUNCTIONS *
 ********************/
function renderResults(results) {
  console.group('Rendering results');
  console.log(`Displaying ${results.length} results`);
  
  resultsContainer.innerHTML = '';

  if (!results || results.length === 0) {
    console.log('No results to display');
    resultsContainer.innerHTML = '<div class="no-results">No claims to display</div>';
    console.groupEnd();
    return;
  }

  const table = document.createElement('table');
  table.className = 'results-table';

  // Create table header
  console.log('Creating table header');
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>Claim ID</th>
      <th>Member ID</th>
      <th>Encounter Date</th>
      <th>Package</th>
      <th>Status</th>
      <th>Remarks</th>
    </tr>
  `;
  table.appendChild(thead);

  // Create table body
  console.log('Creating table body');
  const tbody = document.createElement('tbody');
  
  const statusCounts = { valid: 0, invalid: 0, unknown: 0 };
  
  results.forEach(result => {
    statusCounts[result.finalStatus]++;
    
    const row = document.createElement('tr');
    row.className = result.finalStatus;
    
    row.innerHTML = `
      <td>${result.claimID}</td>
      <td>${result.memberID}</td>
      <td>${result.encounterStart}</td>
      <td>${result.packageName}</td>
      <td>${result.status}</td>
      <td>${result.remarks.join('; ')}</td>
    `;
    
    tbody.appendChild(row);
  });
  
  table.appendChild(tbody);
  resultsContainer.appendChild(table);
  
  console.log('Results breakdown:', statusCounts);
  console.groupEnd();
}

function updateStatus(message) {
  console.debug(`Updating status: ${message}`);
  status.textContent = message || 'Ready';
}

/********************
 * EVENT HANDLERS *
 ********************/
async function handleFileUpload(event, type) {
  const file = event.target.files[0];
  if (!file) {
    console.log('No file selected');
    return;
  }

  try {
    console.group(`Processing ${type} file: ${file.name}`);
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
      xlsData = normalizeReportData(rawData);
      updateStatus(`Loaded ${xlsData.length} report rows`);
    }
    
    console.groupEnd();
  } catch (error) {
    console.error(`${type} file error:`, error);
    updateStatus(`Error loading ${type} file`);
    console.groupEnd();
  }
}

async function handleProcessClick() {
  console.group('Process button clicked');
  
  if (!eligData) {
    const msg = 'Error: Missing eligibility file';
    console.error(msg);
    updateStatus(msg);
    alert('Please upload eligibility file first');
    console.groupEnd();
    return;
  }

  try {
    updateStatus('Processing...');
    console.log('Starting validation');
    
    const results = xmlData 
      ? validateXmlClaims(xmlData.claims, eligData)
      : validateReportClaims(xlsData, eligData);
    
    console.log('Rendering results');
    renderResults(results);
    
    const msg = `Processed ${results.length} claims`;
    updateStatus(msg);
    console.log(msg);
  } catch (error) {
    console.error('Processing error:', error);
    updateStatus('Processing failed');
    resultsContainer.innerHTML = `<div class="error">${error.message}</div>`;
  }
  
  console.groupEnd();
}

/********************
 * INITIALIZATION *
 ********************/
function initializeEventListeners() {
  console.log('Initializing event listeners');
  
  xmlInput.addEventListener('change', (e) => handleFileUpload(e, 'xml'));
  reportInput.addEventListener('change', (e) => handleFileUpload(e, 'report'));
  eligInput.addEventListener('change', (e) => handleFileUpload(e, 'eligibility'));
  processBtn.addEventListener('click', handleProcessClick);
  
  console.log('Event listeners initialized');
}

document.addEventListener('DOMContentLoaded', () => {
  console.group('Application initialization');
  initializeEventListeners();
  updateStatus('Ready to process files');
  console.log('Application ready');
  console.groupEnd();
});
