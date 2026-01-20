(function() {
  try {
    // checker_modifiers.js
    let lastResults = [];
    let lastWorkbook = null;

document.addEventListener('DOMContentLoaded', () => {
  try {
    const runBtn = el('run-button');
    const dlBtn = el('download-button');
    if (runBtn) runBtn.addEventListener('click', handleRun);
    if (dlBtn) dlBtn.addEventListener('click', handleDownload);
    resetUI();
  } catch (error) {
    console.error('[MODIFIERS] DOMContentLoaded initialization error:', error);
  }
});

// ----------------- Main run handler -----------------
async function handleRun() {
  resetUI();
  try {
    let xmlFile = fileEl('xml-file');
    let xlsxFile = fileEl('xlsx-file');
    
    // Fallback to unified checker files cache
    if (!xmlFile && window.unifiedCheckerFiles && window.unifiedCheckerFiles.xml) {
      xmlFile = window.unifiedCheckerFiles.xml;
      console.log('[MODIFIERS] Using XML file from unified cache:', xmlFile.name);
    }
    if (!xlsxFile && window.unifiedCheckerFiles && window.unifiedCheckerFiles.eligibility) {
      xlsxFile = window.unifiedCheckerFiles.eligibility;
      console.log('[MODIFIERS] Using eligibility file from unified cache:', xlsxFile.name);
    }
    
    if (!xmlFile || !xlsxFile) throw new Error('Please select both an XML file and an XLSX file.');

    const [xmlText, xlsxObj] = await Promise.all([readFileText(xmlFile), readXlsx(xlsxFile)]);
    const xmlDoc = parseXml(xmlText);
    const extracted = extractModifierRecords(xmlDoc);

    const matcher = buildXlsxMatcher(xlsxObj.rows);

    const output = extracted.map(rec => {
      const xmlDate = normalizeDate(rec.Date);
      const match = matcher.find(rec.MemberID, xmlDate, rec.OrderingClinician);
    
      const remarks = [];
    
      // Determine VOI number: prefer matched eligibility, fallback to XML
      let voiNumber = '';
      if (match) {
        voiNumber = String(match['VOI Number'] || '').trim(); // <-- VOI from eligibility
      } else {
        voiNumber = rec.VOINumber || ''; // fallback to XML
      }
    
      // Check Observation Code
      if (rec.ObsCode !== 'CPT modifier') {
        remarks.push(`Observation Code incorrect; expected "CPT modifier" but found "${rec.ObsCode}"`);
      }
    
      // Check VOI against modifier
      const voiNorm = normForCompare(voiNumber);
      if (rec.Modifier === '52' && voiNorm !== normForCompare('VOI_EF1')) remarks.push(`Modifier 52 does not match VOI (expected VOI_EF1).`);
      if (rec.Modifier === '24' && voiNorm !== normForCompare('VOI_D')) remarks.push(`Modifier 24 does not match VOI (expected VOI_D).`);
    
      if (!match) remarks.push('No matching eligibility found');
    
      return {
        ClaimID: rec.ClaimID || '',
        MemberID: rec.MemberID || '',
        ActivityID: rec.ActivityID || '',
        OrderingClinician: rec.OrderingClinician || '',
        Modifier: rec.Modifier || '',
        ObsCode: rec.ObsCode || '',
        VOINumber: voiNumber,
        PayerID: rec.PayerID || '',
        EligibilityRow: match || null,
        isValid: remarks.length === 0,
        Remarks: remarks.join('; ')
      };
    });

    lastResults = output;
    const tableElement = buildResultsTable(output);
    lastWorkbook = makeWorkbookFromJson(output, 'checker_modifiers_results');
    toggleDownload(output.length > 0);

    // Count valid rows and display percentage
    const validCount = output.filter(r => r.isValid).length;
    const totalCount = output.length;
    const percent = totalCount ? Math.round((validCount / totalCount) * 100) : 0;
    message(`Completed — ${validCount}/${totalCount} rows correct (${percent}%)`, percent === 100 ? 'green' : 'orange');

    return tableElement;
  } catch (err) {
    showError(err);
    return null;
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
  // Preprocess XML to replace unescaped & with "and" for parseability
  const xmlContent = text.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g, "and");
  const doc = new DOMParser().parseFromString(xmlContent, 'text/xml');
  const pe = doc.getElementsByTagName('parsererror')[0];
  if (pe) throw new Error('Invalid XML: ' + (pe.textContent || 'parse error').trim());
  return doc;
}

// Extract records where Observation contains Code === 'CPT modifier' and Value is '24' or '52'
// ----------------- XML parsing & extraction -----------------
function extractModifierRecords(xmlDoc) {
  const records = [];
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));

  claims.forEach(claim => {
    const claimId = textValue(claim, 'ID');
    const payerId = textValue(claim, 'PayerID');
    const memberIdRaw = textValue(claim, 'MemberID');

    const encNode = claim.getElementsByTagName('Encounter')[0] || claim.getElementsByTagName('Encounte')[0];
    const encDateRaw = encNode ? (textValue(encNode, 'Date') || textValue(encNode, 'Start') || textValue(encNode, 'EncounterDate') || '') : '';
    const encDate = normalizeDate(encDateRaw);

    const activities = Array.from(claim.getElementsByTagName('Activity'));
    activities.forEach(act => {
      const activityId = textValue(act, 'ID');
      const clinician = firstNonEmpty([
        textValue(act, 'OrderingClnician'),
        textValue(act, 'OrderingClinician'),
        textValue(act, 'Ordering_Clinician'),
        textValue(act, 'OrderingClin')
      ]).trim().toUpperCase();

      const observations = Array.from(act.getElementsByTagName('Observation'));
      observations.forEach(obs => {
        const code = textValue(obs, 'Code');
        const voiVal = textValue(obs, 'Value') || textValue(obs, 'ValueText') || '';
        const valueType = textValue(obs, 'ValueType') || '';

        // Only accept observations with ValueType of "Modifiers"
        if (!valueType || valueType.trim().toLowerCase() !== 'modifiers') return;

        // Only accept valid VOI values
        let modifier = '';
        const voiNorm = (voiVal || '').toUpperCase().replace(/[_\s]/g, '');
        if (voiNorm === 'VOI_D' || voiNorm === '24') modifier = '24';
        else if (voiNorm === 'VOI_EF1' || voiNorm === '52') modifier = '52';
        else return; // skip anything else

        // Check for exact Observation Code match
        const remarks = [];
        if (code !== 'CPT modifier') {
          remarks.push(`Observation Code incorrect; expected "CPT modifier" but found "${code}"`);
        }

        records.push({
          ClaimID: claimId,
          ActivityID: activityId,
          MemberID: normalizeMemberId(memberIdRaw),
          Date: encDate,
          OrderingClinician: clinician,
          Modifier: modifier,
          PayerID: payerId,
          ObsCode: code,
          VOINumber: voiVal,
          Remarks: remarks.join('; ')
        });
      });
    });
  });

  // Deduplicate rows based on key
  const seen = new Set();
  return records.filter(r => {
    const key = [r.ClaimID, r.ActivityID, r.MemberID, r.Modifier, r.ObsCode].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ----------------- XLSX matcher -----------------
function buildXlsxMatcher(rows) {
  const index = new Map();

  // Build index
  rows.forEach(r => {
    const member = normalizeMemberId(String(r['Card Number / DHA Member ID'] || ''));
    const date = normalizeDate(String(r['Ordered On'] || ''));
    const clinician = String(r['Clinician'] || '').trim().toUpperCase();
    r._VOINumber = String(r['VOI Number'] || '').trim();
    r._used = false; // add used flag

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
        // find first unused eligibility
        const eligibleRow = arr.find(r => !r._used);
        if (eligibleRow) {
          eligibleRow._used = true; // mark as used
          console.log(`[MATCH] Full match found for Member: ${memberId}, Clinician: ${clinicianLicense}, Date: ${date}`);
          return eligibleRow;
        }
      }

      // Partial match logging (member+clinician, date mismatch)
      const partialKeyPattern = new RegExp(`^${escapeRegex(normalizedMember)}\\|.*\\|${escapeRegex(normalizedClinician)}$`);
      for (const k of index.keys()) {
        if (partialKeyPattern.test(k)) {
          console.warn(`[PARTIAL MATCH] Member and Clinician matched but date mismatch. XML date: ${date}, XLSX key: ${k}`);
          break;
        }
      }

      return null;
    },

    _index: index // expose index for debugging
  };
}

// ----------------- Validation / business rules -----------------
function isModifierTarget(val) { const v = String(val || '').trim(); return v === '24' || v === '52'; }
function normForCompare(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function expectedModifierForVOI(voi) {
  if (!voi) return '';
  const v = String(voi || '').toUpperCase().replace(/[_\s]/g, '');
  if (v === 'VOID') return '24';      // VOI_D
  if (v === 'VOIEF1') return '52';    // VOI_EF1
  return '';
}

// ----------------- Rendering -----------------
function buildResultsTable(rows) {
  if (!rows || !rows.length) {
    const emptyDiv = document.createElement('div');
    emptyDiv.textContent = 'No results';
    return emptyDiv;
  }

  console.info('[DEBUG] total rows from mapping:', rows.length);
  const payerSet = new Set(rows.map(r => String(r.PayerID || '').trim().toUpperCase()).filter(x => x));
  console.info('[DEBUG] unique Payer IDs in results:', Array.from(payerSet).join(', ') || '(none)');

  // Filter only A001 and E001 (case-insensitive)
  const filteredRows = rows.filter(r => {
    const payer = String(r.PayerID || '').trim().toUpperCase();
    return payer === 'A001' || payer === 'E001';
  });

  if (!filteredRows.length) {
    const emptyDiv = document.createElement('div');
    emptyDiv.textContent = 'No matching claims (only A001 and E001 shown)';
    return emptyDiv;
  }

  // Map filtered rows back to original lastResults indices for modal linking
  filteredRows.forEach(r => { r._originalIndex = rows.indexOf(r); });

  const container = document.createElement('div');
  let prevClaimId = null, prevMemberId = null, prevActivityId = null;
  let validCount = 0;

  let html = `<table class="table table-striped table-bordered" style="width:100%;border-collapse:collapse">
    <thead>
      <tr>
        <th style="padding:8px;border:1px solid #ccc">Claim ID</th>
        <th style="padding:8px;border:1px solid #ccc">Member ID</th>
        <th style="padding:8px;border:1px solid #ccc">Activity ID</th>
        <th style="padding:8px;border:1px solid #ccc">Ordering Clinician</th>
        <th style="padding:8px;border:1px solid #ccc">Observation Code</th>
        <th style="padding:8px;border:1px solid #ccc">Observation CPT Modifier</th>
        <th style="padding:8px;border:1px solid #ccc">VOI Number</th>
        <th style="padding:8px;border:1px solid #ccc">Payer ID</th>
        <th style="padding:8px;border:1px solid #ccc">Remarks</th>
        <th style="padding:8px;border:1px solid #ccc">Eligibility Details</th>
      </tr>
    </thead>
    <tbody>`;

  filteredRows.forEach(r => {
    const showClaim = r.ClaimID !== prevClaimId;
    const showMember = showClaim || r.MemberID !== prevMemberId;
    const showActivity = showMember || r.ActivityID !== prevActivityId;

    // Build remarks
    const remarks = [];
    if (r.ObsCode !== 'CPT modifier') remarks.push(`Observation Code is "${r.ObsCode}" (expected "CPT modifier").`);

    const voiNorm = normForCompare(r.VOINumber || '');
    if (r.Modifier === '52' && voiNorm !== normForCompare('VOI_EF1')) remarks.push(`Modifier 52 does not match VOI (expected VOI_EF1).`);
    if (r.Modifier === '24' && voiNorm !== normForCompare('VOI_D')) remarks.push(`Modifier 24 does not match VOI (expected VOI_D).`);
    if (!r.EligibilityRow) remarks.push('No matching eligibility found.');

    const isValid = remarks.length === 0;
    html += `<tr class="${isValid ? 'table-success' : 'table-danger'}">
      <td style="padding:6px;border:1px solid #ccc">${showClaim ? escapeHtml(r.ClaimID) : ''}</td>
      <td style="padding:6px;border:1px solid #ccc">${showMember ? escapeHtml(r.MemberID) : ''}</td>
      <td style="padding:6px;border:1px solid #ccc">${showActivity ? escapeHtml(r.ActivityID) : ''}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.OrderingClinician)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.ObsCode || '')}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.Modifier)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.VOINumber || '')}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.PayerID)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(remarks.join('; ') || 'OK')}</td>
      <td style="padding:6px;border:1px solid #ccc">${r.EligibilityRow ? `<button type="button" class="details-btn eligibility-details" onclick="showEligibility(${r._originalIndex})">View</button>` : ''}</td>
    </tr>`;

    prevClaimId = r.ClaimID;
    prevMemberId = r.MemberID;
    prevActivityId = r.ActivityID;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
  return container;
}

// ----------------- Utilities -----------------
function textValue(node, tag) { if (!node) return ''; const el = node.getElementsByTagName(tag)[0]; return el ? String(el.textContent || '').trim() : ''; }
function firstNonEmpty(arr) { for (const s of arr) if (s !== undefined && s !== null && String(s).trim() !== '') return String(s).trim(); return ''; }

// Only remove leading zeros per requirement; keep other characters intact
function normalizeMemberId(id) { return String(id || '').replace(/^0+/, '').trim(); }

// normalizeName retains spacing normalization and lowercases (used only in a few debug paths)
function normalizeName(name) { return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

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

function resetUI() {
  const container = el('outputTableContainer');
  if (container) container.innerHTML = '';
  toggleDownload(false);
  message('', '');
  showProgress(0, '');
  lastResults = [];
  lastWorkbook = null;
}

function toggleDownload(enabled) { const dl = el('download-button'); if (!dl) return; dl.disabled = !enabled; }

function showProgress(percent, text) {
  const barContainer = el('progress-bar-container'), bar = el('progress-bar'), pText = el('progress-text');
  if (barContainer) barContainer.style.display = percent > 0 ? 'block' : 'none';
  if (bar) bar.style.width = (percent || 0) + '%';
  if (pText) pText.textContent = text ? `${percent}% — ${text}` : `${percent}%`;
}

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

// Unified checker entry point
window.runModifiersCheck = async function() {
  if (typeof handleRun === 'function') {
    return await handleRun();
  } else {
    console.error('handleRun function not found');
    return null;
  }
};

  } catch (error) {
    console.error('[CHECKER-ERROR] Failed to load checker:', error);
    console.error(error.stack);
  }
})();
