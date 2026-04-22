// checker_allocator.js

const fileInput = document.getElementById('allocator-file');
const messageBox = document.getElementById('messageBox');
const allocatorMain = document.getElementById('allocator-main');
const presetSelect = document.getElementById('preset-select');
const codersTextarea = document.getElementById('coders-textarea');
const deptSection = document.getElementById('dept-section');
const coderSummary = document.getElementById('coder-summary');
const selectAllBtn = document.getElementById('select-all-btn');
const deselectAllBtn = document.getElementById('deselect-all-btn');
const allocateBtn = document.getElementById('allocate-btn');
const downloadBtn = document.getElementById('download-btn');
const allocationPreview = document.getElementById('allocation-preview');

let presetsData = {};       // { facilityName: { license, coders[] } }
let parsedRows = [];        // array of objects from the uploaded XLSX
let rawSheetData = null;    // raw sheet_to_json array-of-arrays (for original sheet)
let lastAllocationResult = null; // { allocationRows, originalAoA }

// Column name candidates in priority order (first match wins)
const CLAIM_ID_CANDIDATES  = ['Pri. Claim ID', 'Pri. Claim No', 'ClaimID', 'Claim ID'];
const DEPT_CANDIDATES      = ['Admitting Department', 'Department', 'Clinic'];
const FACILITY_CANDIDATES  = ['Center Name', 'Facility ID', 'Centre Name'];

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
  coderSummary.innerHTML = '';
  coderSummary.classList.add('hidden');
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

      // Headers are in the second row (index 1); data rows start at index 2.
      // Build an array of objects manually so we are not dependent on XLSX
      // assuming the first row is the header.
      if (rawSheetData.length < 2) {
        messageBox.textContent = 'No data found in the uploaded file.';
        return;
      }
      const headerRow = rawSheetData[1].map(h => String(h == null ? '' : h).trim());
      const dataRows  = rawSheetData.slice(2);

      const jsonRows = dataRows.map(row => {
        const obj = {};
        headerRow.forEach((h, i) => { obj[h] = row[i] == null ? '' : row[i]; });
        return obj;
      }).filter(obj => Object.values(obj).some(v => v !== ''));

      if (!jsonRows.length) {
        messageBox.textContent = 'No data found in the uploaded file.';
        return;
      }

      parsedRows = jsonRows;

      // Extract unique departments
      const deptKey = findColumnKey(parsedRows, DEPT_CANDIDATES);
      const depts = getUniqueDepartments(parsedRows, deptKey);
      renderDeptCheckboxes(depts);

      // Auto-detect facility and apply preset
      const facilityKey = findColumnKey(parsedRows, FACILITY_CANDIDATES);
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
// Column key finder
// Accepts an array of candidate names tried in priority order.
// Uses exact normalized match first, then partial match.
// ==============================
function findColumnKey(rows, candidates) {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  const norm = s => String(s || '').toLowerCase().replace(/[\s.\-_]/g, '');

  for (const candidate of candidates) {
    const targetNorm = norm(candidate);
    // Exact normalized match
    for (const k of keys) {
      if (norm(k) === targetNorm) return k;
    }
  }

  // Partial match (any candidate)
  for (const candidate of candidates) {
    const targetNorm = norm(candidate);
    for (const k of keys) {
      const kn = norm(k);
      if (kn.includes(targetNorm) || targetNorm.includes(kn)) return k;
    }
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
// Auto-detect preset from facility column
// Center Name holds a name string, so we match by name similarity.
// Falls back to license-code match for Facility ID columns.
// ==============================
function autoDetectPreset(rows, facilityKey) {
  if (!facilityKey || !Object.keys(presetsData).length) return;

  // Count occurrences of each value in the facility column
  const counts = {};
  for (const row of rows) {
    const val = String(row[facilityKey] || '').trim();
    if (val) counts[val] = (counts[val] || 0) + 1;
  }

  // Pick the most common value
  let topValue = null;
  let topCount = 0;
  for (const [val, cnt] of Object.entries(counts)) {
    if (cnt > topCount) { topCount = cnt; topValue = val; }
  }
  if (!topValue) return;

  const norm = s => String(s || '').toLowerCase().replace(/[\s.\-_,()]/g, '');
  const topNorm = norm(topValue);

  // 1) Try matching the value as a facility name (substring either way)
  for (const [name] of Object.entries(presetsData)) {
    const nameNorm = norm(name);
    if (nameNorm === topNorm || nameNorm.includes(topNorm) || topNorm.includes(nameNorm)) {
      presetSelect.value = name;
      applyPreset(name);
      return;
    }
  }

  // 2) Try matching the value as a license code (MF/PF code)
  const upperValue = topValue.toUpperCase();
  for (const [name, preset] of Object.entries(presetsData)) {
    if (preset.license && preset.license.toUpperCase() === upperValue) {
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
  applyPreset(presetSelect.value);
});

function applyPreset(name) {
  if (!name || !presetsData[name]) return;
  const coders = presetsData[name].coders || [];
  codersTextarea.value = coders.join('\n');
}

// ==============================
// Select / Deselect all departments
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
  coderSummary.innerHTML = '';
  coderSummary.classList.add('hidden');
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
  const claimKey = findColumnKey(parsedRows, CLAIM_ID_CANDIDATES);
  const deptKey  = findColumnKey(parsedRows, DEPT_CANDIDATES);

  if (!claimKey) {
    messageBox.textContent = 'Could not find a Claim ID column in the uploaded file.';
    return;
  }

  // Filter rows by checked departments
  const filteredRows = parsedRows.filter(row => {
    if (!deptKey) return true;
    const dept = String(row[deptKey] || '').trim();
    return checkedDepts.has(dept);
  });

  if (!filteredRows.length) {
    messageBox.textContent = 'No claims match the selected departments.';
    return;
  }

  // Cyclically assign coders
  const allocationRows = filteredRows.map((row, idx) => ({
    'Claim ID':   row[claimKey] || '',
    'Department': deptKey ? String(row[deptKey] || '').trim() : '',
    'Coder':      coders[idx % coders.length],
    'Query':      '',
    'Status':     ''
  }));

  lastAllocationResult = { allocationRows, originalAoA: rawSheetData };

  renderPreview(allocationRows);
  renderCoderSummary(allocationRows, coders);
  downloadBtn.disabled = false;
});

// ==============================
// Render allocation preview table
// ==============================
function renderPreview(rows) {
  allocationPreview.innerHTML = '';
  if (!rows.length) return;

  const COLS = ['Claim ID', 'Department', 'Coder', 'Query', 'Status'];

  const makeMarker = text => {
    const p = document.createElement('p');
    p.className = 'preview-marker';
    p.textContent = text;
    return p;
  };

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of COLS) {
    const th = document.createElement('th');
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const col of COLS) {
      const td = document.createElement('td');
      td.textContent = row[col];
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const scrollContainer = document.createElement('div');
  scrollContainer.id = 'preview-scroll';

  scrollContainer.appendChild(makeMarker('— START OF PREVIEW —'));
  scrollContainer.appendChild(table);
  scrollContainer.appendChild(makeMarker('— END OF PREVIEW —'));

  allocationPreview.appendChild(scrollContainer);
}

// ==============================
// Render coder assignment summary
// ==============================
function renderCoderSummary(rows, coders) {
  coderSummary.innerHTML = '';

  const counts = {};
  for (const coder of coders) counts[coder] = 0;
  for (const row of rows) counts[row['Coder']] = (counts[row['Coder']] || 0) + 1;

  const label = document.createElement('span');
  label.className = 'section-label';
  label.style.display = 'block';
  label.style.marginTop = '12px';
  label.textContent = 'Coder Assignment';
  coderSummary.appendChild(label);

  const list = document.createElement('ul');
  list.style.margin = '4px 0 0 0';
  list.style.paddingLeft = '16px';
  for (const coder of coders) {
    const li = document.createElement('li');
    li.textContent = `${coder}: ${counts[coder] || 0} claim${counts[coder] === 1 ? '' : 's'}`;
    list.appendChild(li);
  }
  coderSummary.appendChild(list);
  coderSummary.classList.remove('hidden');
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
    ['Claim ID', 'Department', 'Coder', 'Query', 'Status'],
    ...allocationRows.map(r => [r['Claim ID'], r['Department'], r['Coder'], r['Query'], r['Status']])
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

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `allocation_${timestamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
});

