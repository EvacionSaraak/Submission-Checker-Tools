// checker_allocator.js

const fileInput = document.getElementById('allocator-file');
const messageBox = document.getElementById('messageBox');
const allocatorMain = document.getElementById('allocator-main');
const presetSelect = document.getElementById('preset-select');
const codersTextarea = document.getElementById('coders-textarea');
const deptSection = document.getElementById('dept-section');
const codifStatusSection = document.getElementById('codif-status-section');
const paymentModeSection = document.getElementById('payment-mode-section');
const coderSummary = document.getElementById('coder-summary');
const selectAllBtn = document.getElementById('select-all-btn');
const deselectAllBtn = document.getElementById('deselect-all-btn');
const selectAllCodifBtn = document.getElementById('select-all-codif-btn');
const deselectAllCodifBtn = document.getElementById('deselect-all-codif-btn');
const selectAllPaymentBtn = document.getElementById('select-all-payment-btn');
const deselectAllPaymentBtn = document.getElementById('deselect-all-payment-btn');
const codifiedBySection = document.getElementById('codified-by-section');
const selectAllCodifiedByBtn = document.getElementById('select-all-codified-by-btn');
const deselectAllCodifiedByBtn = document.getElementById('deselect-all-codified-by-btn');
const allocateBtn = document.getElementById('allocate-btn');
const downloadBtn = document.getElementById('download-btn');
const allocationPreview = document.getElementById('allocation-preview');
const includeNoBillCb = document.getElementById('include-no-bill-cb');
const noBillCountLabel = document.getElementById('no-bill-count-label');

let presetsData = {};       // { facilityName: { license, coders[] } }
let parsedRows = [];        // array of objects from the uploaded XLSX
let rawSheetData = null;    // raw sheet_to_json array-of-arrays (for original sheet)
let lastAllocationResult = null; // { allocationRows, originalAoA }
// { coderName: Set<deptName> } for restricted coders; absent key = unrestricted
let coderRestrictions = {};

// Column name candidates in priority order (first match wins)
const CLAIM_ID_CANDIDATES            = ['Pri. Claim ID', 'Pri. Claim No', 'ClaimID', 'Claim ID'];
const DEPT_CANDIDATES                = ['Admitting Department', 'Department', 'Clinic'];
const FACILITY_CANDIDATES            = ['Center Name', 'Facility ID', 'Centre Name'];
const CODIFICATION_STATUS_CANDIDATES = ['Codification Status', 'Codification_Status', 'CodificationStatus'];
const PAYMENT_MODE_CANDIDATES        = ['Pri. Payment Mode', 'Payment Mode', 'PaymentMode', 'Pri Payment Mode'];
const CODIFIED_BY_CANDIDATES         = ['Codified By', 'CodifiedBy', 'Codified_By', 'Coded By', 'CodedBy'];
const CODIF_REMARKS_CANDIDATES       = ['Codification Remarks', 'CodificationRemarks', 'Codification_Remarks', 'Codif Remarks'];

// Returns true when a Codification Remarks value indicates the claim should not
// be billed/submitted and therefore must be excluded from allocation.
const NO_BILLING_PATTERN = /no\s*bil|not\s+for\s+(billing|submission)|no\s+submission/i;
function isNoBillingRemark(value) {
  return NO_BILLING_PATTERN.test(String(value || '').trim());
}

// Codification statuses that are unchecked (excluded) by default, analogous to
// Dental / Orthodontic in the department checklist.
const DEFAULT_EXCLUDED_CODIF_STATUSES = new Set([
  'Not Seen',
  'Closed',
  'Completed-Needs Verification',
  'Under Process',
  'Verified and Closed',
]);

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

// Normalise a payment mode string to a category for preset filtering.
// Values containing "insur" (case-insensitive) map to "insurance"; everything
// else maps to "self_pay".
function getPaymentModeCategory(mode) {
  return /insur/i.test(mode) ? 'insurance' : 'self_pay';
}

