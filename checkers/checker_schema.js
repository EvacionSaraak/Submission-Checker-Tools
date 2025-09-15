// checker_schema.js with modal table view and Person schema support
// Requires SheetJS for Excel export: 
// <script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script>

// Automatically validate when file is uploaded
document.addEventListener("DOMContentLoaded", function () {
  const fileInput = document.getElementById("xmlFile");
  if (fileInput) {
    fileInput.addEventListener("change", function () {
      document.getElementById("uploadStatus").textContent = "";
      document.getElementById("results").innerHTML = "";
      if (fileInput.files.length > 0) {
        validateXmlSchema();
      }
    });
  }
});

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

    // Detect schema type
    let results = [];
    let schemaType = "";
    if (xmlDoc.documentElement.nodeName === "Claim.Submission") {
      schemaType = "claim";
      results = validateClaimSchema(xmlDoc);
    } else if (xmlDoc.documentElement.nodeName === "Person.Register") {
      schemaType = "person";
      results = validatePersonSchema(xmlDoc);
    } else {
      status.textContent = "Unknown schema: " + xmlDoc.documentElement.nodeName;
      return;
    }
    renderResults(results, resultsDiv, schemaType);

    // Stats
    const total = results.length;
    const valid = results.filter(r => r.Valid).length;
    const percent = total > 0 ? ((valid / total) * 100).toFixed(1) : "0.0";
    status.textContent = `Valid ${schemaType === "claim" ? "claims" : "persons"}: ${valid} / ${total} (${percent}%)`;
  };
  reader.onerror = function () {
    status.textContent = "Error reading the file.";
  };
  reader.readAsText(file);
}

function checkForFalseValues(parent, invalidFields, prefix = "") {
  for (const el of parent.children) {
    if (!el.children.length && (el.textContent || "").trim().toLowerCase() === "false")
      invalidFields.push(`The element ${ (prefix ? `${prefix} → ${el.nodeName}` : el.nodeName).replace(/^Claim(?:[.\s→]*)/, "").replace(/^Person(?:[.\s→]*)/, "") } has an invalid value 'false'.`);
    if (el.children.length) checkForFalseValues(el, invalidFields, prefix ? `${prefix} → ${el.nodeName}` : el.nodeName);
  }
}

function validateClaimSchema(xmlDoc) {
  const results = [];
  const claims = xmlDoc.getElementsByTagName("Claim");

  for (const claim of claims) {
    let missingFields = [], invalidFields = [], remarks = [];

    const present = (tag, parent = claim) => parent.getElementsByTagName(tag).length > 0;
    const text = (tag, parent = claim) => {
      const el = parent.getElementsByTagName(tag)[0];
      return el && el.textContent ? el.textContent.trim() : "";
    };
    const invalidIfNull = (tag, parent = claim, prefix = "") => !text(tag, parent) ? invalidFields.push(prefix + tag + " (null/empty)") : null;

    // Required fields
    ["ID", "MemberID", "PayerID", "ProviderID", "EmiratesIDNumber", "Gross", "PatientShare", "Net"].forEach(tag => invalidIfNull(tag, claim));

    // MemberID check
    const memberID = text("MemberID");
    if (memberID && /^0/.test(memberID)) invalidFields.push("MemberID (starts with 0)");

    // EmiratesIDNumber checks
    if (present("EmiratesIDNumber")) {
      const eid = text("EmiratesIDNumber"), p = eid.split("-");
      if (p.length !== 4 || p[0] !== "784" || !/^\d{4}$/.test(p[1]) || !/^\d{7}$/.test(p[2]) || !/^\d{1}$/.test(p[3]))
        invalidFields.push("EmiratesIDNumber (invalid format)");
      const eidDigits = eid.replace(/-/g, "");
      if (/^[129]+$/.test(eidDigits)) remarks.push("EmiratesIDNumber (Medical Tourism: all digits 1/2/9)");
      else if (/^0+$/.test(eidDigits)) remarks.push("EmiratesIDNumber (National without EID: all digits 0)");
    }

    // Encounter
    const encounter = claim.getElementsByTagName("Encounter")[0];
    !encounter ? missingFields.push("Encounter") : ["FacilityID","Type","PatientID","Start","End","StartType","EndType"].forEach(tag => invalidIfNull(tag, encounter, "Encounter."));

    // Diagnosis
    const diagnoses = claim.getElementsByTagName("Diagnosis");
    if (!diagnoses.length) missingFields.push("Diagnosis");
    else {
      let principalCode = null, typeCodeMap = {};
      Array.from(diagnoses).forEach((diag, i) => {
        const typeVal = text("Type", diag), codeVal = text("Code", diag), prefix = `Diagnosis[${i}].`;
        !typeVal && missingFields.push(prefix + "Type");
        !codeVal && missingFields.push(prefix + "Code");

        if (typeVal === "Principal") principalCode ? invalidFields.push("Principal Diagnosis (multiple found)") : principalCode = codeVal;

        if (typeVal !== "Principal" && codeVal) {
          if (!typeCodeMap[typeVal]) typeCodeMap[typeVal] = new Set();
          typeCodeMap[typeVal].has(codeVal) ? invalidFields.push(`Duplicate Diagnosis Code within Type '${typeVal}': ${codeVal}`) : typeCodeMap[typeVal].add(codeVal);
          principalCode && codeVal === principalCode ? invalidFields.push(`Diagnosis Code ${codeVal} duplicates Principal`) : null;
        }
      });
      !principalCode && invalidFields.push("Principal Diagnosis (none found)");
    }

    // Activities
    const activities = claim.getElementsByTagName("Activity");
    if (!activities.length) missingFields.push("Activity");
    else Array.from(activities).forEach((act, i) => {
      const prefix = `Activity[${i}].`;
      ["Start","Type","Code","Quantity","Net","Clinician"].forEach(tag => invalidIfNull(tag, act, prefix));
      Array.from(act.getElementsByTagName("Observation")).forEach((obs,j) => ["Type","Code"].forEach(tag => invalidIfNull(tag, obs, `${prefix}Observation[${j}].`)));
    });

    // Contract optional
    const contract = claim.getElementsByTagName("Contract")[0];
    contract && !text("PackageName", contract) ? invalidFields.push("Contract.PackageName (null/empty)") : null;

    // Check for false values
    checkForFalseValues(claim, invalidFields, "Claim.");

    // Compile remarks
    missingFields.length && remarks.push("Missing: " + missingFields.join(", "));
    invalidFields.length && remarks.push("Invalid: " + invalidFields.join(", "));
    !remarks.length && remarks.push("OK");

    results.push({
      ClaimID: text("ID") || "Unknown",
      Valid: !missingFields.length && !invalidFields.length,
      Remark: remarks.join("; "),
      ClaimXML: claim.outerHTML,
      SchemaType: "claim"
    });
  }

  return results;
}

