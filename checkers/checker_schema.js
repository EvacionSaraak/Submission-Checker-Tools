// checker_schema.js
function validateXmlSchema() {
  const fileInput = document.getElementById("xmlFile"),
    status = document.getElementById("uploadStatus"),
    resultsDiv = document.getElementById("results");
  resultsDiv.innerHTML = ""; status.textContent = "";
  const file = fileInput.files[0];
  if (!file) { status.textContent = "Please select an XML file first."; return; }
  const reader = new FileReader();
  reader.onload = function (e) {
    const xmlContent = e.target.result,
      parser = new DOMParser(),
      xmlDoc = parser.parseFromString(xmlContent, "application/xml"),
      parseErrors = xmlDoc.getElementsByTagName("parsererror");
    if (parseErrors.length > 0) { status.textContent = "XML Parsing Error: The file is not well-formed."; resultsDiv.innerHTML = `<pre>${parseErrors[0].textContent}</pre>`; return; }
    status.textContent = "XML parsed successfully. Validating Claims...";
    const results = validateClaimSchema(xmlDoc);
    renderResults(results, resultsDiv);
    status.textContent = "Validation complete.";
  };
  reader.onerror = function () { status.textContent = "Error reading the file."; };
  reader.readAsText(file);
}

function validateClaimSchema(xmlDoc) {
  const results = [], claims = xmlDoc.getElementsByTagName("Claim");
  for (const claim of claims) {
    let missingFields = [], invalidFields = [], eidRemark = "", diagnosisRemark = "", principalCount = 0;
    function check(tag, parent = claim, prefix = "") {
      const el = parent.getElementsByTagName(tag)[0], val = el?.textContent?.trim();
      if (!el || val === "" || /\s/.test(val)) missingFields.push(prefix + tag);
      return val;
    }
    const vals = {}, fields = ["ID", "MemberID", "PayerID", "ProviderID", "EmiratesIDNumber", "Gross", "PatientShare", "Net"];
    fields.forEach(tag => vals[tag] = check(tag));
    if (vals["EmiratesIDNumber"] && !missingFields.includes("EmiratesIDNumber")) {
      const p = vals["EmiratesIDNumber"].split("-");
      if (p.length !== 4 || p[0] !== "784" || !/^\d{4}$/.test(p[1]) || !/^\d{7}$/.test(p[2]) || !/^\d{1}$/.test(p[3])) { eidRemark = "Invalid EmiratesIDNumber format"; invalidFields.push("EmiratesIDNumber"); }
    }
    const encounter = claim.getElementsByTagName("Encounter")[0];
    if (!encounter) missingFields.push("Encounter");
    else ["FacilityID", "Type", "PatientID", "Start", "End", "StartType", "EndType"].forEach(tag => check(tag, encounter, "Encounter."));
    const diagnoses = claim.getElementsByTagName("Diagnosis");
    if (!diagnoses.length) missingFields.push("Diagnosis");
    else Array.from(diagnoses).forEach((diag, i) => {
      const diagPrefix = `Diagnosis[${i}].`, typeVal = check("Type", diag, diagPrefix);
      if (typeVal === "Principal") principalCount++;
      check("Code", diag, diagPrefix);
    });
    if (diagnoses.length > 0) {
      if (principalCount === 0) diagnosisRemark = "No Principal Diagnosis";
      else if (principalCount > 1) diagnosisRemark = "Multiple Principal Diagnoses";
    }
    const activities = claim.getElementsByTagName("Activity");
    if (!activities.length) missingFields.push("Activity");
    else Array.from(activities).forEach((act, i) => {
      const actPrefix = `Activity[${i}].`;
      ["Start", "Type", "Code", "Quantity", "Net", "Clinician"].forEach(tag => check(tag, act, actPrefix));
      Array.from(act.getElementsByTagName("Observation")).forEach((obs, j) => ["Type", "Code", "Value", "ValueType"].forEach(tag => check(tag, obs, `${actPrefix}Observation[${j}].`)));
    });
    const contract = claim.getElementsByTagName("Contract")[0];
    if (contract) check("PackageName", contract, "Contract.");
    const isValid = missingFields.length === 0 && invalidFields.length === 0 && !eidRemark && !diagnosisRemark;
    let remarks = [];
    if (missingFields.length) remarks.push("Missing: " + missingFields.join(", "));
    if (eidRemark) remarks.push(eidRemark);
    if (diagnosisRemark) remarks.push(diagnosisRemark);
    if (!remarks.length) remarks.push("OK");
    results.push({ ClaimID: vals["ID"] || "Unknown", Valid: isValid, Remark: remarks.join("; "), ClaimXML: claim.outerHTML });
  }
  return results;
}

function formatXml(xml) {
  const formatted = xml.replace(/(>)(<)(\/*)/g, "$1\n$2$3");
  let pad = 0;
  return formatted.split("\n").map(node => {
    let indent = 0;
    if (node.match(/.+<\/\w[^>]*>$/)) indent = 0;
    else if (node.match(/^<\/\w/)) { if (pad !== 0) pad -= 2; }
    else if (node.match(/^<\w[^>]*[^\/]>.*$/)) indent = 2;
    const padding = " ".repeat(pad); pad += indent; return padding + node;
  }).join("\n");
}

function renderResults(results, container) {
  container.innerHTML = "";
  const table = document.createElement("table"); table.classList.add("table");
  table.style.borderCollapse = "collapse"; table.style.width = "100%";
  const thead = document.createElement("thead"), headerRow = document.createElement("tr");
  ["Claim ID", "Remark", "Valid", "View Full Claim"].forEach(text => {
    const th = document.createElement("th");
    th.textContent = text; th.style.padding = "8px"; th.style.border = "1px solid #ccc"; headerRow.appendChild(th);
  });
  thead.appendChild(headerRow); table.appendChild(thead);
  const tbody = document.createElement("tbody");
  results.forEach(row => {
    const tr = document.createElement("tr");
    tr.style.backgroundColor = row.Valid ? "#d4edda" : "#f8d7da";
    [row.ClaimID, row.Remark, row.Valid ? "Yes" : "No"].forEach(text => {
      const td = document.createElement("td");
      td.textContent = text; td.style.padding = "6px"; td.style.border = "1px solid #ccc"; tr.appendChild(td);
    });
    const btnTd = document.createElement("td"), viewBtn = document.createElement("button");
    viewBtn.textContent = "View";
    viewBtn.onclick = () => {
      const win = window.open("", "_blank", "width=600,height=600");
      win.document.write("<pre>" + formatXml(row.ClaimXML) + "</pre>");
    };
    btnTd.appendChild(viewBtn); tr.appendChild(btnTd); tbody.appendChild(tr);
  });
  table.appendChild(tbody); container.appendChild(table);
  const exportBtn = document.createElement("button");
  exportBtn.textContent = "Export XLSX"; exportBtn.style.marginTop = "10px";
  exportBtn.onclick = () => exportToXLSX(results);
  container.appendChild(exportBtn);
}

function exportToXLSX(data) {
  const exportData = data.map(row => ({ ClaimID: row.ClaimID, Remark: row.Remark, Valid: row.Valid ? "Yes" : "No" }));
  const ws = XLSX.utils.json_to_sheet(exportData), wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Validation Results");
  XLSX.writeFile(wb, "claim_schema_validation.xlsx");
}
