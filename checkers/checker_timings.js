(function() {
  try {
    // checker_timings.js

    // --- Main Entry Point (called by unified interface) ---
    async function validateTimingsAsync() {
  const xmlInput = document.getElementById('xmlFileInput');
  const resultsDiv = document.getElementById('results');
  
  clearResults();
  
  if (!xmlInput || !xmlInput.files || !xmlInput.files.length) {
    return renderMessage('No XML file selected.');
  }
  
  const file = xmlInput.files[0];
  
  try {
    renderMessage('Processing file...');
    const xmlText = await file.text();
    validateXMLString(xmlText);
    const xmlDoc = parseXML(xmlText);
    const selectedType = document.querySelector('input[name="claimType"]:checked')?.value || "DENTAL";
    const requiredType = (selectedType === "DENTAL") ? "6" : "3";
    const claims = extractClaims(xmlDoc, requiredType);
    renderResults(resultsDiv, claims);
    
    // Export button handler (add if button exists)
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn && window.invalidRows?.length) {
      exportBtn.onclick = () => {
        const wb = XLSX.utils.book_new();
        const wsData = [
          ['Claim ID', 'Activity ID', 'Encounter Start', 'Encounter End', 'Activity Start', 'Duration', 'Excess', 'Remarks'],
          ...window.invalidRows.map(r => [
            r.claimId, r.activityId, r.encounterStart, r.encounterEnd,
            r.start, r.duration, r.excess, r.remarks.join('; ')
          ])
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wsData), 'Invalid Timings');
        XLSX.writeFile(wb, 'invalid_timings.xlsx');
      };
    }
  } catch (err) {
    renderMessage(`❌ Error: ${sanitize(String(err.message))}`);
  }
}

// --- Legacy onFileChange (kept for backward compatibility) ---
async function onFileChange(event) {
  clearResults();
  const file = event.target.files?.[0];
  if (!file) return renderMessage('No file selected.');
  try {
    renderMessage('Processing file...');
    const xmlText = await file.text();
    validateXMLString(xmlText);
    const xmlDoc = parseXML(xmlText);
    const selectedType = document.querySelector('input[name="claimType"]:checked')?.value || "DENTAL";
    const requiredType = (selectedType === "DENTAL") ? "6" : "3";
    const claims = extractClaims(xmlDoc, requiredType);
    renderResults(document.getElementById('results'), claims);
  } catch (err) {
    renderMessage(`❌ Error: ${sanitize(String(err.message))}`);
  }
}

// --- XML Parsing/Validation ---
function validateXMLString(str) {
  if (typeof str !== 'string' || !str.trim().startsWith('<')) throw new Error('File does not appear to be valid XML.');
}
function parseXML(xmlString) {
  // Preprocess XML to replace unescaped & with "and" for parseability
  const xmlContent = xmlString.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g, "and");
  const doc = new DOMParser().parseFromString(xmlContent, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML format.');
  return doc;
}

// --- Type 5 Code Format Checker ---
function isValidType5Code(code) {
  const parts = code.split("-");
  return (parts.length === 4 && parts[0].length === 3 && parts[1].length === 4 && parts[2].length === 5 && parts[3].length === 2);
}

// --- Claims Extraction/Validation ---
function extractClaims(xmlDoc, requiredType = "6") {
  const results = [];
  xmlDoc.querySelectorAll('Claim').forEach(claim => {
    const claimId = claim.querySelector('ID')?.textContent || 'Unknown';
    const enc = claim.querySelector('Encounter');
    const encounterStartStr = enc?.querySelector('Start')?.textContent, encounterEndStr = enc?.querySelector('End')?.textContent;
    const startType = enc?.querySelector('StartType')?.textContent?.trim(), endType = enc?.querySelector('EndType')?.textContent?.trim();
    if (!encounterStartStr || !encounterEndStr) return;
    const encounterStart = parseDateTime(encounterStartStr), encounterEnd = parseDateTime(encounterEndStr);
    if (!encounterStart || !encounterEnd) return;
    const encMin = Math.floor((encounterEnd - encounterStart) / 60000);
    let baseValid = true, baseRemarks = [];
    if (startType !== '1') { baseValid = false; baseRemarks.push(`Invalid Encounter StartType: expected 1 but found ${startType || '(missing)'}.`);}
    if (endType !== '1') { baseValid = false; baseRemarks.push(`Invalid Encounter EndType: expected 1 but found ${endType || '(missing)'}.`);}
    if (encMin < 0) { baseValid = false; baseRemarks.push('Encounter end is before encounter start.');}
    claim.querySelectorAll('Activity').forEach(activity => {
      const activityId = activity.querySelector('ID')?.textContent || 'Unknown';
      const activityStartStr = activity.querySelector('Start')?.textContent;
      const typeValue = activity.querySelector('Type')?.textContent?.trim() || '';
      const codeValue = activity.querySelector('Code')?.textContent?.trim() || '';
      let isValid = baseValid, remarks = [...baseRemarks];
      // Type 5 code format check
      if (typeValue === "5") {
        if (!isValidType5Code(codeValue)) {
          isValid = false;
          remarks.push(`Type 5 activity with invalid or missing Code: "${codeValue}".`);
        }
      }
      // Type 4 special code J3490
      else if (typeValue === "4") {
        if (codeValue === "J3490") {
          // valid, do not push type error!
        } else if (typeValue !== requiredType) {
          isValid = false;
          remarks.push(`Invalid Type: expected ${requiredType} but found ${typeValue || '(missing)'}.`);
        }
      }
      // Normal type check for all other types
      else if (typeValue !== requiredType) {
        isValid = false;
        remarks.push(`Invalid Type: expected ${requiredType} but found ${typeValue || '(missing)'}.`);
      }
      if (!activityStartStr) {
        remarks.push('Missing Activity Start');
        results.push({
          claimId, activityId, encounterStart: encounterStartStr, encounterEnd: encounterEndStr,
          start: 'N/A', duration: formatDuration(encMin), excess: 'N/A', isValid, remarks
        });
        return;
      }
      const activityStart = parseDateTime(activityStartStr);
      if (!activityStart) { isValid = false; remarks.push('Invalid Activity Start format'); }
      const excessMin = (activityStart instanceof Date && !isNaN(activityStart))
        ? Math.floor((encounterEnd - activityStart) / 60000)
        : NaN;
      if (activityStart && activityStart < encounterStart) { isValid = false; remarks.push('Activity start is before encounter start.'); }
      if (activityStart && activityStart > encounterEnd) { isValid = false; remarks.push('Activity start is after encounter end.'); }
      if (encMin >= 0 && encMin < 10) { isValid = false; remarks.push(`Encounter duration too short (${encMin} min). Should be 10 minutes minimum.`);}
      else if (encMin > 240) {
        isValid = false;
        if (encMin >= 1440) {
          const [startDate] = encounterStartStr.split(' '), [endDate] = encounterEndStr.split(' ');
          remarks.push(`Encounter crosses days: ${startDate} → ${endDate}`);
        } else {
          const hours = Math.floor(encMin / 60), minutes = encMin % 60;
          remarks.push(`Encounter duration too long (${hours}h ${minutes}m). Should be 4 hours maximum.`);
        }
      }
      results.push({
        claimId, activityId, encounterStart: encounterStartStr, encounterEnd: encounterEndStr,
        start: activityStartStr, duration: formatDuration(encMin),
        excess: isNaN(excessMin) ? 'N/A' : formatDuration(excessMin), isValid, remarks
      });
    });
  });
  return results;
}

// --- Utilities ---
function parseDateTime(dt) {
  if (!dt.includes(' ')) return null;
  const [date, time] = dt.split(' ');
  const [d, m, y] = date.split('/').map(Number), [h, min] = time.split(':').map(Number);
  if ([d, m, y, h, min].some(isNaN)) return null;
  return new Date(y, m - 1, d, h, min);
}
function formatDuration(mins) {
  if (isNaN(mins) || mins < 0) return 'N/A';
  if (mins >= 60) {
    const hours = (mins / 60).toFixed(1);
    return `${hours} hr${hours !== '1.0' ? 's' : ''}`;
  }
  return `${mins} min`;
}
function sanitize(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function renderMessage(msg) {
  document.getElementById('results').innerHTML = `<p>${sanitize(msg)}</p>`;
}
function clearResults() {
  document.getElementById('results').innerHTML = '';
}

// --- Results Rendering ---
function renderResults(container, rows) {
  const summaryBox = document.getElementById('resultsSummary');
  const exportBtn = document.getElementById('exportBtn');
  if (!rows.length) {
    container.innerHTML = '<p>No entries found.</p>';
    summaryBox.textContent = '';
    exportBtn.style.display = 'none';
    return;
  }
  const invalidRows = rows.filter(r => !r.isValid);
  window.invalidRows = invalidRows;
  exportBtn.style.display = invalidRows.length ? 'inline-block' : 'none';
  summaryBox.textContent = `Valid: ${rows.length - invalidRows.length} / ${rows.length} (${((rows.length - invalidRows.length)/rows.length*100).toFixed(1)}%)`;
  container.innerHTML = buildResultsTable(rows);
  
  // Add MutationObserver to detect when filter hides/shows rows
  const observer = new MutationObserver(() => {
    fillMissingClaimIds();
  });
  
  const tbody = container.querySelector('tbody');
  if (tbody) {
    observer.observe(tbody, { 
      attributes: true, 
      attributeFilter: ['style'],
      subtree: true 
    });
  }
  
  // Fill immediately if filter is already active
  fillMissingClaimIds();
}
function buildResultsTable(rows) {
  // Defensive check: ensure rows is an array
  if (!Array.isArray(rows)) {
    console.error('buildResultsTable: rows is not an array:', rows);
    return '<div class="alert alert-danger">Error: Invalid data structure for results table</div>';
  }
  
  let prevClaimId = null, html = `
    <table class="table table-striped table-bordered" style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th style="padding:8px;border:1px solid #ccc">Claim ID</th>
        <th style="padding:8px;border:1px solid #ccc">Activity ID</th>
        <th style="padding:8px;border:1px solid #ccc">Encounter Start</th>
        <th style="padding:8px;border:1px solid #ccc">Encounter End</th>
        <th style="padding:8px;border:1px solid #ccc">Activity Start</th>
        <th style="padding:8px;border:1px solid #ccc">Duration</th>
        <th style="padding:8px;border:1px solid #ccc">Excess</th>
        <th style="padding:8px;border:1px solid #ccc">Remarks</th>
      </tr></thead><tbody>
  `;
  rows.forEach(r => {
    const claimCell = (r.claimId !== prevClaimId) ? r.claimId : '';
    prevClaimId = r.claimId;
    const remarkLines = (r.remarks || []).map(line => `<div>${sanitize(line)}</div>`).join('');
    html += `<tr class="${r.isValid ? 'table-success' : 'table-danger'}" data-claim-id="${sanitize(r.claimId || '')}">
      <td class="claim-id-cell" style="padding:6px;border:1px solid #ccc">${sanitize(claimCell)}</td>
      <td style="padding:6px;border:1px solid #ccc">${sanitize(r.activityId)}</td>
      <td style="padding:6px;border:1px solid #ccc">${sanitize(r.encounterStart)}</td>
      <td style="padding:6px;border:1px solid #ccc">${sanitize(r.encounterEnd)}</td>
      <td style="padding:6px;border:1px solid #ccc">${sanitize(r.start)}</td>
      <td style="padding:6px;border:1px solid #ccc">${sanitize(r.duration)}</td>
      <td style="padding:6px;border:1px solid #ccc">${sanitize(r.excess)}</td>
      <td style="padding:6px;border:1px solid #ccc">${remarkLines}</td>
    </tr>`;
  });
  return html + "</tbody></table>";
}

// Helper function to fill missing Claim IDs when rows are filtered
function fillMissingClaimIds() {
  const table = document.querySelector('#results table');
  if (!table) return;
  
  const rows = Array.from(table.querySelectorAll('tbody tr'));
  
  rows.forEach(row => {
    const isHidden = row.style.display === 'none';
    const claimIdCell = row.querySelector('.claim-id-cell');
    const claimId = row.getAttribute('data-claim-id');
    
    if (!isHidden && claimIdCell && claimId) {
      if (claimIdCell.textContent.trim() === '') {
        // Empty cell - fill it in for visibility
        claimIdCell.textContent = claimId;
        claimIdCell.style.color = '#666';  // Gray color
        claimIdCell.style.fontStyle = 'italic';  // Italic style
      } else {
        // Has claim ID - original first row
        claimIdCell.style.color = '';  // Black color
        claimIdCell.style.fontStyle = '';  // Normal style
      }
    }
  });
}

// --- Superfluous/Unused Functions (fully commented out) ---

/**
function extractEncounterDetails(claimEl) {
  const enc = claimEl.querySelector('Encounter');
  if (!enc) {
    return {
      start: 'N/A',
      end: 'N/A',
      patient: 'N/A',
      validity: 'Invalid (missing Encounter)'
    };
  }
  const start = getTextContent(enc, 'Start');
  const end = getTextContent(enc, 'End');
  const patient = getTextContent(enc, 'PatientID');
  const startType = getTextContent(enc, 'StartType');
  const endType = getTextContent(enc, 'EndType');
  return {
    start,
    end,
    patient,
    validity: validateEncounter(start, end, startType, endType)
  };
}
**/

/**
function extractActivityDetails(claimEl) {
  const act = claimEl.querySelector('Activity');
  return {
    doctor: act ? getTextContent(act, 'Clinician') : 'N/A',
    activityId: act ? getTextContent(act, 'ID') : 'N/A',
    activityStart: act ? getTextContent(act, 'Start') : 'N/A'
  };
}
**/

/**
function getTextContent(parent, selector) {
  return parent.querySelector(selector)?.textContent.trim() ?? 'N/A';
}
**/

/**
function isSameDay(a, b) {
  return a && b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}
**/

/**
function computeDuration(start, end) {
  const sd = parseDateTime(start);
  const ed = parseDateTime(end);
  if (!sd || !ed || !(sd < ed)) return 'N/A';

  const diffMinutes = Math.round((ed - sd) / 60000);
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return `${hours}h ${minutes}m`;
}
**/

/**
function validateEncounter(start, end, startType, endType) {
  // Check for missing fields
  if (!start || !end || start === 'N/A' || end === 'N/A') return 'Invalid (missing start/end)';
  if (startType !== '1' || endType !== '1') return 'Invalid (type)';
  const sd = parseDateTime(start), ed = parseDateTime(end);
  if (!sd || !ed) return 'Invalid (format)';
  if (!isSameDay(sd, ed)) return 'Invalid (date)';
  if (!(sd < ed)) return 'Invalid (order)';
  const diff = (ed - sd) / 1000 / 60;
  if (diff < 10) return 'Invalid (<10m)';
  if (diff > 240) return 'Invalid (>4h)';
  return 'Valid';
}
**/

/**
function validateDateAndStatus(row, start) {
  const remarks = [];
  // Extract just the date portions (DD/MM/YYYY)
  const xlsDateStr = String(row["Ordered On"] || "").split(' ')[0];
  const xmlDateStr = String(start || "").split(' ')[0];
  // Parse as dates at midnight (ignore time)
  const [dx, mx, yx] = xlsDateStr.split('/').map(Number);
  const [di, mi, yi] = xmlDateStr.split('/').map(Number);
  const xlsDate = (!isNaN(dx) && !isNaN(mx) && !isNaN(yx))
    ? new Date(yx, mx - 1, dx)
    : null;
  const xmlDate = (!isNaN(di) && !isNaN(mi) && !isNaN(yi))
    ? new Date(yi, mi - 1, di)
    : null;
  if (!xlsDate) { remarks.push("Invalid XLSX Ordered On date"); }
  if (!xmlDate) { remarks.push("Invalid XML Start date"); }
  if (xlsDate && xmlDate && xlsDate > xmlDate) {
    remarks.push("Approval must be on or before procedure date");
  }
  const rawStatus = row["Status"] ?? row.status;
  const status = String(rawStatus || "").toLowerCase();
  if (!status.includes("approved") && !status.includes("rejected")) {
    remarks.push("Status not approved");
  }
  return remarks;
}
**/

/**
function formatDateTimeCell(datetimeStr) {
  if (!datetimeStr) return '';
  const [datePart, timePart] = String(datetimeStr).split(' ');
  return `
    <div>${sanitize(datePart)}</div>
    <div>${sanitize(timePart || '')}</div>
  `;
}
**/

    // Expose function globally for unified checker
    window.validateTimingsAsync = validateTimingsAsync;

  } catch (error) {
    console.error('[CHECKER-ERROR] Failed to load checker:', error);
    console.error(error.stack);
  }
})();
