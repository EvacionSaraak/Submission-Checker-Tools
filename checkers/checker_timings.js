// checker_timings.js

/*** --------------- DOM LOAD AND EVENT HANDLERS --------------- ***/

// Wait for DOM to load before initializing
document.addEventListener('DOMContentLoaded', () => {
  // --- Insert radio selector if not present ---
  if (!document.getElementById('typeSelector')) {
    const selectorHTML = `
      <div id="typeSelector" style="margin-bottom: 1em;">
        <label>
          <input type="radio" name="claimType" value="DENTAL" checked>
          Dental
        </label>
        <label>
          <input type="radio" name="claimType" value="MEDICAL">
          Medical
        </label>
      </div>
    `;
    // Insert above file input if found
    const fileInput = document.getElementById('xmlFileInput');
    if (fileInput && fileInput.parentNode) {
      fileInput.parentNode.insertBefore(
        document.createRange().createContextualFragment(selectorHTML),
        fileInput
      );
    }
  }

  const fileInput = document.getElementById('xmlFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', onFileChange);
  }
});

// XLSX export button handler
document.getElementById('exportBtn').addEventListener('click', () => {
  if (!window.invalidRows?.length) return;

  const wb = XLSX.utils.book_new();
  const wsData = [
    ['Claim ID', 'Activity ID', 'Encounter Start', 'Encounter End', 'Activity Start', 'Duration', 'Excess', 'Remarks'],
    ...window.invalidRows.map(r => [
      r.claimId,
      r.activityId,
      r.encounterStart,
      r.encounterEnd,
      r.start,
      r.duration,
      r.excess,
      r.remarks.join('; ')
    ])
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'Invalid Timings');
  XLSX.writeFile(wb, 'invalid_timings.xlsx');
});

/*** --------------- MAIN FILE HANDLER --------------- ***/

/**
 * Handles file input change event
 */
async function onFileChange(event) {
  clearResults();
  const file = event.target.files?.[0];
  if (!file) {
    renderMessage('No file selected.');
    return;
  }

  try {
    renderMessage('Processing file...');
    const xmlText = await file.text();
    validateXMLString(xmlText);
    const xmlDoc = parseXML(xmlText);

    // --- Get required type from radio button ---
    const selectedType = document.querySelector('input[name="claimType"]:checked')?.value || "DENTAL";
    const requiredType = (selectedType === "DENTAL") ? "6" : "3";

    const claims = extractClaims(xmlDoc, requiredType);

    const resultsContainer = document.getElementById('results');
    renderResults(resultsContainer, claims);
  } catch (err) {
    renderMessage(`❌ Error: ${sanitize(String(err.message))}`);
  }
}

/*** --------------- XML PARSING AND VALIDATION --------------- ***/

/**
 * Validates the raw XML string before parsing.
 */
function validateXMLString(str) {
  if (typeof str !== 'string' || !str.trim().startsWith('<')) {
    throw new Error('File does not appear to be valid XML.');
  }
}

/**
 * Parses XML string into a document.
 * Throws if the XML is invalid.
 */
function parseXML(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML format.');
  return doc;
}

/*** --------------- XML DATA EXTRACTION --------------- ***/

/**
 * Builds rows from XML Claims, now including encounterStart/end and activityStart,
 * and adds:
 *  • A new “Type” check (must be configurable).
 *  • Existing timing checks (start vs. end, encounter duration).
 */
