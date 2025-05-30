// checker_timings.js

// Wait for DOM to load before initializing
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('xmlFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', onFileChange);
  }
});

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
    const claims = extractClaims(xmlDoc);

    const resultsContainer = document.getElementById('results');
    renderResults(resultsContainer, claims);
  } catch (err) {
    renderMessage(`❌ Error: ${sanitize(String(err.message))}`);
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

/**
 * Validates the raw XML string before parsing.
 */
function validateXMLString(str) {
  if (typeof str !== 'string' || !str.trim().startsWith('<')) {
    throw new Error('File does not appear to be valid XML.');
  }
}
/**
 * Builds rows from XML Claims, now including encounterStart/end and activityStart,
 * and adds a remark if there's insufficient time between activityStart and encounter end.
 */
function extractClaims(xmlDoc) {
  const MIN_GAP_MINUTES = 15; // adjust buffer as needed

  return Array.from(xmlDoc.getElementsByTagName('Claim')).flatMap(claimEl => {
    const claimId = getTextContent(claimEl, 'ID');
    const { start: encounterStart, end: encounterEnd, validity } = extractEncounterDetails(claimEl);

    const encStartDate = parseDateTime(encounterStart);
    const encEndDate   = parseDateTime(encounterEnd);

    return Array.from(claimEl.getElementsByTagName('Activity')).map(actEl => {
      const { activityId, activityStart, doctor } = extractActivityDetails(claimEl);
      const actStartDate = parseDateTime(activityStart);
      const duration = computeDuration(encounterStart, encounterEnd);

      const remarks = [];
      if (validity !== 'Valid') remarks.push(validity);

      // New gap check
      if (encEndDate && actStartDate) {
        const gap = (encEndDate - actStartDate) / 60000;
        if (gap < MIN_GAP_MINUTES) {
          remarks.push('Not enough time between activity start and encounter end time.');
        }
      }

      return {
        claimId,
        activityId,
        encounterStart,           // new column
        encounterEnd,             // new column
        start: activityStart,
        end: encounterEnd,
        duration,
        doctor,
        isValid: remarks.length === 0,
        remarks
      };
    });
  });
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

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

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
 * Gets text content of a selector inside an element.
 */
function getTextContent(parent, selector) {
  return parent.querySelector(selector)?.textContent.trim() ?? 'N/A';
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
 * Extracts activity/doctor details from a claim element.
 */
function extractActivityDetails(claimEl) {
  const act = claimEl.querySelector('Activity');
  return {
    doctor: act ? getTextContent(act, 'Clinician') : 'N/A'
  };
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

// Valid types for encounter
const VALID_TYPES = {
  START: '1',
  END: '1'
};

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
 * Renders the claims in a table, or a message if none found.
 */
/**
 * Renders the timing validation results table, including two new columns:
 * - Encounter Start
 * - Encounter End
 * Also handles the summary, export button visibility, and hides repeated Claim IDs.
 *
 * @param {HTMLElement} container – the DOM element to render into
 * @param {Array} rows – array of result objects with fields:
 *   claimId, activityId, encounterStart, encounterEnd, start, end, duration, remarks, isValid
 */
function renderResults(container, rows) {
  // Summary and export button elements
  const summaryBox = document.getElementById('resultsSummary');
  const exportBtn  = document.getElementById('exportBtn');

  // No rows case
  if (!rows.length) {
    container.innerHTML    = '<p>No entries found.</p>';
    summaryBox.textContent = '';
    exportBtn.style.display = 'none';
    return;
  }

  // Determine invalid rows and toggle export button
  const invalidRows = rows.filter(r => !r.isValid);
  window.invalidRows  = invalidRows; // global for export handler
  exportBtn.style.display = invalidRows.length ? 'inline-block' : 'none';

  // Render summary: valid count, total, percentage
  const validCount = rows.length - invalidRows.length;
  const percentage = ((validCount / rows.length) * 100).toFixed(1);
  summaryBox.textContent = `Valid: ${validCount} / ${rows.length} (${percentage}%)`;

  // Build table rows, hiding repeated Claim IDs
  let prevClaimId = null;
  const tableRows = rows.map(r => {
    // Only show Claim ID when it changes
    const claimIdCell = (r.claimId !== prevClaimId) ? r.claimId : '';
    prevClaimId = r.claimId;

    // Generate <tr> with new Encounter Start/End columns
    return `
      <tr class="${r.isValid ? 'valid' : 'invalid'}">
        <td>${claimIdCell}</td>
        <td>${r.activityId}</td>

        <!-- New columns for Encounter Start and Encounter End -->
        <td>${r.encounterStart}</td>
        <td>${r.encounterEnd}</td>

        <!-- Existing columns: Activity Start, Activity End, Duration -->
        <td>${r.start}</td>
        <td>${r.end}</td>
        <td>${r.duration}</td>

        <!-- Remarks column (multi-line) -->
        <td>${r.remarks.join('<br>')}</td>
      </tr>`;
  }).join('');

  // Full table HTML with headers
  const html = `
    <table border="1" style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Activity ID</th>
          <th>Encounter Start</th>
          <th>Encounter End</th>
          <th>Activity Start</th>
          <th>Activity End</th>
          <th>Duration</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>`;

  // Render into container
  container.innerHTML = html;
}

// XLSX export support
document.getElementById('exportBtn').addEventListener('click', () => {
  if (!window.invalidRows?.length) return;

  const wb = XLSX.utils.book_new();
  const wsData = [
    ['Claim ID', 'Activity ID', 'Start', 'End', 'Duration', 'Remarks'],
    ...window.invalidRows.map(r => [
      r.claimId,
      r.activityId,
      r.start,
      r.end,
      r.duration,
      r.remarks.join('; ')
    ])
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'Invalid Timings');
  XLSX.writeFile(wb, 'invalid_timings.xlsx');
});


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
