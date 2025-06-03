// Global declarations and initializations

// Reference to HTML input elements for the Excel files
const insurerInput = document.getElementById('insurerExcelInput');
const openJetInput = document.getElementById('openJetExcelInput');
const clinicianStatusInput = document.getElementById('clinicianStatusExcelInput');

// Data containers to hold parsed Excel data
let insurerData = [];
let openJetData = [];
let clinicianStatusData = [];

// Utility function to convert Excel serial date to JS Date object
function excelDateToJSDate(serial) {
  // Excel's date origin is 1 Jan 1900, and serial days since then
  // JavaScript Date starts at 1 Jan 1970, so adjust accordingly
  // Excel mistakenly treats 1900 as leap year, so subtract 1 day offset
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400; // seconds in a day
  const date_info = new Date(utc_value * 1000);
  const fractional_day = serial - Math.floor(serial) + 0.0000001;

  let total_seconds = Math.floor(86400 * fractional_day);
  let seconds = total_seconds % 60;
  total_seconds -= seconds;
  let hours = Math.floor(total_seconds / (60 * 60));
  let minutes = Math.floor(total_seconds / 60) % 60;

  return new Date(
    date_info.getFullYear(),
    date_info.getMonth(),
    date_info.getDate(),
    hours,
    minutes,
    seconds
  );
}

// ------------------------------
// 1. Handler for Insurer Excel Input
// ------------------------------
insurerInput.addEventListener('change', function (event) {
  const file = event.target.files[0];
  if (!file) {
    console.log('No file selected for Insurer input.');
    return;
  }
  
  const reader = new FileReader();
  reader.onload = function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    
    // Assuming the insurer data is in the first sheet
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    // Convert sheet to JSON
    insurerData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
    
    // Log for debug
    console.log('Insurer Excel Data loaded:', insurerData);
    
    // TODO: Trigger any processing that depends on insurerData being loaded
  };
  
  reader.readAsArrayBuffer(file);
});

// ------------------------------
// 2. Handler for Open Jet Excel Input
// ------------------------------
openJetInput.addEventListener('change', function (event) {
  const file = event.target.files[0];
  if (!file) {
    console.log('No file selected for Open Jet input.');
    return;
  }
  
  const reader = new FileReader();
  reader.onload = function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    
    // The Open Jet Excel data is assumed to be in the SECOND sheet (index 1)
    if (workbook.SheetNames.length < 2) {
      console.error('Open Jet Excel file does not contain a second sheet.');
      return;
    }
    
    const secondSheetName = workbook.SheetNames[1];
    const worksheet = workbook.Sheets[secondSheetName];
    
    // Convert sheet to JSON
    openJetData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
    
    // Log for debug
    console.log('Open Jet Excel Data loaded (Sheet 2):', openJetData);
    
    // TODO: Trigger any processing that depends on openJetData being loaded
  };
  
  reader.readAsArrayBuffer(file);
});

// ------------------------------
// 3. Handler for Clinician Status Excel Input
// ------------------------------

// This handler reads the Clinician Status Excel sheet which includes:
// License Number, Facility License Number, Effective Date, Status, etc.
// We will convert the Effective Date strings into JS Date objects for comparisons

clinicianStatusInput.addEventListener('change', function (event) {
  const file = event.target.files[0];
  if (!file) {
    console.log('No file selected for Clinician Status input.');
    return;
  }
  
  const reader = new FileReader();
  reader.onload = function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    
    // Assuming data is in the first sheet
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    // Raw data as JSON, with empty cells replaced with ''
    let rawData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
    
    // Mapping for month abbreviations to numbers
    const monthMap = {
      Jan: 0,
      Feb: 1,
      Mar: 2,
      Apr: 3,
      May: 4,
      Jun: 5,
      Jul: 6,
      Aug: 7,
      Sep: 8,
      Oct: 9,
      Nov: 10,
      Dec: 11,
    };
    
    // Process each row to parse Effective Date into Date object
    clinicianStatusData = rawData.map((row) => {
      // Expected format for 'Effective Date' is something like "01 Jan 2023"
      const rawDateStr = row['Effective Date'];
      
      let parsedDate = null;
      if (typeof rawDateStr === 'string' && rawDateStr.trim() !== '') {
        // Split date string into parts, example: '01 Jan 2023'
        const parts = rawDateStr.trim().split(' ');
        if (parts.length === 3) {
          const day = parseInt(parts[0], 10);
          const monthStr = parts[1];
          const year = parseInt(parts[2], 10);
          const monthNum = monthMap[monthStr];
          if (!isNaN(day) && !isNaN(monthNum) && !isNaN(year)) {
            parsedDate = new Date(year, monthNum, day);
          } else {
            console.warn(`Invalid date components in row: ${JSON.stringify(row)}`);
          }
        } else {
          console.warn(`Unexpected date format in 'Effective Date': ${rawDateStr}`);
        }
      } else if (typeof rawDateStr === 'number') {
        // Sometimes Excel stores dates as serial numbers, convert them
        parsedDate = excelDateToJSDate(rawDateStr);
      }
      
      return {
        ...row,
        EffectiveDateParsed: parsedDate,
      };
    });
    
    console.log('Clinician Status Excel Data loaded with parsed dates:', clinicianStatusData);
    
    // TODO: Trigger any processing that depends on clinicianStatusData being loaded
  };
  
  reader.readAsArrayBuffer(file);
});

