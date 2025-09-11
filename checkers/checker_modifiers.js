// checker_modifiers.js
let lastResults = [];
let lastWorkbook = null;

document.addEventListener('DOMContentLoaded', () => {
  const runBtn = el('run-button');
  const dlBtn = el('download-button');
  if (runBtn) runBtn.addEventListener('click', handleRun);
  if (dlBtn) dlBtn.addEventListener('click', handleDownload);
  resetUI();
});

// ----------------- Main handlers -----------------
async function handleRun() {
  resetUI();
  try {
    const xmlFile = fileEl('xml-file');
    const xlsxFile = fileEl('xlsx-file');
    if (!xmlFile || !xlsxFile) throw new Error('Please select both an XML file and an XLSX file.');

    showProgress(5, 'Reading files');
    const [xmlText, xlsxObj] = await Promise.all([readFileText(xmlFile), readXlsx(xlsxFile)]);

    showProgress(20, 'Parsing XML');
    const xmlDoc = parseXml(xmlText);
    const extracted = extractModifierRecords(xmlDoc);
    showProgress(45, `Found ${extracted.length} modifier record(s)`);

    const matcher = buildXlsxMatcher(xlsxObj.rows);
    showProgress(65, 'Matching to XLSX');

    // ----------------- MAPPING & VALIDATION -----------------
    const output = extracted.map(rec => {
      const xmlDate = normalizeDate(rec.Date);
      const match = matcher.find(rec.MemberID, xmlDate, rec.OrderingClinician);

      // VOINumber (from matched XLSX row, if any)
      const voi = match ? String(match['VOI Number'] || '').trim() : '';

      // base fields preserved
      const base = {
        ClaimID: rec.ClaimID || '',
        MemberID: rec.MemberID || '',
        ActivityID: rec.ActivityID || '',
        OrderingClinician: rec.OrderingClinician || '',
        Modifier: rec.Modifier || '',
        VOINumber: voi || '',
        EligibilityRow: match || null,
        PayerID: rec.PayerID || '',
        ObsCode: rec.ObsCode || ''
      };

      // Collect reasons; any entry => Invalid
      const reasons = [];

      if (!match) {
        // Check partial: Member + Clinician matched but date mismatch
        const partialMatch = Array.from(matcher._index.values()).flat()
          .find(r => normalizeMemberId(r['Card Number / DHA Member ID']) === normalizeMemberId(rec.MemberID) &&
                     String(r['Clinician'] || '').trim().toUpperCase() === String(rec.OrderingClinician || '').trim().toUpperCase());
        if (partialMatch) {
          reasons.push('Member & Clinician matched in eligibility but date mismatch');
          console.warn('[PARTIAL MATCH] Member and Clinician matched but date mismatch. XML date:', xmlDate, 'XLSX row sample:', partialMatch);
        } else {
          reasons.push('No eligibility match');
        }
      } else {
        // We have a matched eligibility row — validate VOI -> expected modifier -> obs code
        const expectedModifier = expectedModifierForVOI(String(match['VOI Number'] || '').trim());

        if (!expectedModifier) {
          reasons.push(`Unknown VOI in eligibility: ${String(match['VOI Number'] || '').trim() || '(blank)'}`);
        }

        // Check modifier value presence and correctness
        const recMod = String(rec.Modifier || '').trim();
        if (!recMod) {
          reasons.push('Observation modifier missing');
        } else if (expectedModifier && recMod !== expectedModifier) {
          reasons.push(`Modifier ${recMod} does not match VOI ${String(match['VOI Number'] || '(blank)')} (expected ${expectedModifier})`);
        }

        // Enforce exact ObsCode = 'CPT modifier' (case- and punctuation-sensitive)
        const obsCodeStr = rec.ObsCode == null ? '' : String(rec.ObsCode).trim();
        if (obsCodeStr === '') {
          reasons.push('Observation Code missing; expected "CPT modifier"');
        } else if (obsCodeStr !== 'CPT modifier') {
          // treat any non-exact code (including "false", "CPT Modifier", etc.) as INVALID
          reasons.push(`Observation Code incorrect; expected "CPT modifier" but found "${obsCodeStr}"`);
        }
      }

      const ValidationStatus = reasons.length ? 'Invalid' : 'Valid';
      const InvalidReason = reasons.join('; ');
      const isValid = ValidationStatus === 'Valid';

      return Object.assign({}, base, { ValidationStatus, InvalidReason, isValid });
    });

    // ----------------- END MAPPING & VALIDATION -----------------

    lastResults = output;
    renderResults(output);
    lastWorkbook = makeWorkbookFromJson(output, 'checker_modifiers_results');
    showProgress(100, 'Completed');
    toggleDownload(output.length > 0);
    message(`Completed — ${output.length} rows processed.`, 'green');
  } catch (err) {
    showError(err);
  }
}