function extractClaims(xmlDoc, requiredType = "6") {
  const results = [];

  xmlDoc.querySelectorAll('Claim').forEach(claim => {
    const claimId = claim.querySelector('ID')?.textContent || 'Unknown';

    const encounterEl = claim.querySelector('Encounter');
    const encounterStartStr = encounterEl?.querySelector('Start')?.textContent;
    const encounterEndStr   = encounterEl?.querySelector('End')?.textContent;
    const startType = encounterEl?.querySelector('StartType')?.textContent?.trim();
    const endType   = encounterEl?.querySelector('EndType')?.textContent?.trim();

    if (!encounterStartStr || !encounterEndStr) return;

    const encounterStart = parseDateTime(encounterStartStr);
    const encounterEnd   = parseDateTime(encounterEndStr);
    if (!encounterStart || !encounterEnd) return;

    const encMin = Math.floor((encounterEnd - encounterStart) / 60000);

    let baseValid = true;
    const baseRemarks = [];

    // StartType / EndType checks
    if (startType !== '1') {
      baseValid = false;
      baseRemarks.push(`Invalid Encounter StartType: expected 1 but found ${startType || '(missing)'}.`);
    }
    if (endType !== '1') {
      baseValid = false;
      baseRemarks.push(`Invalid Encounter EndType: expected 1 but found ${endType || '(missing)'}.`);
    }

    if (encMin < 0) {
      baseValid = false;
      baseRemarks.push('Encounter end is before encounter start.');
    }

    claim.querySelectorAll('Activity').forEach(activity => {
      const activityId = activity.querySelector('ID')?.textContent || 'Unknown';
      const activityStartStr = activity.querySelector('Start')?.textContent;
      const typeValue = activity.querySelector('Type')?.textContent?.trim() || '';

      let isValid = baseValid;
      const remarks = [...baseRemarks];

      if (typeValue !== requiredType) {
        isValid = false;
        remarks.push(`Invalid Type: expected ${requiredType} but found ${typeValue || '(missing)'}.`);
      }

      if (!activityStartStr) {
        remarks.push('Missing Activity Start');
        results.push({
          claimId,
          activityId,
          encounterStart: encounterStartStr,
          encounterEnd: encounterEndStr,
          start: 'N/A',
          duration: formatDuration(encMin),
          excess: 'N/A',
          isValid,
          remarks
        });
        return;
      }

      const activityStart = parseDateTime(activityStartStr);
      if (!activityStart) {
        isValid = false;
        remarks.push('Invalid Activity Start format');
      }

      const excessMin = (activityStart instanceof Date && !isNaN(activityStart))
        ? Math.floor((encounterEnd - activityStart) / 60000)
        : NaN;

      if (activityStart && activityStart < encounterStart) {
        isValid = false;
        remarks.push('Activity start is before encounter start.');
      }
      if (activityStart && activityStart > encounterEnd) {
        isValid = false;
        remarks.push('Activity start is after encounter end.');
      }

      if (encMin >= 0 && encMin < 10) {
        isValid = false;
        remarks.push(`Encounter duration too short (${encMin} min). Should be 10 minutes minimum.`);
      } else if (encMin > 240) {
        isValid = false;
        if (encMin >= 1440) {
          const [startDate] = encounterStartStr.split(' ');
          const [endDate] = encounterEndStr.split(' ');
          remarks.push(`Encounter crosses days: ${startDate} → ${endDate}`);
        } else {
          const hours = Math.floor(encMin / 60);
          const minutes = encMin % 60;
          remarks.push(`Encounter duration too long (${hours}h ${minutes}m). Should be 4 hours maximum.`);
        }
      }

      results.push({
        claimId,
        activityId,
        encounterStart: encounterStartStr,
        encounterEnd: encounterEndStr,
        start: activityStartStr,
        duration: formatDuration(encMin),
        excess: isNaN(excessMin) ? 'N/A' : formatDuration(excessMin),
        isValid,
        remarks
      });
    });
  });

  return results;
}

/**
 * Extracts encounter details from a claim element.
 */
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

/**
 * Extracts activity/doctor details (including ID and Start) from a claim element.
 */
function extractActivityDetails(claimEl) {
  const act = claimEl.querySelector('Activity');
  return {
    doctor: act ? getTextContent(act, 'Clinician') : 'N/A',
    activityId: act ? getTextContent(act, 'ID') : 'N/A',
    activityStart: act ? getTextContent(act, 'Start') : 'N/A'
  };
}

/*** --------------- VALIDATION HELPERS --------------- ***/

// Valid types for encounter
const VALID_TYPES = {
  START: '1',
  END: '1'
};

/**
 * Gets difference between two points of time.
 */
function getTimeDifferenceInMinutes(startTimeStr, endTimeStr) {
  const start = new Date(startTimeStr);
  const end = new Date(endTimeStr);
  return (end - start) / 60000; // milliseconds to minutes
}

/**
 * Validates encounter timings and types.
 */
function validateEncounter(start, end, startType, endType) {
  // Check for missing fields
  if (!start || !end || start === 'N/A' || end === 'N/A') return 'Invalid (missing start/end)';
  if (startType !== VALID_TYPES.START || endType !== VALID_TYPES.END) return 'Invalid (type)';
  const sd = parseDateTime(start), ed = parseDateTime(end);
  if (!sd || !ed) return 'Invalid (format)';
  if (!isSameDay(sd, ed)) return 'Invalid (date)';
  if (!(sd < ed)) return 'Invalid (order)';
  const diff = (ed - sd) / 1000 / 60;
  if (diff < 10) return 'Invalid (<10m)';
  if (diff > 240) return 'Invalid (>4h)';
  return 'Valid';
}

/**
 * Validates the date order and status for a given XLSX row and XML start date.
 * Now safely coerces values to strings before calling .includes().
 */
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

  if (!xlsDate) {
    remarks.push("Invalid XLSX Ordered On date");
  }
  if (!xmlDate) {
    remarks.push("Invalid XML Start date");
  }
  // Only error if approval date is after procedure date (same day is allowed)
  if (xlsDate && xmlDate && xlsDate > xmlDate) {
    remarks.push("Approval must be on or before procedure date");
  }

  // Safely coerce status to string before .includes()
  const rawStatus = row["Status"] ?? row.status;
  const status = String(rawStatus || "").toLowerCase();
  if (!status.includes("approved") && !status.includes("rejected")) {
    remarks.push("Status not approved");
  }

  return remarks;
}