// Rebuild the preset dropdown.
// activeCategories: optional Set<"insurance"|"self_pay"> derived from the
// currently checked payment modes.  A preset is shown when:
//   - it has no payment_mode field (universal), OR
//   - its payment_mode is in activeCategories (or activeCategories is empty/absent).
function populatePresetDropdown(activeCategories) {
  const currentValue = presetSelect.value;
  presetSelect.innerHTML = '<option value="">-- None --</option>';
  for (const [name, preset] of Object.entries(presetsData)) {
    if (name.startsWith('_')) continue; // skip meta/comment keys
    if (activeCategories && activeCategories.size > 0 && preset.payment_mode) {
      if (!activeCategories.has(preset.payment_mode)) continue;
    }
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    presetSelect.appendChild(opt);
  }
  // Restore the previously selected value if its option is still present
  if (currentValue && presetSelect.querySelector(`option[value="${currentValue.replace(/"/g, '\\"')}"]`)) {
    presetSelect.value = currentValue;
  }
}

// Refresh the preset dropdown based on the currently checked payment modes.
function refreshPresetDropdown() {
  const activeCategories = new Set();
  paymentModeSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    activeCategories.add(getPaymentModeCategory(cb.value));
  });
  populatePresetDropdown(activeCategories);
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
  deptSection.innerHTML = '';
  codifStatusSection.innerHTML = '';
  paymentModeSection.innerHTML = '';
  codifiedBySection.innerHTML = '';
  codersTextarea.value = '';
  presetSelect.value = '';
  includeNoBillCb.checked = false;
  noBillCountLabel.textContent = '';
  downloadBtn.disabled = true;
  lastAllocationResult = null;
  coderRestrictions = {};

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

      // Payment Mode is the top of the cascade — render from all rows.
      const paymentKey = findColumnKey(parsedRows, PAYMENT_MODE_CANDIDATES);
      renderPaymentModeCheckboxes(getValuesWithCounts(parsedRows, paymentKey));

      // Filter preset dropdown to match the checked payment modes.
      refreshPresetDropdown();

      // Cascade downstream: Departments → Codif Status → Codified By → No Bills.
      refreshDeptCounts();
      refreshCodifStatusCounts();
      refreshCodifiedByCounts();
      refreshNoBillCount();

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
// Extract unique values with occurrence counts for a column
// Returns [{value, count}] sorted alphabetically by value
// ==============================
function getValuesWithCounts(rows, key) {
  if (!key) return [];
  const counts = {};
  for (const row of rows) {
    const val = String(row[key] || '').trim();
    if (val) counts[val] = (counts[val] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

// ==============================
// Render department checkboxes
// ==============================
function renderDeptCheckboxes(items) {
  deptSection.innerHTML = '';
  if (!items.length) {
    deptSection.textContent = 'No departments found.';
    return;
  }
  for (const { value, count } of items) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = value;
    cb.checked = value !== 'Dental' && value !== 'Orthodontic';
    cb.style.marginRight = '6px';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`(${count}) ${value}`));
    deptSection.appendChild(label);
  }
}

// ==============================
// Render codification status checkboxes
// ==============================
function renderCodifStatusCheckboxes(items) {
  codifStatusSection.innerHTML = '';
  if (!items.length) {
    codifStatusSection.textContent = 'No codification statuses found.';
    return;
  }
  for (const { value, count } of items) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = value;
    cb.checked = !DEFAULT_EXCLUDED_CODIF_STATUSES.has(value);
    cb.style.marginRight = '6px';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`(${count}) ${value}`));
    codifStatusSection.appendChild(label);
  }
}

// ==============================
// Render payment mode checkboxes
// ==============================
function renderPaymentModeCheckboxes(items) {
  paymentModeSection.innerHTML = '';
  if (!items.length) {
    paymentModeSection.textContent = 'No payment modes found.';
    return;
  }
  for (const { value, count } of items) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = value;
    cb.checked = true;
    cb.style.marginRight = '6px';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`(${count}) ${value}`));
    paymentModeSection.appendChild(label);
  }
}

// ==============================
// Render codified-by checkboxes
// All checked by default (checked = already coded = exclude from allocation)
// ==============================
function renderCodifiedByCheckboxes(items) {
  codifiedBySection.innerHTML = '';
  if (!items.length) {
    codifiedBySection.textContent = 'No codified-by names found.';
    return;
  }
  for (const { value, count } of items) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = value;
    cb.checked = true; // checked = exclude these already-coded rows
    cb.style.marginRight = '6px';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`(${count}) ${value}`));
    codifiedBySection.appendChild(label);
  }
}