// ----------------- Download -----------------
function handleDownload() {
  if (!lastWorkbook || !lastResults.length) { showError(new Error('Nothing to download')); return; }
  try { XLSX.writeFile(lastWorkbook, 'checker_modifiers_results.xlsx'); }
  catch(err) { try { XLSX.writeFile(makeWorkbookFromJson(lastResults, 'checker_modifiers_results'), 'checker_modifiers_results.xlsx'); } catch(e) { showError(e); } }
}

// ----------------- File helpers -----------------
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('Failed to read file'));
    fr.readAsText(file);
  });
}

async function readXlsx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  // header row is on row 2 in sample -> range:1
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', range: 1 });
  return { rows, sheetName };
}

// ----------------- XML parsing & extraction -----------------
function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const pe = doc.getElementsByTagName('parsererror')[0];
  if (pe) throw new Error('Invalid XML: ' + (pe.textContent || 'parse error').trim());
  return doc;
}

// Extract records where Observation contains Code === 'CPT modifier' and Value is '24' or '52'
// Lenient extractor: accepts ValueType='Modifiers' so malformed rows are detected, but validation requires exact Code
function extractModifierRecords(xmlDoc) {
  const records = [];
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  claims.forEach(claim => {
    const claimId = textValue(claim, 'ID');
    const payerId = textValue(claim, 'PayerID');
    const memberIdRaw = textValue(claim, 'MemberID');
    const encNode = claim.getElementsByTagName('Encounter')[0] || claim.getElementsByTagName('Encounte')[0];
    const encDateRaw = encNode ? textValue(encNode, 'Date') || textValue(encNode, 'Start') || textValue(encNode, 'EncounterDate') || '' : '';
    const encDate = normalizeDate(encDateRaw);
    const activities = Array.from(claim.getElementsByTagName('Activity'));
    activities.forEach(act => {
      const activityId = textValue(act, 'ID');
      const clinicianRaw = firstNonEmpty([
        textValue(act, 'OrderingClnician'),
        textValue(act, 'OrderingClinician'),
        textValue(act, 'Ordering_Clinician'),
        textValue(act, 'OrderingClin')
      ]);
      const clinician = String(clinicianRaw || '').trim().toUpperCase();
      const observations = Array.from(act.getElementsByTagName('Observation'));
      observations.forEach(obs => {
        let found = false;
        let lastCode = '';

        // get obs-level ValueType (if present) for lenient matching
        const vtNode = obs.getElementsByTagName('ValueType')[0];
        const obsValueType = vtNode ? String(vtNode.textContent || '').trim().toLowerCase() : '';

        // Pass 1: sequential child scan (preferred)
        const children = Array.from(obs.children || []);
        for (const child of children) {
          const tag = child.tagName;
          const txt = String(child.textContent || '').trim();
          if (!txt) continue;

          if (tag === 'Code') {
            lastCode = txt;
            continue;
          }

          if (tag === 'Value' || tag === 'ValueText') {
            const val = txt;
            if (!isModifierTarget(val)) continue;

            // Accept when Code == 'CPT modifier' OR Observation-level ValueType == 'Modifiers'
            if (lastCode === 'CPT modifier' || obsValueType === 'modifiers') {
              records.push({
                ClaimID: claimId,
                ActivityID: activityId,
                MemberID: normalizeMemberId(memberIdRaw),
                Date: encDate,
                OrderingClinician: clinician,
                Modifier: String(val).trim(),
                PayerID: payerId,
                ObsCode: lastCode || '',
                VOINumber: ''
              });

              // debug note if lenient path used
              if (lastCode !== 'CPT modifier' && obsValueType === 'modifiers') {
                console.debug('[LENIENT MATCH] matched by ValueType="Modifiers"', { claimId, activityId, memberId: memberIdRaw, value: val, code: lastCode });
              }

              found = true;
              break; // one record per observation
            }
          }

          // Rare: numeric in ValueType itself
          if (tag === 'ValueType') {
            if (isModifierTarget(txt) && (lastCode === 'CPT modifier' || txt.toLowerCase() === 'modifiers')) {
              records.push({
                ClaimID: claimId,
                ActivityID: activityId,
                MemberID: normalizeMemberId(memberIdRaw),
                Date: encDate,
                OrderingClinician: clinician,
                Modifier: String(txt).trim(),
                PayerID: payerId,
                ObsCode: lastCode || '',
                VOINumber: ''
              });
              found = true;
              break;
            }
          }
        } // end children loop

        if (found) return; // continue to next observation

        // Pass 2: fallback alignment (if nothing found)
        const codes = Array.from(obs.getElementsByTagName('Code')).map(n => String(n.textContent || '').trim());
        const values = Array.from(obs.getElementsByTagName('Value')).map(n => String(n.textContent || '').trim());
        const valueTexts = Array.from(obs.getElementsByTagName('ValueText')).map(n => String(n.textContent || '').trim());
        const valueTypes = Array.from(obs.getElementsByTagName('ValueType')).map(n => String(n.textContent || '').trim());

        const count = Math.max(codes.length, values.length, valueTexts.length, valueTypes.length);
        for (let i = 0; i < count; i++) {
          const candidateValue = values[i] ?? valueTexts[i] ?? values[0] ?? valueTexts[0] ?? '';
          if (!candidateValue) continue;
          if (!isModifierTarget(candidateValue)) continue;

          const candidateCode = (codes[i] ?? codes[0] ?? '') || '';
          const candidateVT = ((valueTypes[i] ?? valueTypes[0] ?? '') || '').toLowerCase();

          if (candidateCode === 'CPT modifier' || candidateVT === 'modifiers') {
            records.push({
              ClaimID: claimId,
              ActivityID: activityId,
              MemberID: normalizeMemberId(memberIdRaw),
              Date: encDate,
              OrderingClinician: clinician,
              Modifier: String(candidateValue).trim(),
              PayerID: payerId,
              ObsCode: candidateCode || '',
              VOINumber: ''
            });

            if (candidateCode !== 'CPT modifier' && candidateVT === 'modifiers') {
              console.debug('[LENIENT FALLBACK] matched by ValueType="Modifiers" (fallback)', { claimId, activityId, memberId: memberIdRaw, value: candidateValue, code: candidateCode });
            }

            found = true;
            break;
          }
        } // end fallback loop

        // if not found, we simply skip this observation
      }); // end observations
    }); // end activities
  }); // end claims
  return records;
}