// ------------------------------
// Utility: Format Date as YYYY-MM-DD string
// ------------------------------
function formatDate(date) {
  if (!(date instanceof Date)) return '';
  const y = date.getFullYear();
  const m = ('0' + (date.getMonth() + 1)).slice(-2);
  const d = ('0' + date.getDate()).slice(-2);
  return `${y}-${m}-${d}`;
}

// ------------------------------
// Utility: Compare two dates ignoring time (only date part)
// Returns:
//   0 if dates equal,
//   negative if date1 < date2,
//   positive if date1 > date2
// ------------------------------
function compareDates(date1, date2) {
  const d1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate());
  const d2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate());
  return d1 - d2;
}

// ------------------------------
// Validate a single clinician license status given Activity Date and Provider License Number
// ------------------------------
// Arguments:
//   clinicianLicenseNumber (string) - License Number of clinician to validate
//   providerFacilityLicenseNumber (string) - Facility License Number from XML Claim
//   activityDate (Date) - Date of the Activity to validate against
//
// Returns:
//   { valid: boolean, reason: string }
//   - valid is false if status is inactive or no matching license found
//   - reason provides explanatory text for logging or UI display
// ------------------------------
function validateClinicianStatus(clinicianLicenseNumber, providerFacilityLicenseNumber, activityDate) {
  // Filter clinicianStatusData for rows matching License Number AND Facility License Number
  const relevantRows = clinicianStatusData.filter(row =>
    row['License Number'] === clinicianLicenseNumber &&
    row['Facility License Number'] === providerFacilityLicenseNumber
  );

  if (relevantRows.length === 0) {
    return {
      valid: false,
      reason: `No status data found for License Number ${clinicianLicenseNumber} and Facility License Number ${providerFacilityLicenseNumber}`
    };
  }

  // From relevant rows, find those with EffectiveDateParsed <= activityDate
  const validDateRows = relevantRows.filter(row => {
    if (row.EffectiveDateParsed instanceof Date) {
      return compareDates(row.EffectiveDateParsed, activityDate) <= 0;
    }
    return false;
  });

  if (validDateRows.length === 0) {
    return {
      valid: false,
      reason: `No status row with Effective Date before or on ${formatDate(activityDate)} found`
    };
  }

  // Find the row with the latest EffectiveDateParsed before or on activityDate
  let latestRow = validDateRows[0];
  validDateRows.forEach(row => {
    if (row.EffectiveDateParsed > latestRow.EffectiveDateParsed) {
      latestRow = row;
    }
  });

  // Check if status is 'Inactive' or otherwise invalid
  if (latestRow['Status'] && latestRow['Status'].toLowerCase() === 'inactive') {
    return {
      valid: false,
      reason: `License status is Inactive as of ${formatDate(latestRow.EffectiveDateParsed)}`
    };
  }

  // Passed all checks, license is valid at activity date
  return {
    valid: true,
    reason: `Active license found with status '${latestRow['Status']}' effective from ${formatDate(latestRow.EffectiveDateParsed)}`
  };
}

