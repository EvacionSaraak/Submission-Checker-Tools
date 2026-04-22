// checker_allocator.js

const fileInput = document.getElementById('allocator-file');
const messageBox = document.getElementById('messageBox');
const allocatorMain = document.getElementById('allocator-main');
const presetSelect = document.getElementById('preset-select');
const codersTextarea = document.getElementById('coders-textarea');
const deptSection = document.getElementById('dept-section');
const selectAllBtn = document.getElementById('select-all-btn');
const deselectAllBtn = document.getElementById('deselect-all-btn');
const allocateBtn = document.getElementById('allocate-btn');
const downloadBtn = document.getElementById('download-btn');
const allocationPreview = document.getElementById('allocation-preview');

let presetsData = {};       // { facilityName: { license, coders[] } }
let parsedRows = [];        // array of objects from the uploaded XLSX
let parsedHeaders = [];     // header row
let rawSheetData = null;    // raw sheet_to_json array-of-arrays (for original sheet)
let lastAllocationResult = null; // { rows, originalAoA }

// ==============================
// Load presets JSON on startup
// ==============================
fetch('../json/allocator_presets.json')
  .then(r => r.json())
  .then(data => {
    presetsData = data;
    populatePresetDropdown();
  })
  .catch(() => {
    // silently continue if JSON can't be loaded
  });

function populatePresetDropdown() {
  presetSelect.innerHTML = '<option value="">-- None --</option>';
  for (const name of Object.keys(presetsData)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    presetSelect.appendChild(opt);
  }
}

// ==============================
// File upload handler
// ==============================
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  messageBox.textContent = '';
  allocationPreview.innerHTML = '';
  downloadBtn.disabled = true;
  lastAllocationResult = null;

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      // Raw data for the "Original" sheet in the output
      rawSheetData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

      // Parse into objects using the first row as headers
      const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
      if (!jsonRows.length) {
        messageBox.textContent = 'No data found in the uploaded file.';
        return;
      }

      parsedRows = jsonRows;
      parsedHeaders = rawSheetData[0] ? rawSheetData[0].map(h => String(h).trim()) : [];

      // Extract unique departments
      const deptKey = findColumnKey(parsedRows, 'Department');
      const depts = getUniqueDepartments(parsedRows, deptKey);

      // Render department checkboxes
      renderDeptCheckboxes(depts);

      // Auto-detect facility and apply preset
      const facilityKey = findColumnKey(parsedRows, 'Facility ID');
      autoDetectPreset(parsedRows, facilityKey);

      allocatorMain.classList.remove('hidden');
    } catch (err) {
      messageBox.textContent = 'Error reading file: ' + err.message;
    }
  };
  reader.onerror = () => {
    messageBox.textContent = 'Failed to read file.';
  };
  reader.readAsArrayBuffer(file);
});

// ==============================
// Column key finder (case-insensitive fuzzy match)
// ==============================
function findColumnKey(rows, targetName) {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  const norm = s => String(s || '').toLowerCase().replace(/[\s.\-_]/g, '');
  const targetNorm = norm(targetName);
  for (const k of keys) {
    if (norm(k) === targetNorm) return k;
  }
  // partial match
  for (const k of keys) {
    if (norm(k).includes(targetNorm) || targetNorm.includes(norm(k))) return k;
  }
  return null;
}

// ==============================
// Extract unique departments
// ==============================
function getUniqueDepartments(rows, deptKey) {
  if (!deptKey) return [];
  const seen = new Set();
  for (const row of rows) {
    const val = String(row[deptKey] || '').trim();
    if (val) seen.add(val);
  }
  return Array.from(seen).sort();
}

// ==============================
// Render department checkboxes
// ==============================
function renderDeptCheckboxes(depts) {
  deptSection.innerHTML = '';
  if (!depts.length) {
    deptSection.textContent = 'No departments found.';
    return;
  }
  for (const dept of depts) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = dept;
    cb.checked = true;
    cb.style.marginRight = '6px';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(dept));
    deptSection.appendChild(label);
  }
}

// ==============================
// Auto-detect preset from Facility ID column
// ==============================
function autoDetectPreset(rows, facilityKey) {
  if (!facilityKey || !Object.keys(presetsData).length) return;

  // Collect facility IDs from data
  const counts = {};
  for (const row of rows) {
    const val = String(row[facilityKey] || '').trim().toUpperCase();
    if (val) counts[val] = (counts[val] || 0) + 1;
  }

  // Find the most common facility ID
  let topId = null;
  let topCount = 0;
  for (const [id, cnt] of Object.entries(counts)) {
    if (cnt > topCount) { topCount = cnt; topId = id; }
  }

  if (!topId) return;

  // Match against preset licenses
  for (const [name, preset] of Object.entries(presetsData)) {
    if (preset.license && preset.license.toUpperCase() === topId) {
      presetSelect.value = name;
      applyPreset(name);
      return;
    }
  }

  // Fallback: try partial name match (e.g. Facility ID might be a facility name substring)
  const lowerTopId = topId.toLowerCase();
  for (const [name, preset] of Object.entries(presetsData)) {
    if (name.toLowerCase().includes(lowerTopId) || lowerTopId.includes(name.toLowerCase())) {
      presetSelect.value = name;
      applyPreset(name);
      return;
    }
  }
}

