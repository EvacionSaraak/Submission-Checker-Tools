// checker_pricing.js

let lastResults = [];
let lastWorkbook = null;

document.addEventListener('DOMContentLoaded', () => {
  const runBtn = el('run-button'), dlBtn = el('download-button');
  if (runBtn) runBtn.addEventListener('click', handleRun);
  if (dlBtn) dlBtn.addEventListener('click', handleDownload);
  resetUI();
});

// ----------------- Main run handler (modified to treat Unknown as valid for the summary) -----------------
async function handleRun() {
  resetUI();
  try {
    const xmlFile = fileEl('xml-file'), xlsxFile = fileEl('xlsx-file');
    if (!xmlFile || !xlsxFile) throw new Error('Please select both an XML file and an XLSX file.');

    showProgress(5, 'Reading files');

    const [xmlText, xlsxObj] = await Promise.all([readFileText(xmlFile), readXlsx(xlsxFile)]);
    showProgress(25, 'Parsing XML & XLSX');

    const xmlDoc = parseXml(xmlText);
    const extracted = extractPricingRecords(xmlDoc);
    const matcher = buildPricingMatcher(xlsxObj.rows);

    showProgress(50, 'Comparing records');

    const output = extracted.map(rec => {
    const remarks = []; let status = 'Invalid';
    const match = matcher.find(rec.CPT);
    const xmlNet = Number(rec.Net || 0), xmlQty = Number(rec.Quantity || 0);
  
    // Determine reference price based on Facility ID
    let refPrice = '';
    if (match) {
      const facility = rec.FacilityID || '';
      refPrice = (facility === 'MF5357' || facility === 'MF7231' || facility === 'MF232') ?
        match._secondaryPrice : match._primaryPrice;
    }
    const ref = Number(refPrice || 0);
  
    // Claimed net 0 -> Unknown
    if (xmlNet === 0) status = 'Unknown', remarks.push('Claimed Net is 0 (treated as Unknown)');
    else {
      if (xmlQty <= 0) remarks.push(xmlQty === 0 ? 'Quantity is 0 (invalid)' : 'Quantity is less than 0 (invalid)');
      if (!match) remarks.push('No pricing match found');
      if (match && Number.isNaN(ref)) remarks.push('Reference Net Price is not a number');
  
      if (match && !Number.isNaN(ref) && xmlQty > 0) {
        if (xmlNet === ref) status = 'Valid';
        else if ((xmlNet / xmlQty) === ref) status = 'Valid';
        else remarks.push(`Claimed Net ${xmlNet} does not match Reference ${ref}`);
      }
    }
  
    return {
      ClaimID: rec.ClaimID || '',
      ActivityID: rec.ActivityID || '',
      CPT: rec.CPT || '',
      ClaimedNet: rec.Net || '',
      ClaimedQty: rec.Quantity || '',
      ReferenceNetPrice: refPrice || '',
      PricingRow: match || null,
      XmlRow: rec,
      isValid: status === 'Valid',
      status,
      Remarks: remarks.join('; ')
    };
  });

    lastResults = output;
    renderResults(output);
    lastWorkbook = makeWorkbookFromJson(output, 'checker_pricing_results');
    toggleDownload(output.length > 0);

   // Treat Unknown as valid and show percentage with 2 decimals
  const validCount = output.filter(r => r.isValid || String(r.status || '').toLowerCase() === 'unknown').length;
  const totalCount = output.length;
  const numericPercent = totalCount ? (validCount / totalCount) * 100 : 0;
  const percentText = totalCount ? numericPercent.toFixed(2) : '0.00';
  const color = numericPercent === 100 ? 'green' : 'orange';
  message(`Completed — ${validCount}/${totalCount} rows correct (${percentText}%)`, color);
  } catch (err) { showError(err); }
}