// ==============================
// Re-render department checkboxes based on currently checked payment modes.
// Preserves existing checked state; falls back to Dental/Orthodontic-unchecked default.
// ==============================
function refreshDeptCounts() {
  const deptKey    = findColumnKey(parsedRows, DEPT_CANDIDATES);
  const paymentKey = findColumnKey(parsedRows, PAYMENT_MODE_CANDIDATES);

  // Remember which departments are currently checked
  const checkedDepts = new Set();
  deptSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedDepts.add(cb.value);
  });

  // Determine which payment modes are checked
  const checkedModes = new Set();
  paymentModeSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedModes.add(cb.value);
  });

  // Filter by payment mode (payment mode is upstream of departments)
  const paymentFilteredRows = paymentKey
    ? parsedRows.filter(row => checkedModes.has(String(row[paymentKey] || '').trim()))
    : parsedRows;

  // Re-render with updated counts, restoring checked state
  const items = getValuesWithCounts(paymentFilteredRows, deptKey);
  deptSection.innerHTML = '';
  if (!items.length) {
    deptSection.textContent = 'No departments found.';
    return;
  }
  for (const { value, count } of items) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = value;
    // Preserve previous checked state; fall back to Dental/Orthodontic-unchecked default
    cb.checked = checkedDepts.size > 0
      ? checkedDepts.has(value)
      : value !== 'Dental' && value !== 'Orthodontic';
    cb.style.marginRight = '6px';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`(${count}) ${value}`));
    deptSection.appendChild(label);
  }
}


function refreshCodifiedByCounts() {
  const deptKey       = findColumnKey(parsedRows, DEPT_CANDIDATES);
  const paymentKey    = findColumnKey(parsedRows, PAYMENT_MODE_CANDIDATES);
  const codifKey      = findColumnKey(parsedRows, CODIFICATION_STATUS_CANDIDATES);
  const codifiedByKey = findColumnKey(parsedRows, CODIFIED_BY_CANDIDATES);

  // Remember which codified-by names are currently checked
  const checkedNames = new Set();
  codifiedBySection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedNames.add(cb.value);
  });

  // Collect current upstream selections
  const checkedDepts = new Set();
  deptSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedDepts.add(cb.value);
  });
  const checkedModes = new Set();
  paymentModeSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedModes.add(cb.value);
  });
  const checkedCodifStatuses = new Set();
  codifStatusSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedCodifStatuses.add(cb.value);
  });

  // Apply upstream filters in cascade order: payment → dept → codif status
  let filtered = parsedRows;
  if (paymentKey) filtered = filtered.filter(r => checkedModes.has(String(r[paymentKey] || '').trim()));
  if (deptKey)    filtered = filtered.filter(r => checkedDepts.has(String(r[deptKey] || '').trim()));
  if (codifKey)   filtered = filtered.filter(r => checkedCodifStatuses.has(String(r[codifKey] || '').trim()));

  // Re-render with updated counts, restoring checked state
  const items = getValuesWithCounts(filtered, codifiedByKey);
  codifiedBySection.innerHTML = '';
  if (!items.length) {
    codifiedBySection.textContent = 'No codified-by names found.';
    return;
  }
  for (const { value, count } of items) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = value;
    // Preserve previous checked state; fall back to all-checked default
    cb.checked = checkedNames.size > 0 ? checkedNames.has(value) : true;
    cb.style.marginRight = '6px';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`(${count}) ${value}`));
    codifiedBySection.appendChild(label);
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
    if (name.startsWith('_')) continue;
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
    if (name.startsWith('_')) continue;
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
  coderRestrictions = {};
  if (!name || !presetsData[name]) return;
  const rawCoders = presetsData[name].coders || [];
  // Each entry is either a plain string or { name, departments[] }
  const names = rawCoders.map(c => (typeof c === 'string' ? c : c.name));
  codersTextarea.value = names.join('\n');
  for (const c of rawCoders) {
    if (typeof c === 'object' && Array.isArray(c.departments) && c.departments.length) {
      coderRestrictions[c.name] = new Set(c.departments);
    }
  }
}