// ==============================
// Preset change handler
// ==============================
presetSelect.addEventListener('change', () => {
  const selected = presetSelect.value;
  applyPreset(selected);
});

function applyPreset(name) {
  if (!name || !presetsData[name]) {
    // Don't clear coders if preset is empty/none
    return;
  }
  const coders = presetsData[name].coders || [];
  codersTextarea.value = coders.join('\n');
}

// ==============================
// Select/Deselect all departments
// ==============================
selectAllBtn.addEventListener('click', () => {
  deptSection.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
});

deselectAllBtn.addEventListener('click', () => {
  deptSection.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
});

// ==============================
// Allocate button handler
// ==============================
allocateBtn.addEventListener('click', () => {
  messageBox.textContent = '';
  allocationPreview.innerHTML = '';
  downloadBtn.disabled = true;
  lastAllocationResult = null;

  // Get coders
  const coders = codersTextarea.value
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  if (!coders.length) {
    messageBox.textContent = 'Please enter at least one coder.';
    return;
  }

  // Get checked departments
  const checkedDepts = new Set();
  deptSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedDepts.add(cb.value);
  });

  if (!checkedDepts.size) {
    messageBox.textContent = 'Please select at least one department.';
    return;
  }

  // Find column keys
  const claimKey = findColumnKey(parsedRows, 'Pri. Claim No');
  const deptKey = findColumnKey(parsedRows, 'Department');

  if (!claimKey) {
    messageBox.textContent = 'Could not find "Claim No" column in the uploaded file.';
    return;
  }

  // Filter rows by checked departments
  const filteredRows = parsedRows.filter(row => {
    if (!deptKey) return true; // if no dept column, include all
    const dept = String(row[deptKey] || '').trim();
    return checkedDepts.has(dept);
  });

  if (!filteredRows.length) {
    messageBox.textContent = 'No claims match the selected departments.';
    return;
  }

  // Cyclically assign coders
  const allocationRows = filteredRows.map((row, idx) => ({
    'Claim ID': row[claimKey] || '',
    'Coder': coders[idx % coders.length],
    'Query': '',
    'Status': ''
  }));

  lastAllocationResult = {
    allocationRows,
    originalAoA: rawSheetData
  };

  renderPreview(allocationRows);
  downloadBtn.disabled = false;
});

// ==============================
// Render allocation preview table
// ==============================
function renderPreview(rows) {
  allocationPreview.innerHTML = '';
  if (!rows.length) return;

  const PREVIEW_LIMIT = 100;
  const displayRows = rows.slice(0, PREVIEW_LIMIT);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of ['Claim ID', 'Coder', 'Query', 'Status']) {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of displayRows) {
    const tr = document.createElement('tr');
    for (const col of ['Claim ID', 'Coder', 'Query', 'Status']) {
      const td = document.createElement('td');
      td.textContent = row[col];
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  allocationPreview.appendChild(table);

  if (rows.length > PREVIEW_LIMIT) {
    const note = document.createElement('p');
    note.style.fontSize = '12px';
    note.style.color = '#888';
    note.textContent = `Showing first ${PREVIEW_LIMIT} of ${rows.length} allocated claims. Download to see all.`;
    allocationPreview.appendChild(note);
  }
}

// ==============================
// Download button handler
// ==============================
downloadBtn.addEventListener('click', () => {
  if (!lastAllocationResult) return;

  const { allocationRows, originalAoA } = lastAllocationResult;

  const wb = XLSX.utils.book_new();

  // Sheet 1: Allocation
  const allocationAoA = [
    ['Claim ID', 'Coder', 'Query', 'Status'],
    ...allocationRows.map(r => [r['Claim ID'], r['Coder'], r['Query'], r['Status']])
  ];
  const wsAllocation = XLSX.utils.aoa_to_sheet(allocationAoA);
  XLSX.utils.book_append_sheet(wb, wsAllocation, 'Allocation');

  // Sheet 2: Original file data
  if (originalAoA && originalAoA.length) {
    const wsOriginal = XLSX.utils.aoa_to_sheet(originalAoA);
    XLSX.utils.book_append_sheet(wb, wsOriginal, 'Original');
  }

  const wbOut = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const filename = `allocation_${timestamp}.xlsx`;

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
