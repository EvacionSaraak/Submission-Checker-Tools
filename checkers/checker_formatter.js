const combineButton = document.getElementById('combine-button');
const downloadButton = document.getElementById('download-button');
const progressBarContainer = document.getElementById('progress-bar-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const messageBox = document.getElementById('messageBox');

const eligibilityPanel = document.getElementById('eligibility-panel');
const reportingPanel = document.getElementById('reporting-panel');
const xmlPanel = document.getElementById('xml-panel');
const errorsPanel = document.getElementById('errors-panel');

const eligibilityInput = document.getElementById('eligibility-files');
const reportingInput = document.getElementById('reporting-files');
const clinicianInput = document.getElementById('clinician-files'); // NEW clinician input
const xmlInput = document.getElementById('xml-files');

// Errors panel elements
const errorsInput = document.getElementById('errors-input');
const errorsOutput = document.getElementById('errors-output');
const errorsUnmatched = document.getElementById('errors-unmatched');
const unmatchedContainer = document.getElementById('unmatched-container');
const unmatchedButtonRow = document.getElementById('unmatched-button-row');
const formatButton = document.getElementById('format-button');
const copyButton = document.getElementById('copy-button');
const copyUnmatchedButton = document.getElementById('copy-unmatched-button');
const monospaceToggle = document.getElementById('monospace-toggle');

const outputTableContainer = document.getElementById('outputTableContainer');

const worker = new Worker('checker_formatter_worker.js');

let lastWorkbookData = null;

document.getElementById('mode-selector').addEventListener('change', e => {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode === 'eligibility') {
    eligibilityPanel.classList.remove('hidden');
    reportingPanel.classList.add('hidden');
    xmlPanel.classList.add('hidden');
    errorsPanel.classList.add('hidden');
    combineButton.style.display = '';
  } else if (mode === 'reporting') {
    eligibilityPanel.classList.add('hidden');
    reportingPanel.classList.remove('hidden');
    xmlPanel.classList.add('hidden');
    errorsPanel.classList.add('hidden');
    combineButton.style.display = '';
  } else if (mode === 'xml') {
    eligibilityPanel.classList.add('hidden');
    reportingPanel.classList.add('hidden');
    xmlPanel.classList.remove('hidden');
    errorsPanel.classList.add('hidden');
    combineButton.style.display = '';
  } else if (mode === 'errors') {
    eligibilityPanel.classList.add('hidden');
    reportingPanel.classList.add('hidden');
    xmlPanel.classList.add('hidden');
    errorsPanel.classList.remove('hidden');
    combineButton.style.display = 'none';
  }
  resetUI();
});

function resetUI() {
  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  progressBarContainer.style.display = 'none';
  messageBox.textContent = '';
  outputTableContainer.innerHTML = '';
  combineButton.disabled = false;
  downloadButton.disabled = true;
  lastWorkbookData = null;
}

