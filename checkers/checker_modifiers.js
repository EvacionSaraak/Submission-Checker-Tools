// checker_modifiers.js
// Plain script (no single enclosing function). Drop into checker_modifiers.html which must include SheetJS (XLSX).
// Expected DOM IDs: xml-file, xlsx-file, run-button, download-button, messageBox,
// outputTableContainer, progress-bar-container, progress-bar, progress-text

let lastResults = [];
let lastWorkbook = null;

document.addEventListener('DOMContentLoaded', () => {
  const runBtn = document.getElementById('run-button');
  const dlBtn = document.getElementById('download-button');
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
    const extracted = extractModifierRecords(xmlDoc); // records found in XML
    showProgress(45, `Found ${extracted.length} modifier record(s)`);

    const matcher = buildXlsxMatcher(xlsxObj.rows);
    showProgress(65, 'Matching to XLSX');

    const output = extracted.map(rec => {
      const match = matcher.find(rec.memberId, rec.date, rec.clinician);
      const voi = match ? String(firstNonEmptyKey(match, ['_VOINumber','VOI Number','VOI','VOI_Number','VOI Number ']) || '').trim() : '';
      const expected = expectedModifierForVOI(voi);
    
      return {
        ClaimID: rec.claimId || '',
        ActivityID: rec.activityId || '',
        OrderingClinician: rec.clinician || '',
        Modifier: String(rec.modifier || ''),
        VOINumber: voi || '',
        EligibilityRow: match || null   // <-- store full XLSX eligibility row
      };
    });
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

function handleDownload() {
  if (!lastWorkbook || !lastResults.length) {
    showError(new Error('Nothing to download'));
    return;
  }
  try {
    XLSX.writeFile(lastWorkbook, 'checker_modifiers_results.xlsx');
  } catch (err) {
    // fallback: rebuild workbook then save
    try {
      const wb = makeWorkbookFromJson(lastResults, 'checker_modifiers_results');
      XLSX.writeFile(wb, 'checker_modifiers_results.xlsx');
    } catch (e) {
      showError(e);
    }
  }
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

// IMPORTANT: sample XLSX has header row on row 2 — use range:1 so sheet_to_json uses row 2 as headers
async function readXlsx(file) {
  const arrayBuffer = await file.arrayBuffer();
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', range: 1 });
  return { rows, sheetName };
}

// ----------------- XML parsing & extraction -----------------
function parseXml(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/xml');
  const pe = doc.getElementsByTagName('parsererror')[0];
  if (pe) throw new Error('Invalid XML: ' + (pe.textContent || 'parse error').trim());
  return doc;
}

// Extract records where Observation contains Code === 'CPT modifier' and associated Value is '24' or '52'.
// Handles Observation forms where multiple Code/Value pairs live inside a single <Observation> element.
function extractModifierRecords(xmlDoc) {
  const records = [];
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  for (const claim of claims) {
    const claimId = textValue(claim, 'ID');
    const memberIdRaw = textValue(claim, 'MemberID');
    const payerId = textValue(claim, 'PayerID'); // <-- capture payer

    // Encounter may use <Date> or <Start>
    const encNode = claim.getElementsByTagName('Encounter')[0] || claim.getElementsByTagName('Encounte')[0];
    let encDateRaw = '';
    if (encNode) {
      encDateRaw = textValue(encNode, 'Date') || textValue(encNode, 'Start') || textValue(encNode, 'EncounterDate') || '';
    }
    const encDate = normalizeDate(encDateRaw);

    const activities = Array.from(claim.getElementsByTagName('Activity'));
    for (const act of activities) {
      const activityId = textValue(act, 'ID');
      const clinicianRaw = firstNonEmpty([
        textValue(act, 'OrderingClnician'),
        textValue(act, 'OrderingClinician'),
        textValue(act, 'Ordering_Clinician'),
        textValue(act, 'OrderingClin')
      ]);
      const clinician = normalizeName(clinicianRaw);

      // Observations
      const observations = Array.from(act.getElementsByTagName('Observation'));
      for (const obs of observations) {
        const childNodes = Array.from(obs.children || []);
        let lastCode = '';
        for (const child of childNodes) {
          const tag = child.tagName;
          const txt = String(child.textContent || '').trim();
          if (!txt) continue;
          if (tag === 'Code') {
            lastCode = txt;
            continue;
          }
          if (tag === 'Value' || tag === 'ValueText' || tag === 'ValueType') {
            if (lastCode === 'CPT modifier' && isModifierTarget(txt)) {
              records.push({
                claimId,
                activityId,
                memberId: normalizeMemberId(memberIdRaw),
                date: encDate,
                clinician,
                modifier: String(txt).trim(),
                payerId: payerId // <-- add payer to record
              });
            }
          }
        }

        // Pairwise Code/Value fallback
        const codes = Array.from(obs.getElementsByTagName('Code')).map(n => String(n.textContent || '').trim());
        const values = Array.from(obs.getElementsByTagName('Value')).map(n => String(n.textContent || '').trim());
        if (codes.length && values.length) {
          const count = Math.max(codes.length, values.length);
          for (let i = 0; i < count; i++) {
            const c = codes[i] ?? '';
            const v = values[i] ?? '';
            if (c === 'CPT modifier' && isModifierTarget(v)) {
              records.push({
                claimId,
                activityId,
                memberId: normalizeMemberId(memberIdRaw),
                date: encDate,
                clinician,
                modifier: String(v).trim(),
                payerId: payerId // <-- add payer to record
              });
            }
          }
        }
      }
    }
  }
  return records;
}

// ----------------- XLSX matcher -----------------
// Build map keyed by normalized member|date|clinician
function buildXlsxMatcher(rows) {
  const index = new Map();
  for (const r of rows) {
    const memberRaw = String(
      r['Card Number / DHA Member ID'] ??
      r['Card Number'] ??
      r['CardNumber'] ??
      r['Card No'] ??
      r['CardNo'] ??
      r['Member ID'] ??
      r['MemberID'] ?? ''
    );

    const orderedOnRaw = String(
      r['Ordered On'] ??
      r['OrderedOn'] ??
      r['Order Date'] ??
      r['OrderDate'] ??
      r['Ordered_On'] ??
      r['OrderedOn Date'] ??
      ''
    );

    const clinicianRaw = String(
      r['Clnician'] ??
      r['Clinician'] ??
      r['Clinician Name'] ??
      r['ClinicianName'] ??
      r['Ordering Clinician'] ??
      r['OrderingClinician'] ?? ''
    );

    const member = normalizeMemberId(memberRaw);
    const date = normalizeDate(orderedOnRaw);
    const clinician = normalizeName(clinicianRaw);

    // normalize and store VOINumber on row under consistent key for lookup later
    const voi = String(
      r['VOI Number'] ??
      r['VOI'] ??
      r['VOI_Number'] ??
      r['VOI Number '] ??
      r['VOI No'] ??
      r['VOIMessage'] ??
      r['VOI Message'] ??
      ''
    ).trim();
    r._VOINumber = voi;

    const key = [member, date, clinician].join('|');
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(r);
  }

  return {
    find(memberId, date, clinician) {
      const key = [normalizeMemberId(memberId), normalizeDate(date), normalizeName(clinician)].join('|');
      const arr = index.get(key);
      return arr && arr.length ? arr[0] : null;
    },
    _index: index
  };
}

// ----------------- Business rules -----------------
function isModifierTarget(val) {
  const v = String(val || '').trim();
  return v === '24' || v === '52';
}

function expectedModifierForVOI(voi) {
  if (!voi) return '';
  const v = String(voi).trim();
  if (v === 'VOI_D') return '24';
  if (v === 'VOI_EF1') return '52';
  return '';
}

// ----------------- Rendering (omit repeated ClaimID/ActivityID) -----------------
function renderResults(rows) {
  const container = document.getElementById('outputTableContainer');
  if (!rows || !rows.length) {
    container.innerHTML = '<div>No results</div>';
    return;
  }

  // Filter rows for PayerID D001 or A001
  const filteredRows = rows.filter(r => r.payerId === "D001" || r.payerId === "A001");

  if (!filteredRows.length) {
    container.innerHTML = '<div>No matching claims (only D001 and A001 shown)</div>';
    return;
  }

  let prevClaimId = null;
  let prevActivityId = null;

  let html = `
    <table class="shared-table">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Activity ID</th>
          <th>Ordering Clinician</th>
          <th>Observation CPT Modifier</th>
          <th>VOI Number</th>
          <th>Payer ID</th>
          <th>Eligibility Details</th>
        </tr>
      </thead>
      <tbody>
  `;

  filteredRows.forEach((r, idx) => {
    const showClaim = r.claimId !== prevClaimId;
    const showActivity = (r.claimId !== prevClaimId) || (r.activityId !== prevActivityId);

    const claimCell = showClaim ? escapeHtml(r.claimId) : '';
    const activityCell = showActivity ? escapeHtml(r.activityId) : '';

    prevClaimId = r.claimId;
    prevActivityId = r.activityId;

    let buttonHtml = '';
    if (r.EligibilityRow) {
      const keys = Object.keys(r.EligibilityRow);
      const displayValue = keys.length ? escapeHtml(r.EligibilityRow[keys[0]]) : "View";
      buttonHtml = `<button type="button" class="details-btn eligibility-details" onclick="showEligibility(${idx})">${displayValue}</button>`;
    }

    html += `<tr>
      <td>${claimCell}</td>
      <td>${activityCell}</td>
      <td>${escapeHtml(r.clinician)}</td>
      <td>${escapeHtml(r.modifier)}</td>
      <td>${escapeHtml(r.VOINumber)}</td>
      <td>${escapeHtml(r.payerId)}</td>
      <td>${buttonHtml}</td>
    </tr>`;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

// ----------------- Utilities -----------------
function textValue(node, tag) {
  if (!node) return '';
  const el = node.getElementsByTagName(tag)[0];
  return el ? String(el.textContent || '').trim() : '';
}

function firstNonEmpty(arr) {
  for (const s of arr) {
    if (s !== undefined && s !== null && String(s).trim() !== '') return String(s).trim();
  }
  return '';
}

// Only remove leading zeros per requirement; keep other characters intact
function normalizeMemberId(id) {
  return String(id || '').replace(/^0+/, '').trim();
}

function normalizeName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// normalizeDate: try ISO parse, then D/M/Y or M/D/Y heuristics; otherwise return trimmed original
function normalizeDate(input) {
  const s = String(input || '').trim();
  if (!s) return '';

  // If time present, Date.parse often works for formats like "13/08/2025 15:07" => parse may fail depending on locale.
  // Try to detect D/M/Y with optional time
  const datePart = s.split(' ')[0];
  // Try ISO / parseable
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return toYMD(new Date(t));

  // parse D/M/YYYY or D-M-YYYY
  let m = datePart.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = String(2000 + Number(y));
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!Number.isNaN(dt.getTime())) return toYMD(dt);
  }

  // parse M/D/YYYY (fallback)
  m = datePart.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, mo, d, y] = m;
    if (y.length === 2) y = String(2000 + Number(y));
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    if (!Number.isNaN(dt.getTime())) return toYMD(dt);
  }

  return s;
}

function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
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
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && String(obj[k]).trim() !== '') return obj[k];
  }
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

