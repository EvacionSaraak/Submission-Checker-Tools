let xmlText = '';

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) {
    alert('No file selected');
    return;
  }
  const reader = new FileReader();
  reader.onload = (event) => {
    xmlText = event.target.result;
    document.getElementById('checkBtn').disabled = false;
    document.getElementById('results').textContent = 'File loaded. Ready to check.';
  };
  reader.readAsText(file);
});

document.getElementById('checkBtn').addEventListener('click', () => {
  if (!xmlText) {
    alert('Please upload an XML file first.');
    return;
  }

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

  const claims = xmlDoc.getElementsByTagName('Claim');
  const results = [];

  function parseDateTime(dtStr) {
    // dtStr format: dd/MM/yyyy HH:mm
    // Convert to JS Date object (assume local timezone)
    const [datePart, timePart] = dtStr.split(' ');
    const [dd, mm, yyyy] = datePart.split('/');
    const [HH, MM] = timePart.split(':');
    return new Date(yyyy, mm - 1, dd, HH, MM);
  }

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    const claimID = claim.getElementsByTagName('ID')[0]?.textContent || 'Unknown';

    const encounter = claim.getElementsByTagName('Encounter')[0];
    if (!encounter) {
      results.push(`Claim ${claimID}: No Encounter data found.`);
      continue;
    }

    const startStr = encounter.getElementsByTagName('Start')[0]?.textContent;
    const endStr = encounter.getElementsByTagName('End')[0]?.textContent;
    const startType = encounter.getElementsByTagName('StartType')[0]?.textContent;
    const endType = encounter.getElementsByTagName('EndType')[0]?.textContent;

    if (!startStr || !endStr || !startType || !endType) {
      results.push(`Claim ${claimID}: Missing encounter start/end datetime or types.`);
      continue;
    }

    // Parse Date objects
    const startDT = parseDateTime(startStr);
    const endDT = parseDateTime(endStr);

    // Extract dates only for date equality check
    const startDateStr = startStr.split(' ')[0];
    const endDateStr = endStr.split(' ')[0];

    let issues = [];

    // 1. Start and end dates must be same
    if (startDateStr !== endDateStr) {
      issues.push('Start and End dates differ');
    }

    // 2. Start time must be earlier than end time
    if (startDT >= endDT) {
      issues.push('Start time is not earlier than End time');
    }

    // 3. Difference must be at least 10 minutes
    const diffMs = endDT - startDT;
    const diffMins = diffMs / 60000;
    if (diffMins < 10) {
      issues.push('Duration less than 10 minutes');
    }

    // 4. Flag durations longer than 4 hours (240 mins)
    if (diffMins > 240) {
      issues.push('Duration longer than 4 hours');
    }

    // 5. StartType and EndType must be 1
    if (startType !== '1' || endType !== '1') {
      issues.push(`StartType or EndType not 1 (StartType=${startType}, EndType=${endType})`);
    }

    if (issues.length === 0) {
      results.push(`Claim ${claimID}: All timing checks passed.`);
    } else {
      results.push(`Claim ${claimID}: Issues found:\n - ${issues.join('\n - ')}`);
    }
  }

  document.getElementById('results').textContent = results.join('\n\n');
});
