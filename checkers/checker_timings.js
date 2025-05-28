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
function renderResults(claims) {
  if (!claims.length) {
    renderMessage('No <code>&lt;Claim&gt;</code> found.');
    return;
  }
  // Build table rows
  const rows = claims.map(c => `
    <tr class="${c.validity === 'Valid' ? 'valid' : 'invalid'}">
      <td>${sanitize(c.id)}</td>
      <td>${sanitize(c.start)}</td>
      <td>${sanitize(c.end)}</td>
      <td>${sanitize(c.patient)}</td>
      <td>${sanitize(c.doctor)}</td>
      <td>${sanitize(c.amount)}</td>
      <td>${sanitize(c.validity)}</td>
    </tr>
  `).join('');
  // Build table
  const table = `
    <table border="1" cellpadding="5" cellspacing="0">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Start Date & Time</th>
          <th>End Date & Time</th>
          <th>Patient ID</th>
          <th>Doctor</th>
          <th>Total Amount</th>
          <th>Validity</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  document.getElementById('results').innerHTML = table;
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