// ==============================
// Re-render codif status counts based on currently checked departments AND payment modes
// ==============================
function refreshCodifStatusCounts() {
  const deptKey      = findColumnKey(parsedRows, DEPT_CANDIDATES);
  const paymentKey   = findColumnKey(parsedRows, PAYMENT_MODE_CANDIDATES);
  const codifKey     = findColumnKey(parsedRows, CODIFICATION_STATUS_CANDIDATES);

  // Remember which codif statuses are currently checked
  const checkedCodifStatuses = new Set();
  codifStatusSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedCodifStatuses.add(cb.value);
  });

  // Determine which departments are checked
  const checkedDepts = new Set();
  deptSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedDepts.add(cb.value);
  });

  // Determine which payment modes are checked
  const checkedModes = new Set();
  paymentModeSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedModes.add(cb.value);
  });

  // Filter by payment mode first (top of cascade), then by departments
  const paymentFilteredRows = paymentKey
    ? parsedRows.filter(row => checkedModes.has(String(row[paymentKey] || '').trim()))
    : parsedRows;

  const deptFilteredRows = deptKey
    ? paymentFilteredRows.filter(row => checkedDepts.has(String(row[deptKey] || '').trim()))
    : paymentFilteredRows;

  // Re-render with updated counts, restoring checked state
  const items = getValuesWithCounts(deptFilteredRows, codifKey);
  codifStatusSection.innerHTML = '';
  if (!items.length) {
    codifStatusSection.textContent = 'No codification statuses found.';
    return;
  }
  for (const { value, count } of items) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = value;
    // Preserve previous checked state; fall back to default-excluded statuses being unchecked
    cb.checked = checkedCodifStatuses.size > 0
      ? checkedCodifStatuses.has(value)
      : !DEFAULT_EXCLUDED_CODIF_STATUSES.has(value);
    cb.style.marginRight = '6px';
    label.appendChild(cb);
    label.appendChild(document.createTextNode(`(${count}) ${value}`));
    codifStatusSection.appendChild(label);
  }
}

// ==============================
// Update the no-bill count label based on current upstream filter selections
// ==============================
function refreshNoBillCount() {
  const codifRemarksKey = findColumnKey(parsedRows, CODIF_REMARKS_CANDIDATES);
  if (!codifRemarksKey || !parsedRows.length) {
    noBillCountLabel.textContent = '';
    return;
  }

  const paymentKey = findColumnKey(parsedRows, PAYMENT_MODE_CANDIDATES);
  const deptKey    = findColumnKey(parsedRows, DEPT_CANDIDATES);
  const codifKey   = findColumnKey(parsedRows, CODIFICATION_STATUS_CANDIDATES);

  const checkedModes = new Set();
  paymentModeSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedModes.add(cb.value);
  });
  const checkedDepts = new Set();
  deptSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedDepts.add(cb.value);
  });
  const checkedCodifStatuses = new Set();
  codifStatusSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedCodifStatuses.add(cb.value);
  });

  let filtered = parsedRows;
  if (paymentKey) filtered = filtered.filter(r => checkedModes.has(String(r[paymentKey] || '').trim()));
  if (deptKey)    filtered = filtered.filter(r => checkedDepts.has(String(r[deptKey] || '').trim()));
  if (codifKey)   filtered = filtered.filter(r => checkedCodifStatuses.has(String(r[codifKey] || '').trim()));

  const noBillCount = filtered.filter(row => isNoBillingRemark(row[codifRemarksKey])).length;
  noBillCountLabel.textContent = `No Bills: ${noBillCount}`;
}


selectAllBtn.addEventListener('click', () => {
  deptSection.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
  refreshCodifStatusCounts();
  refreshCodifiedByCounts();
  refreshNoBillCount();
});

deselectAllBtn.addEventListener('click', () => {
  deptSection.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
  refreshCodifStatusCounts();
  refreshCodifiedByCounts();
  refreshNoBillCount();
});

deptSection.addEventListener('change', (e) => {
  if (e.target.type === 'checkbox') {
    refreshCodifStatusCounts();
    refreshCodifiedByCounts();
    refreshNoBillCount();
  }
});

