document.getElementById('fileInput').addEventListener('change', function(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = e => processXML(e.target.result);
  reader.readAsText(file);
});

function processXML(xmlString) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, "text/xml");
  const claims = xmlDoc.getElementsByTagName('claim');
  const tbody = document.querySelector('#resultsTable tbody');
  tbody.innerHTML = ''; // Clear previous

  const fragment = document.createDocumentFragment();

  for (let claim of claims) {
    const claimID = claim.getAttribute('id') || '-';
    const startStr = claim.getAttribute('start') || '';
    const endStr = claim.getAttribute('end') || '';
    const startType = claim.getAttribute('startType') || '';
    const endType = claim.getAttribute('endType') || '';

    const issues = [];
    const startDateTime = new Date(startStr);
    const endDateTime = new Date(endStr);

    const [startDate, startTime] = splitDateTime(startStr);
    const [endDate, endTime] = splitDateTime(endStr);

    if (startDate !== endDate) issues.push('Start and end dates differ');

    const diffMinutes = (endDateTime - startDateTime) / 60000;
    if (diffMinutes < 10) issues.push('Less than 10 minutes difference');
    if (startDateTime >= endDateTime) issues.push('Start time not earlier than end time');
    if (diffMinutes > 240) issues.push('Duration longer than 4 hours');
    if (startType !== '1') issues.push(`Start Type is not 1 (found ${startType})`);
    if (endType !== '1') issues.push(`End Type is not 1 (found ${endType})`);

    const status = issues.length === 0 ? 'Passed' : 'Failed';

    const tr = document.createElement('tr');
    tr.className = status.toLowerCase();

    [claimID, startDate, startTime, endDate, endTime, status, issues.length ? issues.join('; ') : '-']
      .forEach(text => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });

    fragment.appendChild(tr);
  }

  tbody.appendChild(fragment);
  document.getElementById('resultsTable').style.display = 'table';
}

function splitDateTime(dateTimeStr) {
  if (!dateTimeStr) return ['-', '-'];
  if (dateTimeStr.includes('T')) {
    const [date, time] = dateTimeStr.split('T');
    return [date, time.split('.')[0]];
  }
  const parts = dateTimeStr.split(' ');
  return parts.length === 2 ? parts : [dateTimeStr, '-'];
}
