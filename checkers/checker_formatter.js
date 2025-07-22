const combineButton = document.getElementById('combine-button');
const downloadButton = document.getElementById('download-button');
const progressBarContainer = document.getElementById('progress-bar-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const messageBox = document.getElementById('messageBox');

const eligibilityPanel = document.getElementById('eligibility-panel');
const reportingPanel = document.getElementById('reporting-panel');

const eligibilityInput = document.getElementById('eligibility-files');
const reportingInput = document.getElementById('reporting-files');
const clinicianInput = document.getElementById('clinician-files'); // NEW clinician input

const outputTableContainer = document.getElementById('outputTableContainer');

const worker = new Worker('checker_formatter_worker.js');

let lastWorkbookData = null;

document.getElementById('mode-selector').addEventListener('change', e => {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode === 'eligibility') {
    eligibilityPanel.classList.remove('hidden');
    reportingPanel.classList.add('hidden');
  } else {
    eligibilityPanel.classList.add('hidden');
    reportingPanel.classList.remove('hidden');
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

combineButton.addEventListener('click', async () => {
  try {
    messageBox.textContent = '';
    outputTableContainer.innerHTML = '';
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const inputFiles = mode === 'eligibility' ? eligibilityInput.files : reportingInput.files;

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

    // Debug log before posting message to worker
    console.log('Posting start message to worker', { mode, files: fileEntries.length, clinicianFile: clinicianFileEntry ? clinicianFileEntry.name : 'none' });

    // Post message to worker with clinician file included
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
  const blob = new Blob([lastWorkbookData], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;

  const mode = document.querySelector('input[name="mode"]:checked').value;
  const timestamp = new Date().toISOString().slice(0,19).replace(/:/g,'-');
  a.download = `combined_${mode}_${timestamp}.xlsx`;
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