// ==============================
// Select / Deselect all codification statuses
// ==============================
selectAllCodifBtn.addEventListener('click', () => {
  codifStatusSection.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
  refreshCodifiedByCounts();
  refreshNoBillCount();
});

deselectAllCodifBtn.addEventListener('click', () => {
  codifStatusSection.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
  refreshCodifiedByCounts();
  refreshNoBillCount();
});

codifStatusSection.addEventListener('change', (e) => {
  if (e.target.type === 'checkbox') {
    refreshCodifiedByCounts();
    refreshNoBillCount();
  }
});

// ==============================
// Select / Deselect all payment modes
// ==============================
selectAllPaymentBtn.addEventListener('click', () => {
  paymentModeSection.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
  refreshPresetDropdown();
  refreshDeptCounts();
  refreshCodifStatusCounts();
  refreshCodifiedByCounts();
  refreshNoBillCount();
});

deselectAllPaymentBtn.addEventListener('click', () => {
  paymentModeSection.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
  refreshPresetDropdown();
  refreshDeptCounts();
  refreshCodifStatusCounts();
  refreshCodifiedByCounts();
  refreshNoBillCount();
});

paymentModeSection.addEventListener('change', (e) => {
  if (e.target.type === 'checkbox') {
    refreshPresetDropdown();
    refreshDeptCounts();
    refreshCodifStatusCounts();
    refreshCodifiedByCounts();
    refreshNoBillCount();
  }
});

// ==============================
// Select / Deselect all codified-by names
// ==============================
selectAllCodifiedByBtn.addEventListener('click', () => {
  codifiedBySection.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true);
});

deselectAllCodifiedByBtn.addEventListener('click', () => {
  codifiedBySection.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
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
    renderPreview([]);
    return;
  }

  // Get checked codification statuses
  const checkedCodifStatuses = new Set();
  codifStatusSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedCodifStatuses.add(cb.value);
  });

  // Get checked payment modes
  const checkedPaymentModes = new Set();
  paymentModeSection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedPaymentModes.add(cb.value);
  });

  // Find column keys
  const claimKey           = findColumnKey(parsedRows, CLAIM_ID_CANDIDATES);
  const deptKey            = findColumnKey(parsedRows, DEPT_CANDIDATES);
  const codifStatusKey     = findColumnKey(parsedRows, CODIFICATION_STATUS_CANDIDATES);
  const paymentModeKey     = findColumnKey(parsedRows, PAYMENT_MODE_CANDIDATES);
  const codifRemarksKey    = findColumnKey(parsedRows, CODIF_REMARKS_CANDIDATES);

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
    renderPreview([]);
    return;
  }

  // Filter rows by checked codification statuses (skip only if column absent)
  const codifFilteredRows = codifStatusKey
    ? filteredRows.filter(row => {
        const status = String(row[codifStatusKey] || '').trim();
        return checkedCodifStatuses.has(status);
      })
    : filteredRows;

  // Filter rows by checked payment modes (skip only if column absent)
  const visibleRows = paymentModeKey
    ? codifFilteredRows.filter(row => {
        const mode = String(row[paymentModeKey] || '').trim();
        return checkedPaymentModes.has(mode);
      })
    : codifFilteredRows;

  // Exclude rows already coded by a checked name (checked = trusted coder, already done)
  // Rows with an empty Codified By, or whose coder name is unchecked, are included.
  const checkedCodifiedBy = new Set();
  codifiedBySection.querySelectorAll('input[type=checkbox]:checked').forEach(cb => {
    checkedCodifiedBy.add(cb.value);
  });
  const codifiedByKey = findColumnKey(parsedRows, CODIFIED_BY_CANDIDATES);
  const allocatableRows = codifiedByKey
    ? visibleRows.filter(row => {
        const codifier = String(row[codifiedByKey] || '').trim();
        return !codifier || !checkedCodifiedBy.has(codifier);
      })
    : visibleRows;

  // Exclude rows whose Codification Remarks indicate no billing / no submission
  // (unless the user has checked "Include No Bills")
  const billingRows = (codifRemarksKey && !includeNoBillCb.checked)
    ? allocatableRows.filter(row => !isNoBillingRemark(row[codifRemarksKey]))
    : allocatableRows;

  // Deduplicate by Claim ID — keep only the first occurrence of each ID
  const seenClaimIds = new Set();
  const uniqueRows = billingRows.filter(row => {
    const id = String(row[claimKey] || '').trim();
    if (seenClaimIds.has(id)) return false;
    seenClaimIds.add(id);
    return true;
  });

  // Build today's date string (DD/MM/YYYY) once for the whole allocation run
  const today = new Date();
  const todayStr = String(today.getDate()).padStart(2, '0') + '/'
    + String(today.getMonth() + 1).padStart(2, '0') + '/'
    + today.getFullYear();

  // Cyclically assign coders, respecting per-coder department restrictions.
  // Coders with a restrictions entry can only be assigned to their listed departments.
  // Rows with no eligible coder are marked "(Unassigned)".
  const poolCounters = {}; // key = eligible coder names joined → rotating index
  const allocationRows = uniqueRows.map(row => {
    const dept = deptKey ? String(row[deptKey] || '').trim() : '';
    const eligible = coders.filter(c =>
      !coderRestrictions[c] || coderRestrictions[c].has(dept)
    );
    let assigned;
    if (!eligible.length) {
      assigned = '(Unassigned)';
    } else {
      const key = eligible.join('|');
      if (!(key in poolCounters)) poolCounters[key] = 0;
      assigned = eligible[poolCounters[key] % eligible.length];
      poolCounters[key]++;
    }
    const alreadyCoded = codifiedByKey && String(row[codifiedByKey] || '').trim();
    return {
      'Claim ID':      row[claimKey] || '',
      'Department':    dept,
      'Coder':         assigned,
      'Date Assigned': alreadyCoded ? 'CODER ALREADY ASSIGNED' : todayStr,
      'Query':         '',
      'Status':        ''
    };
  });

  lastAllocationResult = allocationRows.length ? { allocationRows, originalAoA: rawSheetData } : null;

  renderPreview(allocationRows);
  renderCoderSummary(allocationRows, coders);
  downloadBtn.disabled = !allocationRows.length;
});