function validatePersonSchema(xmlDoc) {
  const results = [];
  const persons = xmlDoc.getElementsByTagName("Person");
  for (const person of persons) {
    let missingFields = [];
    let invalidFields = [];
    let remarks = [];

    function present(tag, parent = person) { return parent.getElementsByTagName(tag).length > 0; }

    function text(tag, parent = person) {
      const el = parent.getElementsByTagName(tag)[0];
      return el && el.textContent ? el.textContent.trim() : "";
    }

    function invalidIfNull(tag, parent = person, prefix = "") {
      const val = text(tag, parent);
      if (!val) invalidFields.push(prefix + tag + " (null/empty)");
    }

    [
      "UnifiedNumber", "FirstName", "FirstNameEn", "LastNameEn", "ContactNumber",
      "BirthDate", "Gender", "Nationality", "City", "CountryOfResidence", "EmirateOfResidence", "EmiratesIDNumber"
    ].forEach(tag => invalidIfNull(tag, person));

    // EmiratesIDNumber checks
    if (present("EmiratesIDNumber")) {
      const eid = text("EmiratesIDNumber");
      const p = eid.split("-");
      if (p.length !== 4 || p[0] !== "784" || !/^\d{4}$/.test(p[1]) || !/^\d{7}$/.test(p[2]) || !/^\d{1}$/.test(p[3])) { invalidFields.push("EmiratesIDNumber (invalid format)"); }
      const eidDigits = eid.replace(/-/g, "");
      if (/^[129]+$/.test(eidDigits)) {
        remarks.push("EmiratesIDNumber (Medical Tourism: all digits 1/2/9)");
      } else if (/^0+$/.test(eidDigits)) {
        remarks.push("EmiratesIDNumber (National without EID: all digits 0)");
      }
    }

    // Member.ID check
    const member = person.getElementsByTagName("Member")[0];
    const memberID = member ? text("ID", member) : "Unknown";
    if (!member || !memberID) invalidFields.push("Member.ID (null/empty)");

    checkForFalseValues(person, invalidFields);

    if (missingFields.length) remarks.push("Missing: " + missingFields.join(", "));
    if (invalidFields.length) remarks.push("Invalid: " + invalidFields.join(", "));
    if (!remarks.length) remarks.push("OK");

    results.push({
      ClaimID: memberID,
      Valid: !missingFields.length && !invalidFields.length,
      Remark: remarks.join("; "),
      ClaimXML: person.outerHTML,
      SchemaType: "person"
    });
  }
  return results;
}

