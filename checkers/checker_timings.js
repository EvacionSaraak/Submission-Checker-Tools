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

  // Your root is Claim.Submission (case-sensitive)
  const claimSubmission = xmlDoc.getElementsByTagName('Claim.Submission')[0];
  if (!claimSubmission) {
    document.getElementById('tableContainer').innerHTML = "<p>No <code>&lt;Claim.Submission&gt;</code> element found.</p>";
    return;
  }

  // Get all Claim nodes under Claim.Submission
  const claims = claimSubmission.getElementsByTagName('Claim');
  if (!claims.length) {
    document.getElementById('tableContainer').innerHTML = "<p>No <code>&lt;Claim&gt;</code> elements found.</p>";
    return;
  }

  let tableHTML = `
    <table border="1" cellpadding="5" cellspacing="0">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Patient ID</th>
          <th>Doctor</th>
          <th>Total Amount (Gross)</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (let claim of claims) {
    // Claim ID
    const claimID = getTagValue(claim, 'ID');

    // PatientID is inside Encounter node
    const encounter = claim.getElementsByTagName('Encounter')[0];
    const patientID = encounter ? getTagValue(encounter, 'PatientID') : 'N/A';

    // Doctor is inside Activity -> Clinician
    const activity = claim.getElementsByTagName('Activity')[0];
    const doctor = activity ? getTagValue(activity, 'Clinician') : 'N/A';

    // Total Amount = Gross
    const amount = getTagValue(claim, 'Gross');

    tableHTML += `
      <tr>
        <td>${claimID}</td>
        <td>${patientID}</td>
        <td>${doctor}</td>
        <td>${amount}</td>
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
