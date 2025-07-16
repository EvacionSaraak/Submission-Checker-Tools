const eligibilitySection = document.getElementById('eligibility-section');
const reportSection = document.getElementById('report-section');
const combineButton = document.getElementById('combine-button');
const messageBox = document.getElementById('messageBox');
let mode = 'eligibility';

document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener('change', e => {
    mode = e.target.value;
    eligibilitySection.classList.toggle('hidden', mode !== 'eligibility');
    reportSection.classList.toggle('hidden', mode !== 'report');
    messageBox.textContent = '';
  });
});

combineButton.addEventListener('click', async () => {
  messageBox.textContent = '';
  try {
    if (mode === 'eligibility') {
      const files = document.getElementById('eligibility-files').files;
      if (files.length) await combineEligibilityFiles(files);
      else messageBox.textContent = 'No eligibility files selected.';
    } else {
      const files = document.getElementById('report-files').files;
      if (files.length) await combineReportFiles(files);
      else messageBox.textContent = 'No report files selected.';
    }
  } catch (err) {
    console.error(err);
    messageBox.textContent = 'An error occurred during processing.';
  }
});

async function combineEligibilityFiles(fileList) {
  const mergedRows = [];
  let headers;

  for (const file of fileList) {
    const data = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(data, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (!headers) headers = json[1]; // Header on second row
    const dataRows = json.slice(2);
    mergedRows.push(...dataRows);
  }

  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...mergedRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Eligibility');
  XLSX.writeFile(workbook, 'EligibilityCombined.xlsx');
}

async function combineReportFiles(fileList) {
  const finalHeaders = [
    "Pri. Claim No", "Clinician License", "Encounter Date", "Pri. Patient Insurance Card No",
    "Department", "Visit Id", "Pri. Plan Type", "Facility ID", "Patient Code", "Clinician Name", "Opened by"
  ];
  const mergedRows = [];

  for (const file of fileList) {
    const ext = file.name.split('.').pop().toLowerCase();
    const data = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(data, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    // Auto-detect header row
    let headerRowIndex = allRows.findIndex(row =>
      row.includes("Clinician License") || row.includes("Pri. Claim No")
    );
    const headers = allRows[headerRowIndex];
    const dataRows = allRows.slice(headerRowIndex + 1);

    for (const row of dataRows) {
      const rowObj = Object.fromEntries(headers.map((key, i) => [key, row[i]]));

      mergedRows.push([
        rowObj["Pri. Claim No"] || rowObj["ClaimID"] || '',
        rowObj["Clinician License"] || '',
        rowObj["Encounter Date"] || rowObj["ClaimDate"] || '',
        rowObj["Pri. Patient Insurance Card No"] || rowObj["Member ID"] || '',
        rowObj["Department"] || '',
        rowObj["Visit Id"] || '',
        rowObj["Pri. Plan Type"] || '',
        rowObj["Facility ID"] || rowObj["Institution"] || '',
        rowObj["Patient Code"] || rowObj["FileNo"] || '',
        rowObj["Clinician Name"] || '',
        rowObj["Opened by"] || rowObj["Updated By"] || ''
      ]);
    }
  }

  const worksheet = XLSX.utils.aoa_to_sheet([finalHeaders, ...mergedRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Reports');
  XLSX.writeFile(workbook, 'ReportsCombined.xlsx');
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = e => reject(e);
    reader.readAsArrayBuffer(file);
  });
}
