// checker_modifiers.js
// Reads an XML file and an XLSX file (from checker_modifiers.html).
// Finds Observation nodes where <Code> === 'CPT modifier' and <Value> === '24' or '52'.
// For each such observation it records ClaimID, ActivityID, MemberID, Encounter Date, OrderingClinician, Modifier.
// Then attempts to match each record to the XLSX by:
//   MemberID  <-> 'Card Number' (ignore leading zeros when matching)
//   Date      <-> 'Ordered On' (normalized to YYYY-MM-DD for comparison)
//   Clinician <-> 'Clnician' (whitespace trimmed, case-insensitive)
// When a match is found, reads the XLSX 'VOI Number' value and expects:
//   'VOI_D'    => modifier must be '24'
//   'VOI_EF1'  => modifier must be '52'
// Output table columns: ClaimID, ActivityID, OrderingClinician, CPT Modifier, VOI Number, Status ('valid' or 'unknown').
// Includes download button to export results to XLSX.

(function () {
  'use strict';

  // DOM elements (IDs must match checker_modifiers.html)
  const xmlInput = document.getElementById('xml-file');
  const xlsxInput = document.getElementById('xlsx-file');
  const runButton = document.getElementById('run-button');
  const downloadButton = document.getElementById('download-button');
  const messageBox = document.getElementById('messageBox');
  const resultsContainer = document.getElementById('outputTableContainer');
  const progressBarContainer = document.getElementById('progress-bar-container');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');

  let lastResults = [];

  // ---------- Event wiring ----------
  runButton.addEventListener('click', async () => {
    resetUI();
    try {
      const xmlFile = xmlInput.files[0];
      const xlsxFile = xlsxInput.files[0];
      if (!xmlFile || !xlsxFile) throw new Error('Select both XML and XLSX files.');

      showProgress(5, 'Reading files...');
      const [xmlText, xlsx] = await Promise.all([readFileText(xmlFile), readXlsx(xlsxFile)]);
      showProgress(20, 'Parsing XML...');

      const xmlDoc = parseXml(xmlText);
      const extracted = extractModifierRecords(xmlDoc); // array of records from XML
      showProgress(45, `Found ${extracted.length} modifier record(s) in XML.`);

      const matcher = buildXlsxMatcher(xlsx.rows);
      showProgress(65, 'Matching against XLSX...');

      const output = extracted.map(rec => {
        const match = matcher.find(rec.memberId, rec.date, rec.clinician);
        const voi = match ? String(match['VOI Number'] || match['VOI'] || '').trim() : '';
        const expected = expectedModifierForVOI(voi);
        const status = expected && String(rec.modifier) === String(expected) ? 'valid' : 'unknown';
        return {
          ClaimID: rec.claimId || '',
          ActivityID: rec.activityId || '',
          OrderingClinician: rec.clinician || '',
          Modifier: String(rec.modifier || ''),
          VOINumber: voi || '',
          Status: status
        };
      });

      lastResults = output;
      renderResults(output);
      showProgress(100, 'Done');
      downloadButton.disabled = output.length === 0;
      messageBox.style.color = 'green';
      messageBox.textContent = `Completed — ${output.length} rows processed.`;
    } catch (err) {
      showError(err);
    }
  });

  downloadButton.addEventListener('click', () => {
    if (!lastResults || !lastResults.length) return;
    const ws = XLSX.utils.json_to_sheet(lastResults);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'checker_modifiers_results');
    XLSX.writeFile(wb, 'checker_modifiers_results.xlsx');
  });

  // ---------- File helpers ----------
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error || new Error('Failed to read file'));
      fr.readAsText(file);
    });
  }

  async function readXlsx(file) {
    const arrayBuffer = await file.arrayBuffer();
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    // Use defval:'' to avoid undefined
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    return { rows, sheetName };
  }

  // ---------- XML parsing & extraction ----------
  function parseXml(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const pe = doc.getElementsByTagName('parsererror')[0];
    if (pe) {
      // parsererror text can be long; give short message
      throw new Error('Invalid XML: ' + (pe.textContent || 'parse error').trim());
    }
    return doc;
  }

  // Return array of records: { claimId, activityId, memberId, date (Y-M-D or original), clinician, modifier }
  function extractModifierRecords(xmlDoc) {
    const records = [];
    // Find Claim elements (case-sensitive tag as per spec)
    const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
    for (const claim of claims) {
      const claimId = textValue(claim, 'ID');
      const memberId = textValue(claim, 'MemberID');

      // encounter may be under <Encounter> or mis-typed <Encounte>
      const encounterNode = claim.getElementsByTagName('Encounter')[0] || claim.getElementsByTagName('Encounte')[0];
      const encounterDateRaw = encounterNode ? textValue(encounterNode, 'Date') : '';

      // Normalize date for matching
      const encounterDate = normalizeDate(encounterDateRaw);

      const activities = Array.from(claim.getElementsByTagName('Activity'));
      for (const act of activities) {
        const activityId = textValue(act, 'ID');

        // tolerate misspellings for ordering clinician
        const clinician = firstNonEmpty([
          textValue(act, 'OrderingClnician'),
          textValue(act, 'OrderingClinician'),
          textValue(act, 'Ordering_Clinician'),
          textValue(act, 'OrderingClin') // in case of other variants
        ]);

        const observations = Array.from(act.getElementsByTagName('Observation'));
        for (const obs of observations) {
          const code = textValue(obs, 'Code');
          const value = textValue(obs, 'Value');

          // Code must be exactly 'CPT modifier' (case-sensitive) and value must be '24' or '52'
          if (code === 'CPT modifier' && isModifierTarget(value)) {
            records.push({
              claimId,
              activityId,
              memberId,
              date: encounterDate,
              clinician: normalizeName(clinician),
              modifier: String(value).trim()
            });
          }
        }
      }
    }
    return records;
  }

  // ---------- XLSX matcher ----------
  // Build an index keyed by normalized member|date|clinician => rows[]
  function buildXlsxMatcher(rows) {
    const index = new Map();

    for (const r of rows) {
      // support a few likely column name variants
      const memberRaw = String(r['Card Number'] ?? r['CardNumber'] ?? r['Member ID'] ?? r['MemberID'] ?? r['Card No'] ?? r['CardNo'] ?? '');
      const orderedOnRaw = String(r['Ordered On'] ?? r['OrderedOn'] ?? r['Ordered_On'] ?? r['Order Date'] ?? r['OrderDate'] ?? '');
      const clinicianRaw = String(r['Clnician'] ?? r['Clinician'] ?? r['Ordering Clinician'] ?? r['OrderingClinician'] ?? '');

      const member = normalizeMemberId(memberRaw);
      const date = normalizeDate(orderedOnRaw);
      const clinician = normalizeName(clinicianRaw);

      const key = [member, date, clinician].join('|');
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(r);
    }

    return {
      // finds first matching row for given memberId, date, clinician
      find(memberId, date, clinician) {
        const key = [normalizeMemberId(memberId), normalizeDate(date), normalizeName(clinician)].join('|');
        const arr = index.get(key);
        return arr && arr.length ? arr[0] : null;
      },
      // for debugging or advanced usage
      _index: index
    };
  }

  // ---------- Business rules ----------
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

  // ---------- Rendering ----------
  function renderResults(rows) {
    // rows expected shape: { ClaimID, ActivityID, OrderingClinician, Modifier, VOINumber, Status }
    if (!rows || !rows.length) {
      resultsContainer.innerHTML = '<div>No results</div>';
      return;
    }
  
    let prevClaimId = null;
    let prevActivityId = null;
  
    let html = `
      <table border="1" style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th>Claim ID</th>
            <th>Activity ID</th>
            <th>Ordering Clinician</th>
            <th>CPT Modifier</th>
            <th>VOI Number</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
    `;
  
    for (const r of rows) {
      const showClaim = r.ClaimID !== prevClaimId;
      const showActivity = (r.ClaimID !== prevClaimId) || (r.ActivityID !== prevActivityId);
  
      const claimCell = showClaim ? escapeHtml(r.ClaimID) : '';
      const activityCell = showActivity ? escapeHtml(r.ActivityID) : '';
  
      // update trackers after computing cells
      prevClaimId = r.ClaimID;
      prevActivityId = r.ActivityID;
  
      const rowClass = (String(r.Status || '').toLowerCase() === 'valid') ? 'valid' : 'unknown';
  
      html += `<tr class="${rowClass}">
        <td>${claimCell}</td>
        <td>${activityCell}</td>
        <td>${escapeHtml(r.OrderingClinician)}</td>
        <td>${escapeHtml(r.Modifier)}</td>
        <td>${escapeHtml(r.VOINumber)}</td>
        <td>${escapeHtml(r.Status)}</td>
      </tr>`;
    }
  
    html += `</tbody></table>`;
    resultsContainer.innerHTML = html;
  }

  // ---------- Utilities ----------
  function textValue(node, tagName) {
    if (!node) return '';
    const el = node.getElementsByTagName(tagName)[0];
    return el ? String(el.textContent || '').trim() : '';
  }

  function firstNonEmpty(arr) {
    for (const s of arr) {
      if (s !== undefined && s !== null && String(s).trim() !== '') return String(s).trim();
    }
    return '';
  }

  // Normalize member by removing leading zeros only (per requirements)
  function normalizeMemberId(id) {
    return String(id || '').replace(/^0+/, '');
  }

  // Normalize clinician names for comparison: collapse whitespace and lowercase
  function normalizeName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Date normalization: try ISO parse, then d/m/y or m/d/y common patterns. Returns YYYY-MM-DD or original trimmed string if unparseable.
  function normalizeDate(input) {
    const s = String(input || '').trim();
    if (!s) return '';

    // If already in YYYY-MM-DD or ISO, Date.parse will work reliably
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return toYMD(new Date(t));

    // try DD/MM/YYYY or D/M/YYYY or DD-MM-YYYY
    const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (dmy) {
      let [, part1, part2, part3] = dmy; // part1=day or month depending on format
      // Heuristic: if part3 length is 4 treat as year; assume format is D/M/Y
      let day = part1, month = part2, year = part3;
      if (year.length === 2) year = String(2000 + Number(year));
      const dt = new Date(Number(year), Number(month) - 1, Number(day));
      if (!Number.isNaN(dt.getTime())) return toYMD(dt);
    }

    // try MM/DD/YYYY (ambiguous) - only attempt if previous failed and likely US style (month <=12 && day <=31)
    const mdy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (mdy) {
      let [, m, da, y] = mdy;
      if (y.length === 2) y = String(2000 + Number(y));
      const dt = new Date(Number(y), Number(m) - 1, Number(da));
      if (!Number.isNaN(dt.getTime())) return toYMD(dt);
    }

    // fallback: return trimmed original
    return s;
  }

  function toYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // ---------- UI helpers ----------
  function resetUI() {
    messageBox.textContent = '';
    messageBox.style.color = '';
    resultsContainer.innerHTML = '';
    showProgress(0, '');
    downloadButton.disabled = true;
    lastResults = [];
  }

  function showProgress(percent = 0, text = '') {
    if (progressBarContainer) progressBarContainer.style.display = percent > 0 ? 'block' : 'none';
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressText) progressText.textContent = text ? `${percent}% — ${text}` : `${percent}%`;
  }

  function showError(err) {
    messageBox.style.color = 'red';
    messageBox.textContent = err && err.message ? err.message : String(err);
    showProgress(0, '');
    downloadButton.disabled = true;
  }

  // ---------- Expose nothing to global scope ----------
})();