// XML combining function (runs in main thread where DOMParser is available)
async function combineXMLFiles(fileEntries) {
  console.log("Starting XML combining in main thread");
  if (!fileEntries || !fileEntries.length) {
    throw new Error("No XML files provided");
  }

  progressBar.style.width = '10%';
  progressText.textContent = '10%';

  const parser = new DOMParser();
  let combinedClaims = [];
  let firstXmlDoc = null;
  let parseErrors = 0;

  for (let i = 0; i < fileEntries.length; i++) {
    const entry = fileEntries[i];
    messageBox.textContent = `Processing XML file ${i + 1}/${fileEntries.length}: ${entry.name}`;
    
    try {
      // Convert ArrayBuffer to string
      const textDecoder = new TextDecoder('utf-8');
      const xmlString = textDecoder.decode(entry.buffer);
      
      // Parse the XML
      const xmlDoc = parser.parseFromString(xmlString, "text/xml");
      
      // Check for parsing errors
      const parserError = xmlDoc.querySelector('parsererror');
      if (parserError) {
        console.error(`XML parsing error in ${entry.name}:`, parserError.textContent);
        parseErrors++;
        continue;
      }
      
      // Store the first successfully parsed document as template
      if (!firstXmlDoc) {
        firstXmlDoc = xmlDoc;
      }
      
      // Extract all Claim elements that are direct children of the root
      const root = xmlDoc.documentElement;
      if (root) {
        // Get all direct child elements named "Claim"
        const children = root.children || root.childNodes;
        let claimsInFile = 0;
        for (let j = 0; j < children.length; j++) {
          const child = children[j];
          if (child.nodeType === 1 && child.tagName === 'Claim') {
            combinedClaims.push(child);
            claimsInFile++;
          }
        }
        console.log(`Found ${claimsInFile} claim(s) in ${entry.name}`);
      }
      
    } catch (err) {
      console.error(`Error processing ${entry.name}:`, err.message);
      parseErrors++;
    }
    
    const progress = 10 + (80 * (i + 1) / fileEntries.length);
    progressBar.style.width = `${Math.floor(progress)}%`;
    progressText.textContent = `${Math.floor(progress)}%`;
  }

  if (parseErrors === fileEntries.length) {
    throw new Error(`Failed to parse all ${parseErrors} XML file(s)`);
  }

  if (combinedClaims.length === 0) {
    throw new Error(`Successfully parsed ${fileEntries.length - parseErrors} file(s), but found no claims`);
  }

  console.log(`Total claims collected: ${combinedClaims.length} from ${fileEntries.length - parseErrors} file(s)`);
  progressBar.style.width = '90%';
  progressText.textContent = '90%';

  // Build the combined XML structure using the first parsed document as template
  const serializer = new XMLSerializer();
  const rootNode = firstXmlDoc.documentElement.cloneNode(true);
  
  // Remove all existing Claim children from root (only direct children)
  const children = Array.from(rootNode.children || rootNode.childNodes);
  for (const child of children) {
    if (child.nodeType === 1 && child.tagName === 'Claim') {
      rootNode.removeChild(child);
    }
  }
  
  // Update the RecordCount in Header if it exists
  const headerRecordCount = rootNode.querySelector('Header > RecordCount');
  if (headerRecordCount) {
    headerRecordCount.textContent = combinedClaims.length.toString();
  }
  
  // Add all combined claims to the root node
  combinedClaims.forEach(claim => {
    const importedClaim = rootNode.ownerDocument.importNode(claim, true);
    rootNode.appendChild(importedClaim);
  });

  // Serialize the combined XML
  const combinedXmlString = serializer.serializeToString(rootNode);
  
  // Add XML declaration
  const finalXml = '<?xml version="1.0" encoding="utf-8"?>\n' + combinedXmlString;
  
  console.log(`Combined XML created with ${combinedClaims.length} claims`);
  
  // Return the XML string as a Uint8Array
  const encoder = new TextEncoder();
  return encoder.encode(finalXml);
}