// ------------------------------
// Main function to process XML Claims and validate clinician statuses
// Arguments:
//   xmlDoc - parsed XML Document of claims
//   outputElement - DOM element where results will be displayed (e.g., a table or div)
// ------------------------------
function processClaimsAndValidate(xmlDoc, outputElement) {
  if (!xmlDoc) {
    console.error('No XML Document provided for claim processing.');
    return;
  }

  // Clear previous output
  outputElement.innerHTML = '';

  // Extract <Claim> elements - assuming XML structure contains Claim.Submission > Claim elements
  const claims = xmlDoc.getElementsByTagName('Claim');

  if (claims.length === 0) {
    outputElement.textContent = 'No claims found in the uploaded XML.';
    return;
  }

  // Create a table to show results
  const table = document.createElement('table');
  table.classList.add('results-table');
  const headerRow = document.createElement('tr');
  [
    'Claim Number',
    'Activity Start Date',
    'Clinician License Number',
    'Provider Facility License Number',
    'Validation Result',
    'Remarks'
  ].forEach(headerText => {
    const th = document.createElement('th');
    th.textContent = headerText;
    headerRow.appendChild(th);
  });
  table.appendChild(headerRow);

  // Iterate through claims
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    
    // Extract Claim Number
    const claimNumberElem = claim.getElementsByTagName('ClaimNumber')[0];
    const claimNumber = claimNumberElem ? claimNumberElem.textContent.trim() : `Claim#${i + 1}`;

    // Extract Provider Facility License Number from Claim Header or Provider block
    // Assuming XML has a Provider block with LicenseNumber or FacilityLicenseNumber
    const providerLicenseElem = claim.getElementsByTagName('ProviderLicenseNumber')[0] || claim.getElementsByTagName('FacilityLicenseNumber')[0];
    const providerFacilityLicenseNumber = providerLicenseElem ? providerLicenseElem.textContent.trim() : '';

    // Extract Activities
    const activities = claim.getElementsByTagName('Activity');
    if (activities.length === 0) {
      // No activities found - log in table
      const row = document.createElement('tr');
      [claimNumber, '-', '-', '-', 'No activities found', ''].forEach(text => {
        const td = document.createElement('td');
        td.textContent = text;
        row.appendChild(td);
      });
      table.appendChild(row);
      continue;
    }

    // Iterate over activities inside the claim
    for (let j = 0; j < activities.length; j++) {
      const activity = activities[j];

      // Extract Activity Start Date (Expected format: YYYY-MM-DD or something else)
      const activityStartDateElem = activity.getElementsByTagName('StartDate')[0];
      if (!activityStartDateElem) {
        continue; // skip activity if no start date
      }
      const activityStartDateStr = activityStartDateElem.textContent.trim();
      const activityStartDate = new Date(activityStartDateStr);
      if (isNaN(activityStartDate.getTime())) {
        continue; // invalid date, skip
      }

      // Extract Clinician License Number from Activity
      const clinicianLicenseElem = activity.getElementsByTagName('ClinicianLicenseNumber')[0];
      if (!clinicianLicenseElem) {
        continue; // skip if no clinician license info
      }
      const clinicianLicenseNumber = clinicianLicenseElem.textContent.trim();

      // Perform the validation for this clinician at this activity date
      const validation = validateClinicianStatus(
        clinicianLicenseNumber,
        providerFacilityLicenseNumber,
        activityStartDate
      );

      // Append row with validation results
      const row = document.createElement('tr');
      [
        claimNumber,
        formatDate(activityStartDate),
        clinicianLicenseNumber,
        providerFacilityLicenseNumber,
        validation.valid ? 'Valid' : 'Invalid',
        validation.reason
      ].forEach(text => {
        const td = document.createElement('td');
        td.textContent = text;
        row.appendChild(td);
      });
      table.appendChild(row);
    }
  }

  outputElement.appendChild(table);
}

// ------------------------------
// Example Usage
// ------------------------------

// You can call processClaimsAndValidate(xmlDoc, document.getElementById('resultsContainer'));
// after XML file input and Excel inputs are loaded and parsed.

// ------------------------------
// Additional Notes:
// - Ensure the XML claim file is parsed as XMLDocument before calling processClaimsAndValidate
// - The Clinician Status Excel should be loaded before validation is triggered
// - The Provider Facility License Number is critical and must be present in the XML claims for proper validation
// - The function logs detailed reasons for each validation result
// ------------------------------
// ------------------------------
// File Input Handlers and Event Listeners
// ------------------------------

// DOM Elements for file inputs
const insurerExcelInput = document.getElementById('insurerExcelInput');
const openJetExcelInput = document.getElementById('openJetExcelInput');
const clinicianStatusExcelInput = document.getElementById('clinicianStatusExcelInput');
const xmlClaimInput = document.getElementById('xmlClaimInput');
const validateButton = document.getElementById('validateButton');
const resultsContainer = document.getElementById('resultsContainer');

