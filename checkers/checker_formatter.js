const combineBtn = document.getElementById('combine-button');
const downloadBtn = document.getElementById('download-button');
const progressBar = document.getElementById('progress-bar');
const progressContainer = document.getElementById('progress-bar-container');
const messageBox = document.getElementById('messageBox');

let worker = null;
let mergedBlob = null;

function setProgress(percent) {
  progressBar.style.width = `${percent}%`;
}

function resetUI() {
  setProgress(0);
  progressContainer.style.display = 'none';
  messageBox.textContent = '';
  downloadBtn.disabled = true;
  mergedBlob = null;
}

combineBtn.addEventListener('click', async () => {
  resetUI();
  progressContainer.style.display = 'block';
  const mode = document.querySelector('input[name="mode"]:checked').value;

  let fileList;
  if (mode === 'eligibility') {
    fileList = document.getElementById('eligibility-files').files;
  } else {
    fileList = document.getElementById('reporting-files').files;
  }

  if (!fileList.length) {
    messageBox.textContent = 'Please select at least one file.';
    progressContainer.style.display = 'none';
    return;
  }

  worker = new Worker('checker_formatter_worker.js');
  worker.onmessage = e => {
    const { type, progress, data, error } = e.data;
    if (type === 'progress') {
      setProgress(progress);
    } else if (type === 'error') {
      messageBox.textContent = error;
    } else if (type === 'done') {
      setProgress(100);
      mergedBlob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      downloadBtn.disabled = false;
      messageBox.textContent = 'Combine complete. You can download the merged file.';
      worker.terminate();
      worker = null;
    }
  };

  // Convert files to ArrayBuffers before sending to worker
  const buffers = [];
  for (const file of fileList) {
    buffers.push(await file.arrayBuffer());
  }

  worker.postMessage({ type: 'start', mode, files: buffers });
});

downloadBtn.addEventListener('click', () => {
  if (!mergedBlob) return;
  const url = URL.createObjectURL(mergedBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `combined_${Date.now()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