// ----------------- Download -----------------
function handleDownload() {
  if (!lastWorkbook || !lastResults.length) { showError(new Error('Nothing to download')); return; }
  try { XLSX.writeFile(lastWorkbook, 'checker_pricing_results.xlsx'); }
  catch(err) { try { XLSX.writeFile(makeWorkbookFromJson(lastResults, 'checker_pricing_results'), 'checker_pricing_results.xlsx'); } catch(e) { showError(e); } }
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
  // Header on row 1 for your sample -> no range
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
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

// Extract pricing-related records (ActivityCode / Code) and Net/Quantity
function extractPricingRecords(xmlDoc) {
  const records = [];
  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  for (const claim of claims) {
    const claimId = textValue(claim, 'ID') || '';
    const activities = Array.from(claim.getElementsByTagName('Activity'));
    const facilityId = textValue(claim.getElementsByTagName('Encounter')[0], 'FacilityID') || '';
    for (const act of activities) {
      const activityId = textValue(act, 'ID') || '';
      const cpt = firstNonEmpty([ textValue(act,'ActivityCode'), textValue(act,'CPTCode'), textValue(act,'Code') ]).trim();
      const net = firstNonEmpty([ textValue(act,'Net'), textValue(act,'GrossAmount'), textValue(act,'Price') ]).trim();
      const qty = firstNonEmpty([ textValue(act,'Quantity'), textValue(act,'Qty') ]).trim() || '0';
      records.push({ ClaimID: claimId, ActivityID: activityId, CPT: cpt, Net: net, Quantity: qty, FacilityID: facilityId });
    }
  }
  return records;
}


// ----------------- Normalization / Matcher -----------------
function normalizeCode(c) { return String(c || '').trim().replace(/^0+/, ''); }

// ----------------- Facility-aware matcher -----------------
function buildPricingMatcher(rows) {
  const index = new Map();
  rows.forEach(r => {
    const code = normalizeCode(r["Code"] || ""); if (!code) return;

    // Normalize headers: trim, collapse whitespace/newlines
    const keys = Object.keys(r).reduce((map, k) => {
      const norm = k.replace(/\s+/g, " ").trim().toLowerCase();
      map[norm] = k;
      return map;
    }, {});

    const primaryKey = keys["other facilities"];
    const secondaryKey = keys["alyahar, emirates, al wagan"];

    r._primaryPrice = primaryKey ? Number(String(r[primaryKey]).replace(/[^0-9.\-]/g,'')) : null;
    r._secondaryPrice = secondaryKey ? Number(String(r[secondaryKey]).replace(/[^0-9.\-]/g,'')) : null;

    if (!index.has(code)) index.set(code, []); index.get(code).push(r);
  });

  return {
    find(code) { const key = normalizeCode(code); const arr = index.get(key); return arr && arr.length ? arr[0] : null; },
    _index: index
  };
}

// ----------------- Modified: renderResults (hide repeated Claim ID) -----------------
function renderResults(rows) {
  const container = el('outputTableContainer');
  if (!rows || !rows.length) { container.innerHTML = '<div>No results</div>'; return; }

  // Map rows to index for modal linking
  rows.forEach((r, i) => r._originalIndex = i);
  lastResults = rows.slice(); // ensure modal access

  let prevClaimId = null;
  let html = `<table class="table table-striped table-bordered" style="width:100%;border-collapse:collapse"><thead><tr>
    <th style="padding:8px;border:1px solid #ccc">Claim ID</th>
    <th style="padding:8px;border:1px solid #ccc">Activity ID</th>
    <th style="padding:8px;border:1px solid #ccc">Code</th>
    <th style="padding:8px;border:1px solid #ccc">Claimed Net</th>
    <th style="padding:8px;border:1px solid #ccc">Quantity</th>
    <th style="padding:8px;border:1px solid #ccc">Reference Net Price</th>
    <th style="padding:8px;border:1px solid #ccc">Status</th>
    <th style="padding:8px;border:1px solid #ccc">Remarks</th>
    <th style="padding:8px;border:1px solid #ccc">Compare</th>
  </tr></thead><tbody>`;

  for (const r of rows) {
    const status = String(r.status || 'Invalid').toLowerCase();
    // Map status to Bootstrap classes
    const cls = status === 'ok' || status === 'valid' ? 'table-success' : 'table-danger';
    const showClaim = r.ClaimID !== prevClaimId;
    html += `<tr class="${cls}">
      <td style="padding:6px;border:1px solid #ccc">${showClaim ? escapeHtml(r.ClaimID) : ''}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.ActivityID)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.CPT)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.ClaimedNet)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.ClaimedQty)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.ReferenceNetPrice)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.status)}</td>
      <td style="padding:6px;border:1px solid #ccc">${escapeHtml(r.Remarks || 'OK')}</td>
      <td style="padding:6px;border:1px solid #ccc">${r.PricingRow ? `<button type="button" class="details-btn" onclick="showComparisonModal(${r._originalIndex})">View</button>` : ''}</td>
    </tr>`;
    prevClaimId = r.ClaimID;
  }

  html += `</tbody></table>`;
  container.innerHTML = html;
}

// ----------------- Modal comparison -----------------
function showComparisonModal(index) {
  const row = lastResults[index];
  if (!row) { alert('Row not found'); return; }
  const xml = row.XmlRow || {};
  const xlsx = row.PricingRow || {};
  const refPrice = String(row.ReferenceNetPrice || '');
  const xmlNet = Number(xml.Net || 0), xmlQty = Number(xml.Quantity || 0);
  const unitCalc = xmlQty > 0 ? (xmlNet / xmlQty) : null;
  const unitCalcText = unitCalc !== null ? String(unitCalc) : 'N/A';

  const xmlTable = `<table class="compare-table">
    <tr><th colspan="2">XML (Claim)</th></tr>
    <tr><th>Code</th><td>${escapeHtml(xml.CPT || row.CPT)}</td></tr>
    <tr><th>Net</th><td>${escapeHtml(String(xml.Net || row.ClaimedNet || ''))}</td></tr>
    <tr><th>Quantity</th><td>${escapeHtml(String(xml.Quantity || row.ClaimedQty || ''))}</td></tr>
    <tr><th>Net ÷ Qty</th><td>${escapeHtml(unitCalcText)}</td></tr>
  </table>`;

  const xlsxTable = `<table class="compare-table">
    <tr><th colspan="2">XLSX (Pricing)</th></tr>
    <tr><th>Code</th><td>${escapeHtml(String(firstNonEmptyKey(xlsx, ['Code','CPT']) || ''))}</td></tr>
    <tr><th>Net Price</th><td>${escapeHtml(refPrice)}</td></tr>
  </table>`;

  const modalHtml = `<div class="modal-content pricing-modal modal-scrollable">
    <span class="close" onclick="closeComparisonModal()">&times;</span>
    <h3>Price Comparison</h3>
    <div style="display:flex;gap:20px;align-items:flex-start;">${xmlTable}${xlsxTable}</div>
    <div style="text-align:right;margin-top:10px;">
      <button class="details-btn" onclick="closeComparisonModal()">Close</button>
    </div>
  </div>`;

  closeComparisonModal();
  const modal = document.createElement('div');
  modal.id = "comparisonModal";
  modal.className = "modal";
  modal.innerHTML = modalHtml;
  modal.addEventListener('click', e => { if (e.target === modal) closeComparisonModal(); });
  document.body.appendChild(modal);
  modal.style.display = "flex";
}

function closeComparisonModal() { const modal = el('comparisonModal'); if (modal) modal.remove(); }

// ----------------- Utilities -----------------
function textValue(node, tag) { if (!node) return ''; const eln = node.getElementsByTagName(tag)[0]; return eln ? String(eln.textContent || '').trim() : ''; }
function firstNonEmpty(arr) { for (const s of arr) if (s !== undefined && s !== null && String(s).trim() !== '') return String(s).trim(); return ''; }
function firstNonEmptyKey(obj, keys) { for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k) && String(obj[k]).trim() !== '') return obj[k]; return null; }
function makeWorkbookFromJson(json, sheetName) { const ws = XLSX.utils.json_to_sheet(json); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Results'); return wb; }

// ----------------- UI helpers -----------------
function el(id) { return document.getElementById(id); }
function fileEl(id) { const f = el(id); return f && f.files && f.files[0] ? f.files[0] : null; }

function resetUI() {
  const container = el('outputTableContainer'); if (container) container.innerHTML = '';
  toggleDownload(false); message('', ''); showProgress(0, ''); lastResults = []; lastWorkbook = null;
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

// ----------------- Helpers: escaping -----------------
function escapeHtml(str) { return String(str == null ? '' : str).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

// Unified checker entry point
window.runPricingCheck = async function() {
  if (typeof handleRun === 'function') {
    await handleRun();
  } else {
    console.error('handleRun function not found');
  }
};