combineButton.addEventListener('click', async () => {
  try {
    messageBox.textContent = '';
    outputTableContainer.innerHTML = '';
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const inputFiles = mode === 'eligibility' ? eligibilityInput.files : 
                       mode === 'reporting' ? reportingInput.files : 
                       xmlInput.files;

    if (!inputFiles.length) {
      alert('Please upload one or more files first.');
      return;
    }

    // If reporting mode, require clinician license file too
    if (mode === 'reporting' && clinicianInput.files.length === 0) {
      alert('Please upload the clinician licenses Excel file.');
      return;
    }

    combineButton.disabled = true;
    downloadButton.disabled = true;
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    progressBarContainer.style.display = 'block';

    // Read report files
    const fileEntries = [];
    for (let i = 0; i < inputFiles.length; i++) {
      const f = inputFiles[i];
      messageBox.textContent = `Reading file ${i + 1} of ${inputFiles.length}: ${f.name}`;
      const buffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('File read error'));
        reader.readAsArrayBuffer(f);
      });
      fileEntries.push({ name: f.name, buffer });
    }

    // Read clinician licenses file if reporting mode
    let clinicianFileEntry = null;
    if (mode === 'reporting' && clinicianInput.files.length > 0) {
      const cf = clinicianInput.files[0];
      messageBox.textContent = `Reading clinician license file: ${cf.name}`;
      const clinicianBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Clinician file read error'));
        reader.readAsArrayBuffer(cf);
      });
      clinicianFileEntry = { name: cf.name, buffer: clinicianBuffer };
    }

    messageBox.textContent = 'Files read. Starting processing...';

    // Handle XML mode directly in main thread (DOMParser not available in workers)
    if (mode === 'xml') {
      try {
        const combinedXml = await combineXMLFiles(fileEntries);
        lastWorkbookData = combinedXml;
        messageBox.textContent = 'Processing complete.';
        combineButton.disabled = false;
        downloadButton.disabled = false;
        progressBar.style.width = '100%';
        progressText.textContent = '100%';
      } catch (err) {
        messageBox.textContent = 'Error: ' + err.message;
        combineButton.disabled = false;
        downloadButton.disabled = true;
        progressBar.style.width = '0%';
        progressText.textContent = '0%';
      }
      return;
    }

    // Debug log before posting message to worker
    console.log('Posting start message to worker', { mode, files: fileEntries.length, clinicianFile: clinicianFileEntry ? clinicianFileEntry.name : 'none' });

    // Post message to worker with clinician file included (for eligibility and reporting modes)
    worker.postMessage({ type: 'start', mode, files: fileEntries, clinicianFile: clinicianFileEntry });

  } catch (err) {
    messageBox.textContent = 'Error reading files: ' + err.message;
    combineButton.disabled = false;
  }
});

worker.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'log') {
    console.log('[Worker log]', msg.message);
  } else if (msg.type === 'progress') {
    const p = msg.progress;
    progressBar.style.width = `${p}%`;
    progressText.textContent = `${p}%`;
  } else if (msg.type === 'result') {
    lastWorkbookData = msg.workbookData;
    messageBox.textContent = 'Processing complete.';
    combineButton.disabled = false;
    downloadButton.disabled = false;
    progressBar.style.width = '100%';
    progressText.textContent = '100%';
  } else if (msg.type === 'error') {
    messageBox.textContent = 'Error: ' + msg.error;
    combineButton.disabled = false;
    downloadButton.disabled = true;
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
  }
};

worker.onerror = e => {
  console.error('Worker error event:', e);
  messageBox.textContent = 'Worker error: ' + e.message;
  combineButton.disabled = false;
  downloadButton.disabled = true;
  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  e.preventDefault();
};

