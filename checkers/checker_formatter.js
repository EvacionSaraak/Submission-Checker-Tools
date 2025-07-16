// checker_formatter.js

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

const worker = new Worker('checker_formatter_worker.js');

let lastWorkbookData = null;

// Toggle file input panels based on mode selection
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
  combineButton.disabled = false;
  downloadButton.disabled = true;
  lastWorkbookData = null;
}

combineButton.addEventListener('click', async () => {
  try {
    messageBox.textContent = '';
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const inputFiles = mode === 'eligibility' ? eligibilityInput.files : reportingInput.files;

    if (!inputFiles.length) {
      alert('Please upload one or more files first.');
      return;
    }

    combineButton.disabled = true;
    downloadButton.disabled = true;
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    progressBarContainer.style.display = 'block';

    // Read files as ArrayBuffers here in main thread ONLY
    const fileBuffers = [];
    for (let i = 0; i < inputFiles.length; i++) {
      const f = inputFiles[i];
      messageBox.textContent = `Reading file ${i + 1} of ${inputFiles.length}: ${f.name}`;
      const buffer = await f.arrayBuffer();
      fileBuffers.push(buffer);
    }

    messageBox.textContent = 'Files read. Starting processing...';

    // Send raw buffers and mode to worker
    worker.postMessage({ type: 'start', mode, files: fileBuffers });

  } catch (err) {
    messageBox.textContent = 'Error reading files: ' + err.message;
    combineButton.disabled = false;
  }
});

worker.onmessage = e => {
  const msg = e.data;
  if (msg.type === 'progress') {
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

  // Filename with timestamp
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

// Initialize UI state on load
resetUI();