// Variables to hold loaded data
let insurerData = [];
let openJetData = [];
let clinicianStatusData = [];
let xmlDoc = null;

// ------------------------------
// Load Excel file helper function
// Uses FileReader + XLSX.js to parse the first sheet
// Returns a Promise resolving to JSON array of rows
// ------------------------------
function loadExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
      resolve(jsonData);
    };

    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file);
  });
}

// ------------------------------
// Parse XML file helper function
// ------------------------------
function parseXmlFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const parser = new DOMParser();
      const xml = parser.parseFromString(e.target.result, 'application/xml');

      // Check for parse errors
      const parserError = xml.getElementsByTagName('parsererror');
      if (parserError.length > 0) {
        reject(new Error('Error parsing XML file'));
        return;
      }
      resolve(xml);
    };

    reader.onerror = (err) => reject(err);
    reader.readAsText(file);
  });
}

// ------------------------------
// Event Handlers for Excel file inputs
// Each loads their respective Excel file data and stores globally
// ------------------------------
insurerExcelInput.addEventListener('change', async (event) => {
  if (event.target.files.length === 0) return;
  try {
    insurerData = await loadExcelFile(event.target.files[0]);
    console.log('Insurer Excel loaded:', insurerData.length, 'rows');
    alert('Insurer Excel loaded successfully.');
  } catch (error) {
    console.error('Error loading Insurer Excel:', error);
    alert('Failed to load Insurer Excel.');
  }
});

openJetExcelInput.addEventListener('change', async (event) => {
  if (event.target.files.length === 0) return;
  try {
    openJetData = await loadExcelFile(event.target.files[0]);
    console.log('Open Jet Excel loaded:', openJetData.length, 'rows');

    // Parse EffectiveDate fields into Date objects and add property EffectiveDateParsed
    openJetData.forEach(row => {
      if (row['EffectiveDate']) {
        row.EffectiveDateParsed = new Date(row['EffectiveDate']);
      }
    });

    alert('Open Jet Excel loaded successfully.');
  } catch (error) {
    console.error('Error loading Open Jet Excel:', error);
    alert('Failed to load Open Jet Excel.');
  }
});

clinicianStatusExcelInput.addEventListener('change', async (event) => {
  if (event.target.files.length === 0) return;
  try {
    clinicianStatusData = await loadExcelFile(event.target.files[0]);
    console.log('Clinician Status Excel loaded:', clinicianStatusData.length, 'rows');

    // Parse Effective Date for clinician status rows
    clinicianStatusData.forEach(row => {
      if (row['Effective Date']) {
        row.EffectiveDateParsed = new Date(row['Effective Date']);
      }
    });

    alert('Clinician Status Excel loaded successfully.');
  } catch (error) {
    console.error('Error loading Clinician Status Excel:', error);
    alert('Failed to load Clinician Status Excel.');
  }
});

// ------------------------------
// Event Handler for XML Claim input
// ------------------------------
xmlClaimInput.addEventListener('change', async (event) => {
  if (event.target.files.length === 0) return;
  try {
    xmlDoc = await parseXmlFile(event.target.files[0]);
    console.log('XML Claim file loaded');
    alert('XML Claim file loaded successfully.');
  } catch (error) {
    console.error('Error loading XML Claim file:', error);
    alert('Failed to load XML Claim file.');
  }
});

// ------------------------------
// Validate Button Click Handler
// Triggers validation only if all inputs are loaded
// ------------------------------
validateButton.addEventListener('click', () => {
  if (insurerData.length === 0) {
    alert('Please load the Insurer Excel file first.');
    return;
  }
  if (openJetData.length === 0) {
    alert('Please load the Open Jet Excel file first.');
    return;
  }
  if (clinicianStatusData.length === 0) {
    alert('Please load the Clinician Status Excel file first.');
    return;
  }
  if (!xmlDoc) {
    alert('Please load the XML Claim file first.');
    return;
  }

  // Clear previous results
  resultsContainer.innerHTML = '';

  // Call the main processing and validation function
  processClaimsAndValidate(xmlDoc, resultsContainer);
});

// ------------------------------
// Additional Fixes and Comments:
// - Added detailed parsing of date fields after Excel loading for all relevant files
// - Added alerts and console logs for better user feedback on file loading
// - Added XML parsing error detection and handling
// - Added checks to ensure all required files are loaded before validation
// - Used global variables to hold parsed data for validation functions
// - File inputs and button should be defined in the HTML with matching IDs
// ------------------------------