// ----------------- XLSX matcher -----------------
function buildXlsxMatcher(rows) {
  const index = new Map();

  rows.forEach(r => {
    const member = normalizeMemberId(String(r['Card Number / DHA Member ID'] || ''));
    const date = normalizeDate(String(r['Ordered On'] || '')); // pass whole string; normalizeDate strips time
    const clinician = String(r['Clinician'] || '').trim().toUpperCase();
    r._VOINumber = String(r['VOI Number'] || '').trim();

    const key = [member, date, clinician].join('|');
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(r);
  });

  return {
    find(memberId, date, clinicianLicense) {
      const normalizedMember = normalizeMemberId(memberId);
      const normalizedDate = normalizeDate(date);
      const normalizedClinician = String(clinicianLicense || '').trim().toUpperCase();

      const fullKey = [normalizedMember, normalizedDate, normalizedClinician].join('|');
      const arr = index.get(fullKey);
      if (arr && arr.length) {
        console.log(`[MATCH] Full match found for Member: ${memberId}, Clinician: ${clinicianLicense}, Date: ${date}`);
        return arr[0];
      }

      // Check partial: Member + Clinician matched but date mismatch
      const partialKeyPattern = new RegExp(`^${escapeRegex(normalizedMember)}\\|.*\\|${escapeRegex(normalizedClinician)}$`);
      for (const k of index.keys()) {
        if (partialKeyPattern.test(k)) {
          console.warn(`[PARTIAL MATCH] Member and Clinician matched but date mismatch. XML date: ${date}, XLSX key: ${k}`);
          break;
        }
      }

      return null;
    },
    _index: index
  };
}