downloadButton.addEventListener('click', () => {
  if (!lastWorkbookData) return;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  
  let blob, filename;
  const timestamp = new Date().toISOString().slice(0,19).replace(/:/g,'-');
  
  if (mode === 'xml') {
    blob = new Blob([lastWorkbookData], { type: 'application/xml' });
    filename = `combined_xml_${timestamp}.xml`;
  } else {
    blob = new Blob([lastWorkbookData], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    filename = `combined_${mode}_${timestamp}.xlsx`;
  }
  
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
});

function renderWorkbookTable(workbookUint8) {
  outputTableContainer.innerHTML = '';
  const blob = new Blob([workbookUint8], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const reader = new FileReader();

  reader.onload = function(evt) {
    const data = evt.target.result; // binary string
    const workbook = XLSX.read(data, { type: 'binary' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const sheetData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    renderTable(sheetData);
  };

  reader.readAsBinaryString(blob);
}

function renderTable(data) {
  outputTableContainer.innerHTML = '';

  const table = document.createElement('table');
  table.classList.add('shared_tables_css_class'); // replace with your CSS class name if needed

  data.forEach((row, i) => {
    const tr = document.createElement('tr');
    row.forEach(cell => {
      const cellEl = i === 0 ? document.createElement('th') : document.createElement('td');
      cellEl.textContent = cell;
      tr.appendChild(cellEl);
    });
    table.appendChild(tr);
  });

  outputTableContainer.appendChild(table);
}

// ============================================================================
// ERRORS FORMATTER - Audit Log Column Realignment
// ============================================================================

/**
 * Detects if a line is a type header (e.g., "Dental", "Medical")
 */
function isTypeHeader(line) {
  const trimmed = line.trim();
  return trimmed === 'Dental' || trimmed === 'Medical';
}

/**
 * Detects if a line is a date header (e.g., "Jan 18", "Feb 12")
 */
function isDateHeader(line) {
  const trimmed = line.trim();
  // Match patterns like "Jan 18", "Feb 12", "December 25", etc.
  const datePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\s+\d{1,2}$/i;
  return datePattern.test(trimmed);
}

/**
 * Detects if a line is a payer header
 * Common payers: CASH, Thiqa, NAS, Mednet, Nextcare, DAMAN, etc.
 */
function isPayerHeader(line) {
  const trimmed = line.trim().toUpperCase();
  const payers = ['CASH', 'THIQA', 'NAS', 'MEDNET', 'NEXTCARE', 'DAMAN', 'HAAD', 'ADNIC', 'NEURON'];
  return payers.includes(trimmed);
}

/**
 * Detects if a string looks like an encounter ID
 * Common prefixes: NL, IM, IV, MJ, TM, TA, etc.
 */
function isEncounterID(str) {
  if (!str || str.length < 5) return false;
  // Encounter IDs typically start with 2-letter prefix followed by alphanumeric
  const pattern = /^[A-Z]{2}[A-Z0-9]+$/i;
  return pattern.test(str);
}

/**
 * Detects if a string is a Cash File ID
 * Cash IDs start with T or I (e.g., TMCOP0872245, IMCOP0146458)
 */
function isCashFileID(str) {
  if (!str || str.length < 5) return false;
  const firstChar = str.charAt(0).toUpperCase();
  return (firstChar === 'T' || firstChar === 'I') && /^[A-Z]{2}[A-Z0-9]+$/i.test(str);
}

/**
 * Process a single audit log row and return formatted columns
 * Returns: { claimID, visitID, description }
 */
function processAuditLogRow(line) {
  // Split by tabs and/or multiple spaces (2+)
  // Single spaces are preserved to keep multi-word descriptions intact
  const parts = line.split(/\t+|\s{2,}/).map(p => p.trim()).filter(p => p.length > 0);
  
  if (parts.length === 0) {
    return { claimID: '', visitID: '', description: '' };
  }
  
  let claimID = '';
  let visitID = '';
  let description = '';
  
  // Identify IDs and description
  const ids = [];
  const descParts = [];
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (isEncounterID(part)) {
      ids.push(part);
    } else {
      // Everything else is part of the description
      descParts.push(part);
    }
  }
  
  // Take the first ID as Claim ID, second ID (if exists) as Visit ID
  if (ids.length > 0) {
    claimID = ids[0];
  }
  if (ids.length > 1) {
    visitID = ids[1];
  }
  description = descParts.join(' ');
  
  return { claimID, visitID, description };
}

/**
 * Format audit logs by realigning columns
 * Output format: Type | Date | Payer | Encounter ID | Description
 * Type defaults to "Dental" if not specified in input
 * Returns: { formatted: string, unmatchedLines: string[] }
 */
function formatAuditLogs(inputText) {
  if (!inputText || !inputText.trim()) {
    return { formatted: '', unmatchedLines: [] };
  }
  
  const lines = inputText.split('\n');
  const outputLines = [];
  const unmatchedLinesRaw = [];
  
  // Default type to "Dental" (can be overridden by Type header in input)
  let currentType = 'Dental';
  let currentDate = '';
  let currentPayer = '';
  
  for (let line of lines) {
    const trimmedLine = line.trim();
    
    // Empty lines: add to unmatched to preserve spacing
    if (!trimmedLine) {
      unmatchedLinesRaw.push('');
      continue;
    }
    
    // Update current Type header
    if (isTypeHeader(trimmedLine)) {
      currentType = trimmedLine;
      continue; // Don't output the header itself
    }
    
    // Update current Date header
    if (isDateHeader(trimmedLine)) {
      currentDate = trimmedLine;
      continue; // Don't output the header itself
    }
    
    // Update current Payer header
    if (isPayerHeader(trimmedLine)) {
      currentPayer = trimmedLine;
      continue; // Don't output the header itself
    }
    
    // Process data rows
    const { claimID, visitID, description } = processAuditLogRow(line);
    
    // Only output valid rows (rows with a claim ID)
    if (claimID) {
      const formattedLine = `${currentType}\t\t${currentDate}\t${currentPayer}\t${claimID}\t${visitID}\t${description}`;
      outputLines.push(formattedLine);
    } else {
      // Collect lines that didn't match the format (preserve original line, not trimmed)
      unmatchedLinesRaw.push(line);
    }
  }
  
  // Remove leading and trailing empty lines from unmatched, but preserve spacing in between
  let unmatchedLines = unmatchedLinesRaw;
  // Trim leading empty lines
  while (unmatchedLines.length > 0 && unmatchedLines[0] === '') {
    unmatchedLines = unmatchedLines.slice(1);
  }
  // Trim trailing empty lines
  while (unmatchedLines.length > 0 && unmatchedLines[unmatchedLines.length - 1] === '') {
    unmatchedLines = unmatchedLines.slice(0, -1);
  }
  
  return { formatted: outputLines.join('\n'), unmatchedLines };
}

/**
 * Display unmatched lines in the unmatched textarea
 */
function displayUnmatchedLines(unmatchedLines) {
  if (!unmatchedLines || unmatchedLines.length === 0) {
    // Hide the unmatched section
    unmatchedContainer.style.display = 'none';
    unmatchedButtonRow.style.display = 'none';
    errorsUnmatched.value = '';
  } else {
    // Show the unmatched section
    unmatchedContainer.style.display = 'flex';
    unmatchedButtonRow.style.display = 'flex';
    errorsUnmatched.value = unmatchedLines.join('\n');
  }
}

// Event Handlers for Errors Panel
formatButton.addEventListener('click', () => {
  const inputText = errorsInput.value;
  const result = formatAuditLogs(inputText);
  errorsOutput.value = result.formatted;
  copyButton.disabled = !result.formatted;
  
  // Display unmatched lines in textarea
  displayUnmatchedLines(result.unmatchedLines);
});

copyButton.addEventListener('click', async () => {
  const text = errorsOutput.value;
  if (!text) return;
  
  try {
    await navigator.clipboard.writeText(text);
    const originalText = copyButton.textContent;
    copyButton.textContent = 'Copied!';
    setTimeout(() => {
      copyButton.textContent = originalText;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy to clipboard:', err);
    alert('Failed to copy to clipboard. Please manually select the text in the output area and use Ctrl+C (or Cmd+C on Mac) to copy.');
  }
});

copyUnmatchedButton.addEventListener('click', async () => {
  const text = errorsUnmatched.value;
  if (!text) return;
  
  try {
    await navigator.clipboard.writeText(text);
    const originalText = copyUnmatchedButton.textContent;
    copyUnmatchedButton.textContent = 'Copied!';
    setTimeout(() => {
      copyUnmatchedButton.textContent = originalText;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy to clipboard:', err);
    alert('Failed to copy to clipboard. Please manually select the text and use Ctrl+C (or Cmd+C on Mac) to copy.');
  }
});

monospaceToggle.addEventListener('change', (e) => {
  const fontFamily = e.target.checked ? 'monospace' : 'inherit';
  errorsInput.style.fontFamily = fontFamily;
  errorsOutput.style.fontFamily = fontFamily;
  errorsUnmatched.style.fontFamily = fontFamily;
});

resetUI();
