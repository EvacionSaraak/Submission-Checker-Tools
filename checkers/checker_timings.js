document.getElementById('xmlFileInput').addEventListener('change', function (event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const xmlString = e.target.result;
    parseXMLAndRenderTable(xmlString);
  };
  reader.readAsText(file);
});

function parseXMLAndRenderTable(xmlString) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, 'application/xml');

  // The root element is Claim.Submission (note: tag name is case sensitive)
  const claimElements = xmlDoc.getElementsByTagName('Claim');

  if (!claimElements.length) {
    document.getElementById('tableContainer').innerHTML = "<p>No <code>&lt;Claim&gt;</code> elements found.</p>";
    return;
  }

  let tableHTML = `
    <table border="1" cellpadding="5">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Patient ID</th>
          <th>Doctor</th>
          <th>Total Amount</th>
          <th>Encounter Validity</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (let claim of claimElements) {
    const claimID = getTagValue(claim, 'ID');
    const patientID = getTagValue(claim, 'MemberID');
    const doctor = getTagValue(claim, 'ProviderID');
    const amount = getTagValue(claim, 'Net');

    const encounter = claim.getElementsByTagName('Encounter')[0];
    const validity = encounter ? validateEncounterData(encounter) : 'No Encounter';

    tableHTML += `
      <tr>
        <td>${claimID}</td>
        <td>${patientID}</td>
        <td>${doctor}</td>
        <td>${amount}</td>
        <td>${validity}</td>
      </tr>
    `;
  }

  tableHTML += `</tbody></table>`;
  document.getElementById('tableContainer').innerHTML = tableHTML;
}

function getTagValue(parent, tagName) {
  const el = parent.getElementsByTagName(tagName)[0];
  return el ? el.textContent.trim() : 'N/A';
}

function validateEncounterData(encounter) {
  const startStr = getTagValue(encounter, 'Start');
  const endStr = getTagValue(encounter, 'End');
  const startType = getTagValue(encounter, 'StartType');
  const endType = getTagValue(encounter, 'EndType');

  if (!startStr || !endStr) return "Invalid (missing start/end)";
  if (!validateStartEndType(startType, endType)) return "Invalid (start/end type not 1)";

  const startDateTime = parseDateTime(startStr);
  const endDateTime = parseDateTime(endStr);
  if (!startDateTime || !endDateTime) return "Invalid (unparsable dates)";

  if (!validateSameDate(startDateTime, endDateTime)) return "Invalid (different start/end dates)";
  if (!validateStartBeforeEnd(startDateTime, endDateTime)) return "Invalid (start not before end)";
  if (!validateMinDuration(startDateTime, endDateTime, 10)) return "Invalid (less than 10 mins difference)";
  if (!validateMaxDuration(startDateTime, endDateTime, 240)) return "Invalid (duration > 4 hours)";

  return "Valid";
}

function validateStartEndType(startType, endType) {
  return startType === '1' && endType === '1';
}

function validateSameDate(startDateTime, endDateTime) {
  return (
    startDateTime.getFullYear() === endDateTime.getFullYear() &&
    startDateTime.getMonth() === endDateTime.getMonth() &&
    startDateTime.getDate() === endDateTime.getDate()
  );
}

function validateStartBeforeEnd(startDateTime, endDateTime) {
  return startDateTime < endDateTime;
}

function validateMinDuration(startDateTime, endDateTime, minMinutes) {
  const diffMins = (endDateTime - startDateTime) / 1000 / 60;
  return diffMins >= minMinutes;
}

function validateMaxDuration(startDateTime, endDateTime, maxMinutes) {
  const diffMins = (endDateTime - startDateTime) / 1000 / 60;
  return diffMins <= maxMinutes;
}

function parseDateTime(dateTimeStr) {
  // Example format: "22/10/2023 15:55"
  // We parse manually because Date.parse might not handle dd/mm/yyyy well
  const [datePart, timePart] = dateTimeStr.split(' ');
  if (!datePart || !timePart) return null;

  const [day, month, year] = datePart.split('/').map(Number);
  const [hours, minutes] = timePart.split(':').map(Number);

  if (
    !day || !month || !year ||
    hours === undefined || minutes === undefined
  ) return null;

  return new Date(year, month - 1, day, hours, minutes);
}