// ----------------- Validation / business rules -----------------
function isModifierTarget(val) { const v = String(val || '').trim(); return v === '24' || v === '52'; }
function expectedModifierForVOI(voi) {
  if (!voi) return '';
  const norm = normForCompare(voi);
  if (norm === normForCompare('VOI_D')) return '24';
  if (norm === normForCompare('VOI_EF1')) return '52';
  if (norm === normForCompare('EF1') || norm.endsWith('EF1')) return '52';
  if (norm === 'D' || norm.endsWith('D')) return '24';
  return '';
}
function normForCompare(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ----------------- Rendering -----------------
function renderResults(rows) {
  const container = el('outputTableContainer');
  if (!rows || !rows.length) {
    container.innerHTML = '<div>No results</div>';
    return;
  }

  // debug summary
  console.info('[DEBUG] total rows from mapping:', rows.length);
  const payerSet = new Set(rows.map(r => String(r.PayerID || '').trim().toUpperCase()).filter(x => x));
  console.info('[DEBUG] unique Payer IDs in results:', Array.from(payerSet).join(', ') || '(none)');

  // Filter only A001 and E001 (case-insensitive)
  const filteredRows = rows.filter(r => {
    const payer = String(r.PayerID || '').trim().toUpperCase();
    return payer === 'A001' || payer === 'E001';
  });

  if (!filteredRows.length) {
    container.innerHTML = '<div>No matching claims (only A001 and E001 shown)</div>';
    return;
  }

  // map filtered rows back to original lastResults indices for modal linking
  filteredRows.forEach(r => { r._originalIndex = rows.indexOf(r); });

  let prevClaimId = null, prevMemberId = null, prevActivityId = null;
  let html = `<table class="shared-table">
    <thead>
      <tr>
        <th>Claim ID</th>
        <th>Member ID</th>
        <th>Activity ID</th>
        <th>Ordering Clinician</th>
        <th>Observation CPT Modifier</th>
        <th>Observation Code</th>
        <th>VOI Number</th>
        <th>Payer ID</th>
        <th>Status</th>
        <th>Reason</th>
        <th>Eligibility Details</th>
      </tr>
    </thead>
    <tbody>`;

  filteredRows.forEach(r => {
    const showClaim = r.ClaimID !== prevClaimId;
    const showMember = showClaim || r.MemberID !== prevMemberId;
    const showActivity = showMember || r.ActivityID !== prevActivityId;

    // Determine row class from ValidationStatus
    const status = String(r.ValidationStatus || '').trim();
    let rowClass = 'invalid';
    if (status === 'Valid') rowClass = 'valid';
    else if (status === 'Unknown') rowClass = 'unknown';

    html += `<tr class="${rowClass}">
      <td>${showClaim ? escapeHtml(r.ClaimID) : ''}</td>
      <td>${showMember ? escapeHtml(r.MemberID) : ''}</td>
      <td>${showActivity ? escapeHtml(r.ActivityID) : ''}</td>
      <td>${escapeHtml(r.OrderingClinician)}</td>
      <td>${escapeHtml(r.Modifier)}</td>
      <td>${escapeHtml(r.ObsCode || '')}</td>
      <td>${escapeHtml(r.VOINumber || '')}</td>
      <td>${escapeHtml(r.PayerID)}</td>
      <td>${escapeHtml(r.ValidationStatus || '')}</td>
      <td>${escapeHtml(r.InvalidReason || '')}</td>
      <td>${r.EligibilityRow ? `<button type="button" class="details-btn eligibility-details" onclick="showEligibility(${r._originalIndex})">View</button>` : ''}</td>
    </tr>`;

    prevClaimId = r.ClaimID;
    prevMemberId = r.MemberID;
    prevActivityId = r.ActivityID;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

// ----------------- Utilities -----------------
function textValue(node, tag) { if (!node) return ''; const el = node.getElementsByTagName(tag)[0]; return el ? String(el.textContent || '').trim() : ''; }
function firstNonEmpty(arr) { for (const s of arr) if (s !== undefined && s !== null && String(s).trim() !== '') return String(s).trim(); return ''; }

// Only remove leading zeros per requirement; keep other characters intact
function normalizeMemberId(id) { return String(id || '').replace(/^0+/, '').trim(); }

// normalizeName retains spacing normalization and lowercases (used only in a few debug paths)
function normalizeName(name) { return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

// ----------------- PROGRESS (uses existing tables.css classes) -----------------

// Create progress DOM if not present (re-uses .loaded-count and .status-badge)
function ensureProgressElements() {
  if (el('progress-root')) return;

  const anchor = el('outputTableContainer') || document.body;

  const root = document.createElement('div');
  root.id = 'progress-root';
  root.style.margin = '8px 0 14px';
  root.innerHTML = `
    <div class="progress-row" style="display:flex;align-items:center;gap:10px;">
      <div id="progress-bar-container" role="progressbar" aria-valuemin="0" aria-valuemax="100"
           style="flex:1;height:14px;background:#ececec;border-radius:9px;overflow:hidden;position:relative;">
        <div id="progress-bar" style="height:100%; width:0%; background: linear-gradient(90deg,#4CAF50 0%, #2E7D32 100%); transition: width 420ms cubic-bezier(.2,.9,.3,1);"></div>
      </div>
      <div id="progress-text" class="loaded-count" style="min-width:120px;text-align:right;"></div>
      <div id="progress-badge" class="status-badge" style="display:inline-block; margin-left:6px;"></div>
    </div>
  `;

  anchor.parentNode.insertBefore(root, anchor);
}

// showProgress(percent, text)
// - percent: integer 0..100 for determinate, null or -1 for indeterminate (we display "Processing...")
// - text: optional string shown to the right of the percent
function showProgress(percent, text) {
  ensureProgressElements();
  const root = el('progress-root');
  const barContainer = el('progress-bar-container');
  const bar = el('progress-bar');
  const pText = el('progress-text');
  const badge = el('progress-badge');

  if (!root || !barContainer || !bar || !pText || !badge) return;

  const isIndeterminate = percent == null || Number(percent) < 0;
  const shouldShow = isIndeterminate || (Number(percent) > 0);

  // Hide when percent === 0 (keeps compatibility with previous reset behaviour)
  root.style.display = shouldShow ? 'block' : 'none';

  if (!shouldShow) {
    // reset
    bar.style.width = '0%';
    barContainer.removeAttribute('aria-valuenow');
    pText.textContent = '';
    badge.textContent = '';
    return;
  }

  if (isIndeterminate) {
    // Simple indeterminate presentation: animate by toggling width with JS (no extra CSS required)
    // We'll show a pulsing style by toggling a small animation using setTimeout
    bar.style.transition = 'none';
    bar.style.width = '30%';
    bar.style.transform = 'translateX(-10%)';
    // Use CSS transition to move it slightly for indeterminate feel
    setTimeout(() => { bar.style.transition = 'transform 1s linear'; bar.style.transform = 'translateX(80%)'; }, 50);
    pText.textContent = text ? String(text) : 'Processing...';
    badge.textContent = ''; // no percent badge when indeterminate
    barContainer.removeAttribute('aria-valuenow');
  } else {
    const pct = Math.max(0, Math.min(100, Math.round(Number(percent))));
    // determinate: set width (animated by CSS)
    bar.style.transition = 'width 420ms cubic-bezier(.2,.9,.3,1)';
    requestAnimationFrame(() => { bar.style.width = `${pct}%`; bar.style.transform = 'none'; });
    barContainer.setAttribute('aria-valuenow', String(pct));
    pText.textContent = text ? `${pct}% — ${String(text)}` : `${pct}%`;
    badge.textContent = `${pct}%`;
  }
}

// normalizeDate: robust handling of common formats; returns YYYY-MM-DD
function normalizeDate(input) {
  const s = String(input || '').trim();
  if (!s) return '';

  // Remove time portion if present
  const dateOnly = s.split(' ')[0].trim();

  // Check for DD/MM/YYYY or DD-MM-YYYY (day-first)
  let m = dateOnly.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = String(2000 + Number(y));
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!Number.isNaN(dt.getTime())) return toYMD(dt);
  }

  // Check for DD-MMM-YYYY e.g., 11-Aug-2025
  m = dateOnly.match(/^(\d{1,2})-([A-Za-z]+)-(\d{4})$/);
  if (m) {
    let [, d, mon, y] = m;
    const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    const dt = new Date(Number(y), monthMap[mon] ?? 0, Number(d));
    if (!Number.isNaN(dt.getTime())) return toYMD(dt);
  }

  // Try ISO/parseable numeric date
  let t = Date.parse(dateOnly);
  if (!Number.isNaN(t)) return toYMD(new Date(t));

  return dateOnly; // fallback (unchanged)
}

function toYMD(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function firstNonEmptyKey(obj, keys) {
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k) && String(obj[k]).trim() !== '') return obj[k];
  return null;
}

function makeWorkbookFromJson(json, sheetName) {
  const ws = XLSX.utils.json_to_sheet(json);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Results');
  return wb;
}

// ----------------- UI helpers -----------------
function el(id) { return document.getElementById(id); }
function fileEl(id) { const f = el(id); return f && f.files && f.files[0] ? f.files[0] : null; }

function toggleDownload(enabled) { const dl = el('download-button'); if (!dl) return; dl.disabled = !enabled; }

function message(text, color) { const m = el('messageBox'); if (!m) return; m.textContent = text || ''; m.style.color = color || ''; }

function showError(err) { message(err && err.message ? err.message : String(err), 'red'); showProgress(0, ''); toggleDownload(false); }

// ----------------- Modal logic -----------------
function showEligibility(index) {
  const row = lastResults[index];
  if (!row || !row.EligibilityRow) { alert('No eligibility data found for this claim.'); return; }

  const data = row.EligibilityRow;
  const keys = Object.keys(data);
  const details = keys.map(k => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(data[k])}</td></tr>`).join('');

  const modalHtml = `<div class="modal-content eligibility-modal modal-scrollable">
    <span class="close" onclick="closeEligibilityModal()">&times;</span>
    <h3>Eligibility Details</h3>
    <table class="eligibility-details">${details}</table>
    <div style="text-align:right;margin-top:10px;">
      <button class="details-btn eligibility-details" onclick="closeEligibilityModal()">Close</button>
    </div>
  </div>`;

  // Remove existing modal if present
  closeEligibilityModal();

  const modal = document.createElement('div');
  modal.id = "eligibilityModal";
  modal.className = "modal";
  modal.innerHTML = modalHtml;
  modal.addEventListener('click', e => { if (e.target === modal) closeEligibilityModal(); });
  document.body.appendChild(modal);
  modal.style.display = "flex";
}

function closeEligibilityModal() { const modal = el('eligibilityModal'); if (modal) modal.remove(); }

// ----------------- resetUI (keeps progress integration) -----------------
// resetUI() — keep previous behavior but hide/reset progress using showProgress(0)
function resetUI() {
  const container = el('outputTableContainer');
  if (container) container.innerHTML = '';
  toggleDownload(false);
  message('', '');
  // hide and reset progress bar (use showProgress(0) to hide)
  showProgress(0, '');
  lastResults = [];
  lastWorkbook = null;
}
