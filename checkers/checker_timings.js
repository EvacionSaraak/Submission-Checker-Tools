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

  const claimSubmissions = xmlDoc.getElementsByTagName('claimSubmission');
  if (!claimSubmissions.length) {
    document.getElementById('tableContainer').innerHTML = "<p>No <code>&lt;claimSubmission&gt;</code> elements found.</p>";
    return;
  }

  let tableHTML = `
    <table border="1" cellpadding="5">
      <thead>
        <tr>
          <th>Claim ID</th>
          <th>Submission Time</th>
          <th>Patient ID</th>
          <th>Doctor</th>
          <th>Total Amount</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (let submission of claimSubmissions) {
    const claimID = getTagValue(submission, 'claimID');
    const submissionTime = getTagValue(submission, 'submissionTime');
    const patientID = getTagValue(submission, 'patientID');
    const doctor = getTagValue(submission, 'doctorName');
    const amount = getTagValue(submission, 'totalAmount');

    tableHTML += `
      <tr>
        <td>${claimID}</td>
        <td>${submissionTime}</td>
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
