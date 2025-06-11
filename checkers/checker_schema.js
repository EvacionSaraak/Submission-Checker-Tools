// Make sure to add <script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script> in your HTML <head> or before your checker_schema.js

function validateXmlSchema() {
  const fileInput = document.getElementById("xmlFile");
  const status = document.getElementById("uploadStatus");
  const resultsDiv = document.getElementById("results");

  resultsDiv.innerHTML = "";
  status.textContent = "";

  const file = fileInput.files[0];
  if (!file) {
    status.textContent = "Please select an XML file first.";
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    const xmlContent = e.target.result;

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlContent, "application/xml");

    const parseErrors = xmlDoc.getElementsByTagName("parsererror");
    if (parseErrors.length > 0) {
      status.textContent = "XML Parsing Error: The file is not well-formed.";
      resultsDiv.innerHTML = `<pre>${parseErrors[0].textContent}</pre>`;
      return;
    }

    status.textContent = "XML parsed successfully. Validating Principal Diagnosis...";

    const results = validatePrincipalDiagnosis(xmlDoc);

    renderResults(results, resultsDiv);

    status.textContent = "Validation complete.";
  };

  reader.onerror = function () {
    status.textContent = "Error reading the file.";
  };

  reader.readAsText(file);
}

function validatePrincipalDiagnosis(xmlDoc) {
  const results = [];
  const claims = xmlDoc.getElementsByTagName("Claim");

  if (claims.length === 0) {
    results.push({
      ClaimID: "N/A",
      PrincipalDiagnosisCount: 0,
      Remark: "No <Claim> elements found."
    });
    return results;
  }

  for (const claim of claims) {
    const claimID = claim.getElementsByTagName("ID")[0]?.textContent.trim() || "Unknown";
    const diagnoses = claim.getElementsByTagName("Diagnosis");
    let principalCount = 0;

    for (const diag of diagnoses) {
      const type = diag.getElementsByTagName("Type")[0]?.textContent.trim();
      if (type === "Principal") {
        principalCount++;
      }
    }

    let remark = "";
    if (principalCount === 0) remark = "No Principal Diagnosis";
    else if (principalCount > 1) remark = "Multiple Principal Diagnoses";
    else remark = "OK";

    results.push({
      ClaimID: claimID,
      PrincipalDiagnosisCount: principalCount,
      Remark: remark
    });
  }

  return results;
}

function renderResults(results, container) {
  container.innerHTML = "";

  const table = document.createElement("table");
  table.classList.add("table");
  table.style.borderCollapse = "collapse";
  table.style.width = "100%";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  ["Claim ID", "Principal Diagnosis Count", "Remark"].forEach(text => {
    const th = document.createElement("th");
    th.textContent = text;
    th.style.padding = "8px";
    th.style.border = "1px solid #ccc";
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  results.forEach(row => {
    const tr = document.createElement("tr");

    [row.ClaimID, row.PrincipalDiagnosisCount, row.Remark].forEach(text => {
      const td = document.createElement("td");
      td.textContent = text;
      td.style.padding = "6px";
      td.style.border = "1px solid #ccc";
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  container.appendChild(table);

  // Export XLSX button
  const exportBtn = document.createElement("button");
  exportBtn.textContent = "Export XLSX";
  exportBtn.style.marginTop = "10px";
  exportBtn.onclick = () => exportToXLSX(results);
  container.appendChild(exportBtn);
}

function exportToXLSX(data) {
  // Convert JSON data to worksheet
  const ws = XLSX.utils.json_to_sheet(data);

  // Create a new workbook and append the worksheet
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Validation Results");

  // Export workbook as XLSX file
  XLSX.writeFile(wb, "principal_diagnosis_validation.xlsx");
}
