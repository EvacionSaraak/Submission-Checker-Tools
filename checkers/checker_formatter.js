// checker_formatter.js

// Elements
const modeRadios = document.querySelectorAll('input[name="mode"]');
const eligibilityPanel = document.getElementById('eligibility-panel');
const reportingPanel = document.getElementById('reporting-panel');

const eligibilityInput = document.getElementById('eligibility-files');
const reportingInput = document.getElementById('reporting-files');

const combineBtn = document.getElementById('combine-button');
const downloadBtn = document.getElementById('download-button');

const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const progressContainer = document.getElementById('progress-bar-container');

const messageBox = document.getElementById('messageBox');

let combinedWorkbook; // To hold final combined workbook

// Switch panels based on mode
function updatePanels() {
  const mode = getSelectedMode();
  eligibilityPanel.classList.toggle('hidden', mode !== 'eligibility');
  reportingPanel.classList.toggle('hidden', mode !== 'reporting');
  clearUI();
}

function getSelectedMode() {
  return [...modeRadios].find(r => r.checked).value;
}

function clearUI() {
  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  progressContainer.style.display = 'none';
  messageBox.textContent = '';
  downloadBtn.disabled = true;
  combinedWorkbook = null;
}

modeRadios.forEach(radio => {
  radio.addEventListener('change', updatePanels);
});

// Progress update helper
function setProgress(percent) {
  progressBar.style.width = `${percent}%`;
  progressText.textContent = `${percent}%`;
}

// Download helper
function downloadWorkbook(wb, filename) {
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Read files as ArrayBuffers
async function readFilesAsArrayBuffers(fileList) {
  const buffers = [];
  for (const file of fileList) {
    try {
      buffers.push(await file.arrayBuffer());
    } catch (err) {
      throw new Error(`Failed to read file '${file.name}': ${err.message}`);
    }
  }
  return buffers;
}

// Initialize worker
const worker = new Worker('checker_formatter_worker.js');

worker.onmessage = e => {
  const data = e.data;
  if (data.type === 'progress') {
    setProgress(data.progress);
  } else if (data.type === 'result') {
    combinedWorkbook = XLSX.read(data.workbookData, { type: 'array' });
    setProgress(100);
    downloadBtn.disabled = false;
    messageBox.textContent = 'Combine complete.';
  } else if (data.type === 'error') {
    messageBox.textContent = `Error: ${data.error}`;
    setProgress(0);
    downloadBtn.disabled = true;
  }
};

worker.onerror = e => {
  messageBox.textContent = `Worker error: ${e.message}`;
  setProgress(0);
  downloadBtn.disabled = true;
};

// Combine button click handler
combineButton.addEventListener('click', async () => {
  try {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    // Select the correct file input based on mode
    const inputFiles = mode === 'eligibility'
      ? document.getElementById('eligibility-files').files
      : document.getElementById('reporting-files').files;

    if (!inputFiles.length) {
      alert('Please upload one or more files first.');
      return;
    }

    // Convert each file/blob to ArrayBuffer safely
    const fileBuffers = await Promise.all([...inputFiles].map(async f => {
      if (f instanceof File || f instanceof Blob) {
        return await f.arrayBuffer();
      } else {
        // Already an ArrayBuffer or something else
        return f;
      }
    }));

    // Disable buttons while processing
    combineButton.disabled = true;
    downloadButton.disabled = true;
    progressBar.style.width = '0%';
    progressBarContainer.style.display = 'block';
    messageBox.textContent = '';

    // Start worker with buffers
    worker.postMessage({ type: 'start', mode, files: fileBuffers });
  } catch (err) {
    console.error('Error during file preparation:', err);
    messageBox.textContent = 'Error reading files: ' + err.message;
    combineButton.disabled = false;
  }
});

// Download button click handler
downloadBtn.addEventListener('click', () => {
  if (!combinedWorkbook) return;
  const mode = getSelectedMode();
  const filename = mode === 'eligibility' ? 'Combined_Eligibility.xlsx' : 'Combined_Reporting.xlsx';
  downloadWorkbook(combinedWorkbook, filename);
});

// Initialize UI
updatePanels();
clearUI();