// ==============================
// Render allocation preview table
// ==============================
function renderPreview(rows) {
  allocationPreview.innerHTML = '';
  if (!rows.length) {
    const msg = document.createElement('p');
    msg.style.textAlign = 'center';
    msg.style.padding = '24px 0';
    msg.style.fontWeight = 'bold';
    msg.style.color = '#888';
    msg.textContent = 'NO CLAIMS TO ALLOCATE';
    allocationPreview.appendChild(msg);
    return;
  }

  const COLS = ['Claim ID', 'Department', 'Coder', 'Date Assigned', 'Query', 'Status'];

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
  coderSummary.style.marginTop = '12px';

  const counts = {};
  for (const coder of coders) counts[coder] = 0;
  let unassigned = 0;
  for (const row of rows) {
    if (row['Coder'] === '(Unassigned)') { unassigned++; continue; }
    counts[row['Coder']] = (counts[row['Coder']] || 0) + 1;
  }

  const label = document.createElement('span');
  label.className = 'section-label';
  label.textContent = 'Coder Assignment';
  coderSummary.appendChild(label);

  const list = document.createElement('ul');
  list.style.margin = '4px 0 0 0';
  list.style.paddingLeft = '16px';
  for (const coder of coders) {
    const li = document.createElement('li');
    const n = counts[coder] || 0;
    let text = `${coder}: ${n} claim${n === 1 ? '' : 's'}`;
    if (coderRestrictions[coder]) {
      text += ` (${Array.from(coderRestrictions[coder]).join(', ')} only)`;
    }
    li.textContent = text;
    list.appendChild(li);
  }
  if (unassigned > 0) {
    const li = document.createElement('li');
    li.style.color = '#c0392b';
    li.textContent = `(Unassigned): ${unassigned} claim${unassigned === 1 ? '' : 's'} — no eligible coder for department`;
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
    ['Claim ID', 'Department', 'Coder', 'Date Assigned', 'Query', 'Status'],
    ...allocationRows.map(r => [r['Claim ID'], r['Department'], r['Coder'], r['Date Assigned'], r['Query'], r['Status']])
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

