const combineButton = document.getElementById('combine-button');
const downloadButton = document.getElementById('download-button');
const progressBarContainer = document.getElementById('progress-bar-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const messageBox = document.getElementById('messageBox');

const eligibilityPanel = document.getElementById('eligibility-panel');
const reportingPanel = document.getElementById('reporting-panel');
const xmlPanel = document.getElementById('xml-panel');

const eligibilityInput = document.getElementById('eligibility-files');
const reportingInput = document.getElementById('reporting-files');
const clinicianInput = document.getElementById('clinician-files'); // NEW clinician input
const xmlInput = document.getElementById('xml-files');

const outputTableContainer = document.getElementById('outputTableContainer');

const worker = new Worker('checker_formatter_worker.js');

let lastWorkbookData = null;

document.getElementById('mode-selector').addEventListener('change', e => {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode === 'eligibility') {
    eligibilityPanel.classList.remove('hidden');
    reportingPanel.classList.add('hidden');
    xmlPanel.classList.add('hidden');
  } else if (mode === 'reporting') {
    eligibilityPanel.classList.add('hidden');
    reportingPanel.classList.remove('hidden');
    xmlPanel.classList.add('hidden');
  } else if (mode === 'xml') {
    eligibilityPanel.classList.add('hidden');
    reportingPanel.classList.add('hidden');
    xmlPanel.classList.remove('hidden');
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

resetUI();