/*** --------------- GENERAL UTILITIES --------------- ***/

/**
 * Gets text content of a selector inside an element.
 */
function getTextContent(parent, selector) {
  return parent.querySelector(selector)?.textContent.trim() ?? 'N/A';
}

/**
 * Parses a date/time string as DD/MM/YYYY HH:mm.
 */
function parseDateTime(dt) {
  if (!dt.includes(' ')) return null;
  const [date, time] = dt.split(' ');
  const [d, m, y] = date.split('/').map(Number);
  const [h, min] = time.split(':').map(Number);
  if ([d, m, y, h, min].some(isNaN)) return null;
  return new Date(y, m - 1, d, h, min);
}

/**
 * Checks if two dates fall on the same day.
 */
function isSameDay(a, b) {
  return a && b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

/**
 * Computes duration string between two date/time strings.
 */
function computeDuration(start, end) {
  const sd = parseDateTime(start);
  const ed = parseDateTime(end);
  if (!sd || !ed || !(sd < ed)) return 'N/A';

  const diffMinutes = Math.round((ed - sd) / 60000);
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * Formats minutes as 'Xh Ym'.
 */
function formatDuration(mins) {
  if (isNaN(mins) || mins < 0) return 'N/A';
  if (mins >= 60) {
    const hours = (mins / 60).toFixed(1);
    return `${hours} hr${hours !== '1.0' ? 's' : ''}`;
  }
  return `${mins} min`;
}

/**
 * Formats a "DD/MM/YYYY HH:mm" string into two lines: date above, time below.
 * Uses the raw string parts (avoids ISO conversion) and sanitizes each.
 */
function formatDateTimeCell(datetimeStr) {
  if (!datetimeStr) return '';
  const [datePart, timePart] = String(datetimeStr).split(' ');
  return `
    <div>${sanitize(datePart)}</div>
    <div>${sanitize(timePart || '')}</div>
  `;
}

/*** --------------- RENDERING FUNCTIONS --------------- ***/
/**
 * Renders the timing validation results table, summary, and export button.
 */
function renderResults(container, rows) {
  const summaryBox = document.getElementById('resultsSummary');
  const exportBtn  = document.getElementById('exportBtn');

  if (!rows.length) {
    renderNoResults(container, summaryBox, exportBtn);
    return;
  }

  const invalidRows = rows.filter(r => !r.isValid);
  window.invalidRows = invalidRows;
  exportBtn.style.display = invalidRows.length ? 'inline-block' : 'none';

  const summaryText = generateSummaryText(rows.length, invalidRows.length);
  summaryBox.textContent = summaryText;

  // Build and inject table HTML (now without Activity End)
  container.innerHTML = buildResultsTable(rows);
}


/**
 * Renders no result
 */
function renderNoResults(container, summaryBox, exportBtn) {
  container.innerHTML = '<p>No entries found.</p>';
  summaryBox.textContent = '';
  exportBtn.style.display = 'none';
}

/**
 * Makes a summary
 */
function generateSummaryText(total, invalidCount) {
  const validCount = total - invalidCount;
  const percentage = ((validCount / total) * 100).toFixed(1);
  return `Valid: ${validCount} / ${total} (${percentage}%)`;
}

/**
 * Renders a message in the results area.
 */
function renderMessage(msg) {
  document.getElementById('results').innerHTML = `<p>${sanitize(msg)}</p>`;
}

/**
 * Clears previous results/messages.
 */
function clearResults() {
  document.getElementById('results').innerHTML = '';
}

/**
 * Simple HTML sanitizer for output.
 */
function sanitize(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Builds an HTML table, injecting date/time cells via innerHTML
 * so that the <div> wrappers from formatDateTimeCell take effect.
 */
function buildResultsTable(rows) {
  let prevClaimId = null;
  let html = `
    <table border="1" style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th>Claim ID</th><th>Activity ID</th><th>Encounter Start</th>
          <th>Encounter End</th><th>Activity Start</th>
          <th>Duration</th><th>Excess</th><th>Remarks</th>
        </tr>
      </thead>
      <tbody>
  `;

  rows.forEach(r => {
    const claimCell = (r.claimId !== prevClaimId) ? r.claimId : '';
    prevClaimId = r.claimId;
    const remarkLines = (r.remarks || []).map(line => `<div>${sanitize(line)}</div>`).join('');

    html += `
      <tr class="${r.isValid ? 'valid' : 'invalid'}">
        <td>${sanitize(claimCell)}</td>
        <td>${sanitize(r.activityId)}</td>
        <td>${sanitize(r.encounterStart)}</td>
        <td>${sanitize(r.encounterEnd)}</td>
        <td>${sanitize(r.start)}</td>
        <td>${sanitize(r.duration)}</td>
        <td>${sanitize(r.excess)}</td>
        <td>${remarkLines}</td>
      </tr>
    `;
  });

  html += `
      </tbody>
    </table>
  `;

  return html;
}