function toggleDownload(enabled) {
  const dl = el('download-button');
  if (!dl) return;
  dl.disabled = !enabled;
}

function showProgress(percent, text) {
  const barContainer = el('progress-bar-container');
  const bar = el('progress-bar');
  const pText = el('progress-text');
  if (barContainer) barContainer.style.display = percent > 0 ? 'block' : 'none';
  if (bar) bar.style.width = (percent || 0) + '%';
  if (pText) pText.textContent = text ? `${percent}% — ${text}` : `${percent}%`;
}

function message(text, color) {
  const m = el('messageBox');
  if (!m) return;
  m.textContent = text || '';
  m.style.color = color || '';
}

function showError(err) {
  message(err && err.message ? err.message : String(err), 'red');
  showProgress(0, '');
  toggleDownload(false);
}

// Modal logic for eligibility details
function showEligibility(index) {
    const row = lastResults[index];
    if (!row || !row.EligibilityRow) {
        alert('No eligibility data found for this claim.');
        return;
    }

    const data = row.EligibilityRow;
    const keys = Object.keys(data);

    const details = keys.map(k => `
        <tr>
            <th>${escapeHtml(k)}</th>
            <td>${escapeHtml(data[k])}</td>
        </tr>
    `).join('');

    const modalHtml = `
        <div class="modal-content eligibility-modal modal-scrollable">
            <span class="close" onclick="closeEligibilityModal()">&times;</span>
            <h3>Eligibility Details</h3>
            <table class="eligibility-details">
                ${details}
            </table>
            <div style="text-align:right; margin-top:10px;">
                <button class="details-btn eligibility-details" onclick="closeEligibilityModal()">Close</button>
            </div>
        </div>
    `;

    // Create modal container
    const modal = document.createElement('div');
    modal.id = "eligibilityModal";
    modal.className = "modal"; // apply CSS modal styling
    modal.innerHTML = modalHtml;

    // Close modal when clicking outside the content
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeEligibilityModal();
    });

    document.body.appendChild(modal);

    // Make modal visible
    modal.style.display = "flex";
}

function closeEligibilityModal() {
    const modal = document.getElementById('eligibilityModal');
    if (modal) modal.remove();
}
