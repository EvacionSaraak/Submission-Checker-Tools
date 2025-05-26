// 1. Listen for file selection and kick off parsing
document.getElementById('xmlFileInput').addEventListener('change', function (event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    parseXMLAndRenderTable(e.target.result);
  };
  reader.readAsText(file);
});

// 2. Main: parse XML, build table, inject into DOM
function parseXMLAndRenderTable(xmlString) {
  const xmlDoc = new DOMParser()
    .parseFromString(xmlString, 'application/xml');

  const claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
  if (claims.length === 0) {
    return renderMessage("No <code>&lt;Claim&gt;</code> elements found.");
  }

  let html = `
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
      <tbody>
  `;

  for (let claim of claims) {
    const claimID     = getTagValue(claim, 'ID');
    const encounter   = claim.querySelector('Encounter');
    const startDT     = encounter ? getTagValue(encounter, 'Start')     : 'N/A';
    const endDT       = encounter ? getTagValue(encounter, 'End')       : 'N/A';
    const patientID   = encounter ? getTagValue(encounter, 'PatientID') : 'N/A';
    const activity    = claim.querySelector('Activity');
    const doctor      = activity ? getTagValue(activity, 'Clinician')   : 'N/A';
    const totalAmount = getTagValue(claim, 'Net');
    const validity    = encounter
      ? validateEncounterData(encounter)
      : 'Invalid (no encounter)';

    html += `
      <tr>
        <td>${claimID}</td>
        <td>${startDT}</td>
        <td>${endDT}</td>
        <td>${patientID}</td>
        <td>${doctor}</td>
        <td>${totalAmount}</td>
        <td>${validity}</td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  document.getElementById('tableContainer').innerHTML = html;
}

// 3. Safely extract the first child element's textContent
function getTagValue(parent, tagName) {
  // Only Elements and Documents can be queried
  if (!(parent instanceof Element) && !(parent instanceof Document)) {
    return 'N/A';
  }
  const el = parent.querySelector(tagName);
  return el ? el.textContent.trim() : 'N/A';
}

// 4. Validate all encounter rules at once
function validateEncounterData(encounter) {
  const s = getTagValue(encounter, 'Start');
  const e = getTagValue(encounter, 'End');
  const st = getTagValue(encounter, 'StartType');
  const et = getTagValue(encounter, 'EndType');

  if (!s || !e)           return 'Invalid (missing start/end)';
  if (!validateStartEndType(st, et))    return 'Invalid (start/end type ≠ 1)';

  const sd = parseDateTime(s);
  const ed = parseDateTime(e);
  if (!sd || !ed)         return 'Invalid (bad date format)';

  if (!validateSameDate(sd, ed))        return 'Invalid (different dates)';
  if (!validateStartBeforeEnd(sd, ed))  return 'Invalid (start ≥ end)';
  if (!validateMinDuration(sd, ed, 10)) return 'Invalid (< 10 min)';
  if (!validateMaxDuration(sd, ed, 240))return 'Invalid (> 4 h)';

  return 'Valid';
}

// 5. Individual rule checks
function validateStartEndType(st, et) {
  return st === '1' && et === '1';
}
function validateSameDate(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}
function validateStartBeforeEnd(a, b) {
  return a < b;
}
function validateMinDuration(a, b, mins) {
  return (b - a) / 1000 / 60 >= mins;
}
function validateMaxDuration(a, b, mins) {
  return (b - a) / 1000 / 60 <= mins;
}

// 6. Parse "DD/MM/YYYY HH:mm" into a JS Date
function parseDateTime(str) {
  const [datePart, timePart] = str.split(' ');
  if (!datePart || !timePart) return null;

  const [d,m,y] = datePart.split('/').map(Number);
  const [h,mm]  = timePart.split(':').map(Number);
  if ([d,m,y,h,mm].some(isNaN)) return null;

  return new Date(y, m - 1, d, h, mm);
}

// 7. Helper to render a message
function renderMessage(html) {
  document.getElementById('tableContainer').innerHTML = `<p>${html}</p>`;
}
