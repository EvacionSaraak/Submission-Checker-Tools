let drugData = [];
let xmlData = null;

// Elements
const modeRadios = document.querySelectorAll('input[name="mode"]');
const lookupPanel = document.getElementById('lookup-panel');
const analysisPanel = document.getElementById('analysis-panel');

// Lookup elements
const xlsxLookup = document.getElementById('xlsx-lookup');
const drugCountLookup = document.getElementById('lookup-drug-count');
const drugInput = document.getElementById('drug-code-input');
const searchDrugBtn = document.getElementById('search-drug-btn');
const lookupResults = document.getElementById('lookup-results');

// Analysis elements
const xlsxAnalysis = document.getElementById('xlsx-analysis');
const drugCountAnalysis = document.getElementById('analysis-drug-count');
const xmlUpload = document.getElementById('xml-upload');
const xmlClaimCount = document.getElementById('xml-claim-count');
const analyzeBtn = document.getElementById('analyze-btn');
const analysisResults = document.getElementById('analysis-results');

// Mode switching
modeRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    const selected = document.querySelector('input[name="mode"]:checked').value;
    lookupPanel.classList.toggle('hidden', selected !== 'lookup');
    analysisPanel.classList.toggle('hidden', selected !== 'analysis');
  });
});

// Drug data parser
function parseDrugsFromXLSX(file, displayTarget, enableInputCallback) {
  const reader = new FileReader();
  reader.onload = e => {
    const workbook = XLSX.read(e.target.result, { type: 'binary' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet);

    // Filter only rows with Drug Code
    drugData = json.filter(row => row["Drug Code"]);

    displayTarget.textContent = `Loaded ${drugData.length} drug entries.`;
    enableInputCallback(true);
  };
  reader.readAsBinaryString(file);
}

// Drug lookup
xlsxLookup.addEventListener('change', e => {
  if (e.target.files[0]) {
    parseDrugsFromXLSX(e.target.files[0], drugCountLookup, (enable) => {
      drugInput.disabled = !enable;
      searchDrugBtn.disabled = !enable;
    });
  }
});

searchDrugBtn.addEventListener('click', () => {
  const code = drugInput.value.trim();
  const matches = drugData.filter(row => row["Drug Code"] == code);
  if (matches.length > 0) {
    lookupResults.innerHTML = buildDrugTable(matches);
  } else {
    lookupResults.innerHTML = `<p>No match found for drug code: <strong>${code}</strong></p>`;
  }
});

// XML Analysis setup (disabled for now)
xlsxAnalysis.addEventListener('change', e => {
  if (e.target.files[0]) {
    parseDrugsFromXLSX(e.target.files[0], drugCountAnalysis, tryEnableAnalyze);
  }
});

xmlUpload.addEventListener('change', e => {
  if (e.target.files[0]) {
    // Placeholder – actual XML parsing pending
    xmlClaimCount.textContent = `XML loaded. Waiting on schema for processing.`;
    xmlData = true; // Simulate
    tryEnableAnalyze();
  }
});

function tryEnableAnalyze() {
  if (drugData.length > 0 && xmlData) {
    analyzeBtn.disabled = false;
  }
}

analyzeBtn.addEventListener('click', () => {
  analysisResults.innerHTML = `<p>XML Analysis feature is currently disabled until schema is available.</p>`;
});

// Reusable table builder
function buildDrugTable(drugs) {
  const headers = [
    "Drug Code", "Package Name", "Dosage Form", "Package Size",
    "Unit Price to Public", "Status", "UPP Scope",
    "Included in Thiqa/ABM Formulary", "Included in Basic Formulary",
    "UPP Effective Date", "UPP Updated Date"
  ];

  const displayNames = [
    "Code", "Package", "Form", "Size", "Unit Price", "Status", "Scope",
    "Thiqa Included", "Basic Included", "Effective Date", "Updated Date"
  ];

  let table = `<table><thead><tr>`;
  displayNames.forEach(name => table += `<th>${name}</th>`);
  table += `</tr></thead><tbody>`;

  drugs.forEach(row => {
    const status = (row["Status"] || "").toLowerCase();
    const isValid = status === "active";
    const validityTag = isValid
      ? `<span style="color: green; font-weight: bold;">Valid</span>`
      : `<span style="color: red; font-weight: bold;">Invalid</span>`;

    table += `<tr>`;
    headers.forEach(col => {
      table += `<td>${row[col] || ''}</td>`;
    });
    table += `<td>${validityTag}</td>`;
    table += `</tr>`;
  });

  table += `</tbody></table>`;
  return table;
}
