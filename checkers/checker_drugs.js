let drugData = [], xmlData = null;

const modeRadios = document.querySelectorAll('input[name="mode"]');
const lookupPanel = document.getElementById('lookup-panel');
const analysisPanel = document.getElementById('analysis-panel');
const xlsxUpload = document.getElementById('xlsx-upload');
const drugCount = document.getElementById('drug-count');
const drugInput = document.getElementById('drug-code-input');
const searchDrugBtn = document.getElementById('search-drug-btn');
const lookupResults = document.getElementById('lookup-results');
const xmlUpload = document.getElementById('xml-upload');
const xmlClaimCount = document.getElementById('xml-claim-count');
const analyzeBtn = document.getElementById('analyze-btn');
const analysisResults = document.getElementById('analysis-results');

const DRUG_COLUMNS = [
  "Drug Code", "Package Name", "Dosage Form", "Package Size", "Unit Price to Public",
  "Status", "Delete Effective Date", "UPP Scope", "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
  "Included In Basic Drug Formulary", "UPP Effective Date", "UPP Updated Date"
];

const DISPLAY_HEADERS = [
  "Drug Code", "Package Name", "Dosage Form", "Size", "Unit Price", "Status", "Deletion Effective Date", "Scope",
  "Included in Thiqa", "Included in Daman Basic", "Effective Date", "Updated Date"
];

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function isBooleanLike(value) {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return value === 0 || value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return ["true","false","yes","no","1","0"].includes(v);
  }
  return false;
}

function toYesNo(value) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return value === 1 ? "Yes" : "No";
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true","yes","1"].includes(v)) return "Yes";
    if (["false","no","0"].includes(v)) return "No";
  }
  return value;
}

function toggleModePanels() {
  const selected = document.querySelector('input[name="mode"]:checked').value;
  lookupPanel.style.display = selected === 'lookup' ? 'block' : 'none';
  analysisPanel.style.display = selected === 'analysis' ? 'block' : 'none';
  
  const hasDrugs = drugData.length > 0, hasXML = !!xmlData;
  drugInput.disabled = !hasDrugs || selected !== 'lookup';
  searchDrugBtn.disabled = !hasDrugs || selected !== 'lookup';
  analyzeBtn.disabled = !(hasDrugs && hasXML && selected === 'analysis');
  
  lookupResults.innerHTML = "";
  analysisResults.innerHTML = "";
}
modeRadios.forEach(r => r.addEventListener('change', toggleModePanels));
toggleModePanels();

xlsxUpload.addEventListener('change', e => {
  if (!e.target.files[0]) return;
  drugCount.textContent = "Loading drug list...";
  const reader = new FileReader();
  reader.onload = ev => {
    const wb = XLSX.read(ev.target.result, { type: 'binary' });
    const sheet = wb.Sheets[wb.SheetNames[1]];
    const json = XLSX.utils.sheet_to_json(sheet);

    drugData = json.map(row => {
      const norm = {};
      Object.keys(row).forEach(k => {
        const key = k.trim();
        const val = row[k];
        const isDate = key === "UPP Effective Date" || key === "UPP Updated Date" || key === "Delete Effective Date";

        if (isBooleanLike(val)) {
          norm[key] = toYesNo(val);
        } else if (val === null || val === undefined || val.toString().trim() === "") {
          norm[key] = isDate ? "NO DATE" : "";
        } else if (isDate && typeof val === "number") {
          const d = XLSX.SSF.parse_date_code(val);
          const dd = String(d.d).padStart(2, '0');
          const mmm = MONTHS[d.m - 1];
          const yyyy = d.y;
          norm[key] = `${dd}-${mmm}-${yyyy}`;
        } else {
          norm[key] = val.toString().trim();
        }
      });
      return norm;
    }).filter(r => r["Drug Code"]);

    drugCount.textContent = `Loaded ${drugData.length} drug entries.`;
    toggleModePanels();
  };
  reader.readAsBinaryString(e.target.files[0]);
});

searchDrugBtn.addEventListener('click', () => {
  const code = drugInput.value.trim();
  if (!code) return;
  const matches = drugData.filter(r => r["Drug Code"] === code);
  lookupResults.innerHTML = matches.length ? buildDrugTable(matches) : `<p>No match found for drug code: <strong>${code}</strong></p>`;
});

xmlUpload.addEventListener('change', e => {
  if (!e.target.files[0]) return;
  xmlClaimCount.textContent = "XML loaded. Waiting on schema for processing.";
  xmlData = true;
  if (drugData.length) analyzeBtn.disabled = false;
});

analyzeBtn.addEventListener('click', () => {
  analysisResults.innerHTML = `<div class="error-box">XML Analysis is disabled until schema is available.</div>`;
});

function buildDrugTable(drugs) {
  let table = `<table><thead><tr>`;
  DISPLAY_HEADERS.forEach(h => table += `<th>${h}</th>`);
  table += `</tr></thead><tbody>`;

  drugs.forEach(row => {
    const status = (row["Status"] || "").toLowerCase();
    const statusActive = status === "active";
    const hasNo = [
      "UPP Scope",
      "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
      "Included In Basic Drug Formulary"
    ].some(col => (row[col] || "").toLowerCase() === "no");
    const rowClass = statusActive ? (hasNo ? "unknown" : "valid") : "invalid";

    table += `<tr class="${rowClass}">`;

    // Now manually output columns in the exact display order
    table += `<td>${row["Drug Code"] || "N/A"}</td>`;
    table += `<td>${row["Package Name"] || "N/A"}</td>`;
    table += `<td>${row["Dosage Form"] || "N/A"}</td>`;
    table += `<td>${row["Package Size"] || "N/A"}</td>`;
    table += `<td>${row["Unit Price to Public"] || "N/A"}</td>`;

    // Status and Delete Effective Date
    table += `<td>${row["Status"] || "N/A"}</td>`;
    table += `<td>${row["Delete Effective Date"] || "NO DATE"}</td>`;

    table += `<td>${row["UPP Scope"] || "N/A"}</td>`;
    table += `<td>${row["Included in Thiqa/ ABM - other than 1&7- Drug Formulary"] || "N/A"}</td>`;
    table += `<td>${row["Included In Basic Drug Formulary"] || "N/A"}</td>`;

    table += `<td>${row["UPP Effective Date"] || "NO DATE"}</td>`;
    table += `<td>${row["UPP Updated Date"] || "NO DATE"}</td>`;

    table += `</tr>`;
  });

  table += `</tbody></table>`;
  return table;
}
