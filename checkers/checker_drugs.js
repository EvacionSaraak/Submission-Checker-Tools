let drugData = [], xmlData = null, selectedDrug = null;

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
const quantitySection = document.getElementById('quantity-section');
const quantityInput = document.getElementById('quantity-input');
const calculateBtn = document.getElementById('calculate-btn');
const calcOutput = document.getElementById('calc-output');

const DRUG_COLUMNS = [
  "Drug Code", "Package Name", "Dosage Form", "Package Size", "Package Price to Public",
  "Unit Price to Public", "Status", "Delete Effective Date",
  "UPP Scope", "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
  "Included In Basic Drug Formulary", "UPP Effective Date", "UPP Updated Date"
];

const DISPLAY_HEADERS = [
  "Code", "Package", "Form", "Package Size", "Package Price", "Unit Price", 
  "Status", "Delete Effective Date", "UPP Scope", "Included in Thiqa",
  "Included in DAMAN Basic", "Effective Date", "Updated Date"
];

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

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
  quantitySection.style.display = 'none';
  calcOutput.textContent = "";
  selectedDrug = null;
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
        const isDate = [
          "UPP Effective Date",
          "UPP Updated Date",
          "Delete Effective Date"
        ].includes(key);

        if (typeof val === "boolean") {
          norm[key] = val ? "Yes" : "No";
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
  const query = drugInput.value.trim();
  if (!query) return;

  const lowerQuery = query.toLowerCase();
  const matches = drugData.filter(r =>
    r["Drug Code"] === query ||
    (r["Package Name"] && r["Package Name"].toLowerCase().includes(lowerQuery))
  );

  // Reset UI and states
  lookupResults.innerHTML = "";
  selectedDrug = null;
  quantityInput.value = "";
  calcOutput.textContent = "";
  quantitySection.classList.add("hidden");
  calculateBtn.disabled = true;

  if (matches.length) {
    // Get the DOM element table with listeners attached
    const tableElement = buildDrugTable(matches);
    // Insert the table element
    lookupResults.appendChild(tableElement);
    // Append quantity section after the table
    lookupResults.appendChild(quantitySection);
  } else {
    lookupResults.innerHTML = `<p>No match found for: <strong>${query}</strong></p>`;
  }
});

calculateBtn.addEventListener('click', () => {
  const qty = parseFloat(quantityInput.value);
  if (isNaN(qty) || qty <= 0) {
    calcOutput.textContent = "Invalid quantity.";
    return;
  }

  if (!selectedDrug) {
    calcOutput.textContent = "No drug selected.";
    return;
  }

  const unitPrice = parseFloat(selectedDrug["Unit Price to Public"]);
  if (isNaN(unitPrice)) {
    calcOutput.textContent = "Invalid unit price.";
    return;
  }

  const total = qty * unitPrice;
  calcOutput.textContent = `Total: AED ${total.toFixed(2)}`;
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
  // Build table HTML as string
  let tableHTML = `<table><thead><tr>`;
  DISPLAY_HEADERS.forEach(h => tableHTML += `<th>${h}</th>`);
  tableHTML += `</tr></thead><tbody>`;

  drugs.forEach(row => {
    const status = (row["Status"] || "").toLowerCase();
    const statusActive = status === "active";
    const hasNo = [
      "UPP Scope",
      "Included in Thiqa/ ABM - other than 1&7- Drug Formulary",
      "Included In Basic Drug Formulary"
    ].some(col => (row[col] || "").toLowerCase() === "no");
    const rowClass = statusActive ? (hasNo ? "unknown" : "valid") : "invalid";

    tableHTML += `<tr class="${rowClass}">`;
    tableHTML += `<td>${row["Drug Code"] || "N/A"}</td>`;
    tableHTML += `<td>${row["Package Name"] || "N/A"}</td>`;
    tableHTML += `<td>${row["Dosage Form"] || "N/A"}</td>`;
    tableHTML += `<td>${row["Package Size"] || "N/A"}</td>`;
    tableHTML += `<td>${row["Package Price to Public"] || "N/A"}</td>`;
    tableHTML += `<td>${row["Unit Price to Public"] || "N/A"}</td>`;
    tableHTML += `<td>${row["Status"] || "N/A"}</td>`;
    tableHTML += `<td>${!statusActive ? (row["Delete Effective Date"] || "NO DATE") : "N/A"}</td>`;
    tableHTML += `<td>${row["UPP Scope"] || "Unknown"}</td>`;
    tableHTML += `<td>${row["Included in Thiqa/ ABM - other than 1&7- Drug Formulary"] || "Unknown"}</td>`;
    tableHTML += `<td>${row["Included In Basic Drug Formulary"] || "Unknown"}</td>`;
    tableHTML += `<td>${row["UPP Effective Date"] || "NO DATE"}</td>`;
    tableHTML += `<td>${row["UPP Updated Date"] || "NO DATE"}</td>`;
    tableHTML += `</tr>`;
  });

  tableHTML += `</tbody></table>`;

  // Create a container div and insert the table HTML
  const container = document.createElement('div');
  container.innerHTML = tableHTML;

  // Attach event listeners to rows now that elements exist in DOM tree
  const rows = container.querySelectorAll('tbody tr');
  rows.forEach((row, i) => {
    row.addEventListener('click', () => {
      // Remove selected class from all
      rows.forEach(r => r.classList.remove('selected-row'));
      // Highlight this row
      row.classList.add('selected-row');

      // Set global selectedDrug
      selectedDrug = drugs[i];

      // Show quantity section and enable calculate button
      quantitySection.classList.remove('hidden');
      calculateBtn.disabled = false;
      quantityInput.value = "";
      calcOutput.textContent = "";

      // Update displayed selected drug code
      const codeDisplay = document.getElementById("selected-drug-code");
      if (codeDisplay) {
        codeDisplay.textContent = selectedDrug["Drug Code"] || "N/A";
      }
    });
  });

  return container;
}
