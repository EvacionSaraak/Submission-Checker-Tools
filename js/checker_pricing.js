(function() {
  try {
    // checker_pricing.js

    let lastResults = [];
    let lastWorkbook = null;

document.addEventListener('DOMContentLoaded', () => {
  try {
    const runBtn = el('run-button'), dlBtn = el('download-button');
    if (runBtn) runBtn.addEventListener('click', handleRun);
    if (dlBtn) dlBtn.addEventListener('click', handleDownload);
    resetUI();
  } catch (error) {
    console.error('[PRICING] DOMContentLoaded initialization error:', error);
  }
});

// ----------------- Main run handler -----------------
async function handleRun() {
  resetUI();
  try {
    let xmlFile = fileEl('xml-file'), xlsxFile = fileEl('xlsx-file');
    
    // Fallback to unified checker files cache
    if (!xmlFile && window.unifiedCheckerFiles && window.unifiedCheckerFiles.xml) {
      xmlFile = window.unifiedCheckerFiles.xml;
      console.log('[PRICING] Using XML file from unified cache:', xmlFile.name);
    }
    if (!xlsxFile && window.unifiedCheckerFiles && window.unifiedCheckerFiles.pricing) {
      xlsxFile = window.unifiedCheckerFiles.pricing;
      console.log('[PRICING] Using pricing file from unified cache:', xlsxFile.name);
    }
    if (!xlsxFile) {
      try {
        const resp = await fetch('../resources/THIQA DENTAL PRICING.xlsx');
        if (!resp.ok) throw new Error('Resource not available');
        xlsxFile = resp;
        console.log('[PRICING] Using default THIQA DENTAL PRICING resource');
      } catch (e) {
        console.warn('[PRICING] Failed to load default THIQA resource:', e);
      }
    }

    if (!xmlFile || !xlsxFile) throw new Error(!xmlFile ? 'Please select an XML file.' : 'Please select an XML file and an XLSX file (the default THIQA Dental Pricing resource could not be loaded).');

    showProgress(5, 'Reading files');

    const [xmlText, xlsxObj, clinicianData, endoPricingRaw] = await Promise.all([
      readFileText(xmlFile),
      readXlsx(xlsxFile),
      fetch('../json/clinician_licenses.json').then(r => r.json()).catch(() => []),
      fetch('../json/endo_pricing.json').then(r => r.json()).catch(() => [])
    ]);
    showProgress(25, 'Parsing XML & XLSX');

    const xmlDoc = parseXml(xmlText);

    // Only process files where ReceiverID in the XML Header is D001
    const headerNode = xmlDoc.querySelector('Header');
    const receiverID = headerNode?.querySelector('ReceiverID')?.textContent.trim() || '';
    console.log(`[PRICING] ReceiverID: ${receiverID || '(MISSING)'}`);
    if (receiverID !== 'D001') {
      throw new Error(`Pricing checker only supports files with ReceiverID "D001". Found: "${receiverID || '(MISSING)'}"`);}

    const extracted = extractPricingRecords(xmlDoc);
    const matcher = buildPricingMatcher(xlsxObj.rows);

    const clinicianSpecialtyMap = new Map();
    (Array.isArray(clinicianData) ? clinicianData : []).forEach(e => {
      const lic = String(e['Phy Lic'] || '').trim();
      if (lic) clinicianSpecialtyMap.set(lic, String(e['Specialty'] || '').trim());
    });
    const endoPricingMap = new Map();
    (Array.isArray(endoPricingRaw) ? endoPricingRaw : []).forEach(e => {
      if (e.code) endoPricingMap.set(normalizeCode(e.code), e);
    });

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

    // Override with endo pricing for applicable codes (only for dates on or after Feb 20, 2026)
    const endoEntry = endoPricingMap.get(normalizeCode(rec.CPT));
    if (endoEntry) {
      const encounterDate = parseEncounterDate(rec.EncounterDate);
      const isAfterCutoff = encounterDate !== null && encounterDate >= ENDO_PRICING_CUTOFF;
      if (isAfterCutoff) {
        const isEndo = clinicianSpecialtyMap.get(rec.ClinicianLic || '') === 'Endodontics';
        refPrice = isEndo ? endoEntry.endo_price : endoEntry.gp_price;
      }
    }

    const ref = Number(refPrice ?? NaN);
  
    // Claimed net 0 -> Valid (changed from Unknown)
    if (xmlNet === 0) {
      status = 'Valid';
      remarks.push('Claimed Net is 0 (treated as Valid)');
    } else {
      if (xmlQty <= 0) remarks.push(xmlQty === 0 ? 'Quantity is 0 (invalid)' : 'Quantity is less than 0 (invalid)');
      if (!match && !endoEntry) remarks.push('No pricing match found');
      if (endoEntry && refPrice === null) remarks.push(`Code ${rec.CPT} is not available for GP clinicians`);
      if ((match || endoEntry) && refPrice !== null && Number.isNaN(ref)) remarks.push('Reference Net Price is not a number');
  
      if ((match || endoEntry) && refPrice !== null && !Number.isNaN(ref) && xmlQty > 0) {
        if (xmlNet === ref) status = 'Valid';
        else if ((xmlNet / xmlQty) === ref) status = 'Valid';
        // Special case for code 42702: allow if XML price is exactly double the reference
        // This code requires special handling where double the reference price is also valid
        else if (normalizeCode(rec.CPT) === '42702' && xmlNet === ref * 2) status = 'Valid';
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
    const tableElement = buildResultsTable(output);
    lastWorkbook = makeWorkbookFromJson(output, 'checker_pricing_results');
    toggleDownload(output.length > 0);

   // Count valid rows and show percentage with 2 decimals
  const validCount = output.filter(r => r.isValid).length;
  const totalCount = output.length;
  const numericPercent = totalCount ? (validCount / totalCount) * 100 : 0;
  const percentText = totalCount ? numericPercent.toFixed(2) : '0.00';
  const color = numericPercent === 100 ? 'green' : 'orange';
  message(`Completed — ${validCount}/${totalCount} rows correct (${percentText}%)`, color);
  return tableElement;
  } catch (err) { showError(err); return null; }
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
    const encounterNode = claim.getElementsByTagName('Encounter')[0];
    const facilityId = textValue(encounterNode, 'FacilityID') || '';
    const encounterDateStr = textValue(encounterNode, 'Start') || textValue(encounterNode, 'Date') || textValue(encounterNode, 'EncounterDate') || '';
    for (const act of activities) {
      const activityId = textValue(act, 'ID') || '';
      const cpt = firstNonEmpty([ textValue(act,'ActivityCode'), textValue(act,'CPTCode'), textValue(act,'Code') ]).trim();
      const net = firstNonEmpty([ textValue(act,'Net'), textValue(act,'GrossAmount'), textValue(act,'Price') ]).trim();
      const qty = firstNonEmpty([ textValue(act,'Quantity'), textValue(act,'Qty') ]).trim() || '0';
      const clinicianLic = firstNonEmpty([textValue(act, 'OrderingClinician'), textValue(act, 'Clinician')]).trim();
      records.push({ ClaimID: claimId, ActivityID: activityId, CPT: cpt, Net: net, Quantity: qty, FacilityID: facilityId, ClinicianLic: clinicianLic, EncounterDate: encounterDateStr });
    }
  }
  return records;
}

// Parse encounter date from "DD/MM/YYYY" or "DD/MM/YYYY HH:MM" format
function parseEncounterDate(dateStr) {
  if (!dateStr) return null;
  const datePart = dateStr.split(' ')[0];
  const [d, m, y] = datePart.split('/').map(Number);
  if (isNaN(d) || isNaN(m) || isNaN(y)) return null;
  return new Date(y, m - 1, d);
}

// Endo pricing cutoff date: February 20, 2026
const ENDO_PRICING_CUTOFF = new Date(2026, 1, 20); // Month is 0-indexed


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
function buildResultsTable(rows) {
  if (!rows || !rows.length) {
    const emptyDiv = document.createElement('div');
    emptyDiv.textContent = 'No results';
    return emptyDiv;
  }

  // Map rows to index for modal linking
  rows.forEach((r, i) => r._originalIndex = i);
  lastResults = rows.slice(); // ensure modal access

  const container = document.createElement('div');
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
    html += `<tr class="${cls}" data-claim-id="${escapeHtml(r.ClaimID || '')}">
      <td style="padding:6px;border:1px solid #ccc" class="claim-id-cell">${showClaim ? escapeHtml(r.ClaimID) : ''}</td>
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
  return container;
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