// Insert a modal dialog (if not already present)
function ensureModal() {
  if (document.getElementById("modalOverlay")) return;
  const modalHtml = `
    <div id="modalOverlay" style="display:none;position:fixed;z-index:9999;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.35);">
      <div id="modalContent" style="background:#fff;max-width:800px;max-height:85vh;overflow:auto;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:20px;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.2);">
        <button id="modalCloseBtn" style="float:right;font-size:18px;padding:2px 10px;cursor:pointer;" aria-label="Close">&times;</button>
        <div id="modalTable"></div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);
  document.getElementById("modalCloseBtn").onclick = hideModal;
  document.getElementById("modalOverlay").onclick = function(e) {
    if (e.target.id === "modalOverlay") hideModal();
  };
}
function showModal(html) {
  ensureModal();
  document.getElementById("modalTable").innerHTML = html;
  document.getElementById("modalOverlay").style.display = "block";
}
function hideModal() {
  document.getElementById("modalOverlay").style.display = "none";
}

// Render claim/person fields as an HTML table with field names and values
function claimToHtmlTable(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "application/xml");
  let root = doc.documentElement;
  if (root.nodeName !== "Claim" && root.nodeName !== "Person") {
    root = doc.getElementsByTagName("Claim")[0] || doc.getElementsByTagName("Person")[0];
  }
  if (!root) return "<b>Entry not found!</b>";

  function renderNode(node, level = 0) {
    let html = "";
    for (let i = 0; i < node.children.length; ++i) {
      const child = node.children[i];
      if (child.children.length === 0) {
        html += `<tr><td style="padding-left:${level * 20}px"><b>${child.nodeName}</b></td><td>${child.textContent}</td></tr>`;
      } else {
        html += `<tr><td style="padding-left:${level * 20}px"><b>${child.nodeName}</b></td><td></td></tr>`;
        html += renderNode(child, level + 1);
      }
    }
    return html;
  }

  let html = `<table border="1" cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">`;
  html += `<tr><th style="background:#f0f0f0">Field</th><th style="background:#f0f0f0">Value</th></tr>`;
  html += renderNode(root, 0);
  html += `</table>`;
  return html;
}

// renderResults (stores last results on window and places export button above table)
function renderResults(results, container, schemaType) {
  // keep a global reference so export works even if scopes change
  window._lastValidationResults = Array.isArray(results) ? results.slice() : [];
  window._lastValidationSchema = schemaType || "claim";
  container.innerHTML = "";

  // Export XLSX button above the table
  const exportBtn = document.createElement("button");
  exportBtn.textContent = "Export XLSX";
  exportBtn.style.marginBottom = "10px";
  exportBtn.onclick = () => exportErrorsToXLSX(); // uses global last results
  container.appendChild(exportBtn);

  const table = document.createElement("table");
  table.className = "table";
  table.style.borderCollapse = "collapse";
  table.style.width = "100%";

  // Header
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  [
    schemaType === "person" ? "Member ID" : "Claim ID",
    "Remark", "Valid", "View Full Entry"
  ].forEach(text => {
    const th = document.createElement("th");
    th.textContent = text;
    th.style.padding = "8px";
    th.style.border = "1px solid #ccc";
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement("tbody");
  (results || []).forEach(row => {
    const tr = document.createElement("tr");
    tr.style.backgroundColor = row.Valid ? "#d4edda" : "#f8d7da";
    [row.ClaimID, row.Remark, row.Valid ? "Yes" : "No"].forEach(text => {
      const td = document.createElement("td");
      td.textContent = text;
      td.style.padding = "6px";
      td.style.border = "1px solid #ccc";
      tr.appendChild(td);
    });
    const btnTd = document.createElement("td");
    const viewBtn = document.createElement("button");
    viewBtn.textContent = "View";
    viewBtn.onclick = () => showModal(claimToHtmlTable(row.ClaimXML));
    btnTd.appendChild(viewBtn);
    tr.appendChild(btnTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);
}

function exportErrorsToXLSX(data, schemaType) {
  const rows = Array.isArray(data) ? data : (Array.isArray(window._lastValidationResults) ? window._lastValidationResults : []);
  const schema = schemaType || window._lastValidationSchema || "claim";
  if (!rows.length) {
    alert("No results available to export.");
    return;
  }
  if (typeof XLSX === "undefined") {
    console.error("SheetJS (XLSX) is not loaded.");
    return alert("Export failed: XLSX library not loaded. Include xlsx.full.min.js before this script.");
  }

  const errorRows = rows.filter(r => r.Remark !== "OK");
  if (!errorRows.length) return alert("No errors to export.");
  const exportData = errorRows.map(row => ({
    [schema === "person" ? "UnifiedNumber" : "ClaimID"]: row.ClaimID,
    Remark: row.Remark
  }));

  let fileName = null;
  const fileInput = document.getElementById("xmlFile");
  if (fileInput && fileInput.files && fileInput.files[0] && fileInput.files[0].name) {
    fileName = fileInput.files[0].name.replace(/\.[^/.]+$/, "") + "_errors.xlsx";
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fileName = (schema === "person" ? "person" : "claim") + "_errors_" + ts + ".xlsx";
  }
  try {
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Errors");
    XLSX.writeFile(wb, fileName);
  } catch (err) {
    console.error("Export failed:", err);
    alert("Export failed. See console for details.");
  }
}
