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
    renderResults(claims);
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
 * Extracts all claims from the XML document.
 */
function extractClaims(xmlDoc) {
  return Array.from(xmlDoc.getElementsByTagName('Claim')).map(el => ({
    id: getTextContent(el, 'ID'),
    ...extractEncounterDetails(el),
    ...extractActivityDetails(el),
    amount: getTextContent(el, 'Net'),
  }));
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
  window.invalidRows = invalidRows; // for export access
  exportBtn.style.display = invalidRows.length ? 'inline-block' : 'none';

  const validCount = rows.length - invalidRows.length;
  const totalCount = rows.length;
  const percentage = ((validCount / totalCount) * 100).toFixed(1);
  summaryBox.textContent = `Valid: ${validCount} / ${totalCount} (${percentage}%)`;

  const html = `
    <table border="1" style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th>Claim ID</th><th>Activity ID</th><th>Start</th>
          <th>End</th><th>Duration</th><th>Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr class="${r.isValid ? 'valid' : 'invalid'}">
            <td>${r.claimId}</td>
            <td>${r.activityId}</td>
            <td>${r.start}</td>
            <td>${r.end}</td>
            <td>${r.duration}</td>
            <td>${r.remarks.join('<br>')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

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
