// checker_schema.js with modal table view and Person schema support
// Requires SheetJS for Excel export: 
// <script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script>

// Error message constants
const AMPERSAND_REPLACEMENT_ERROR = "Please replace `&` in the observations to `and` because this will cause error.";

function validateXmlSchema() {
  const status = document.getElementById("uploadStatus");
  const resultsDiv = document.getElementById("results");
  
  if (resultsDiv) resultsDiv.innerHTML = "";
  if (status) status.textContent = "";

  const fileInput = document.getElementById("xmlFile");
  let file = fileInput?.files?.[0];
  
  // Fallback to unified checker files cache
  if (!file && window.unifiedCheckerFiles && window.unifiedCheckerFiles.xml) {
    file = window.unifiedCheckerFiles.xml;
    console.log('[SCHEMA] Using XML file from unified cache:', file.name);
  }
  
  if (!file) {
    if (status) status.textContent = "Please select an XML file first.";
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    const originalXmlContent = e.target.result;
    
    // Replace unescaped & with "and" (but preserve valid XML entities like &amp; &lt; &gt; &quot; &apos;)
    const xmlContent = originalXmlContent.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g, "and");
    
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
      results = validateClaimSchema(xmlDoc, originalXmlContent);
    } else if (xmlDoc.documentElement.nodeName === "Person.Register") {
      schemaType = "person";
      results = validatePersonSchema(xmlDoc, originalXmlContent);
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
    const val = (el.textContent || "").trim().toLowerCase();
    if (!el.children.length && val === "false" && el.nodeName !== "MiddleNameEn") {
      invalidFields.push(
        `The element ${
          (prefix ? `${prefix} → ${el.nodeName}` : el.nodeName)
            .replace(/^Claim(?:[.\s→]*)/, "")
            .replace(/^Person(?:[.\s→]*)/, "")
        } has an invalid value 'false'.`
      );
    }
    if (el.children.length) checkForFalseValues(el, invalidFields, prefix ? `${prefix} → ${el.nodeName}` : el.nodeName);
  }
}

/**
 * Supplemental check extracted to its own function:
 * If any Activity Code is one of the special dental codes (11111, 11119, 11101, 11109)
 * then the claim must include Diagnosis code(s) K05.10 and K03.6.
 *
 * Parameters:
 *  - activities: HTMLCollection/array of Activity elements for this claim
 *  - diagnoses: HTMLCollection/array of Diagnosis elements for this claim
 *  - getText: function(tag, parent) -> returns text content for tag within parent (same signature used in validateClaimSchema)
 *  - invalidFields: array to append any validation messages to
 *
 * The function catches and logs exceptions so it doesn't break the main validation flow.
 */
function checkSpecialActivityDiagnosis(activities, diagnoses, getText, invalidFields) {
  try {
    const specialActivityCodes = new Set(["11111", "11119", "11101", "11109"]);
    const requiredDiagnosisCodes = new Set(["K05.10", "K03.6"]);

    // find special activity codes present in this claim
    const foundSpecialActivityCodes = Array.from(activities || [])
      .map(a => (getText("Code", a) || "").trim())
      .filter(c => c && specialActivityCodes.has(c));

    if (foundSpecialActivityCodes.length > 0) {
      // collect diagnosis codes (uppercased)
      const diagCodesSet = new Set(
        Array.from(diagnoses || []).map(d => (getText("Code", d) || "").toUpperCase())
      );

      // determine which required diagnosis codes are missing
      const missingRequiredDiag = Array.from(requiredDiagnosisCodes).filter(req => !diagCodesSet.has(req));

      if (missingRequiredDiag.length > 0) {
        invalidFields.push(
          `Activity code(s) ${Array.from(new Set(foundSpecialActivityCodes)).join(", ")} require Diagnosis code(s): ${missingRequiredDiag.join(", ")}`
        );
      }
    }
  } catch (err) {
    // Do not break validation on unexpected errors in this supplemental check
    console.error("Special activity -> diagnosis check error:", err);
  }
}

/**
 * New supplemental validation:
 * If any Activity Code matches implant codes (79931, 79932, 79933, 79934)
 * then the claim MUST include at least one diagnosis code matching K08.1xx or K08.4xx patterns.
 *
 * The diagnosis comparison is case-insensitive and ignores dots, so K08.131 and K08131 both match.
 * Pattern matching: K081xx (K08.1 followed by any two digits) or K084xx (K08.4 followed by any two digits)
 */
function checkImplantActivityDiagnosis(activities, diagnoses, getText, invalidFields) {
  try {
    const implantActivityCodes = new Set(["79931", "79932", "79933", "79934"]);
    
    const foundImplantCodes = Array.from(activities || [])
      .map(a => (getText("Code", a) || "").trim())
      .filter(c => c && implantActivityCodes.has(c));

    if (foundImplantCodes.length > 0) {
      // Get all diagnosis codes present in claim (normalized: remove dots, uppercase)
      const diagnosisCodes = Array.from(diagnoses || [])
        .map(d => (getText("Code", d) || "").replace(/\./g, "").toUpperCase().trim())
        .filter(c => c);
      
      // Check if any diagnosis code matches K081xx or K084xx pattern
      // K081xx: starts with K081 followed by any two characters
      // K084xx: starts with K084 followed by any two characters
      const hasValidDiagnosis = diagnosisCodes.some(code => {
        return (code.startsWith("K081") && code.length >= 5) || 
               (code.startsWith("K084") && code.length >= 5);
      });

      if (!hasValidDiagnosis) {
        invalidFields.push(
          `Activity code(s) ${Array.from(new Set(foundImplantCodes)).join(", ")} require at least one Diagnosis code from: K08.1xx or K08.4xx`
        );
      }
    }
  } catch (err) {
    console.error("Implant activity -> diagnosis check error:", err);
  }
}

function validateClaimSchema(xmlDoc, originalXmlContent = "") {
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

    // Check if this specific claim had ampersands by comparing with original content
    const claimID = text("ID");
    let claimHadAmpersand = false;
    if (originalXmlContent && claimID) {
      // Find this claim in the original XML by locating its ID tag
      const idTag = `<ID>${claimID}</ID>`;
      const idPos = originalXmlContent.indexOf(idTag);
      
      if (idPos !== -1) {
        // Search backwards for the <Claim> or <Claim > tag (to avoid matching within text)
        let claimStartPos = originalXmlContent.lastIndexOf('<Claim>', idPos);
        if (claimStartPos === -1) {
          claimStartPos = originalXmlContent.lastIndexOf('<Claim ', idPos);
        }
        // Search forwards for the </Claim> tag
        const claimEndPos = originalXmlContent.indexOf('</Claim>', idPos);
        
        if (claimStartPos !== -1 && claimEndPos !== -1) {
          const originalClaimContent = originalXmlContent.substring(claimStartPos, claimEndPos + '</Claim>'.length);
          // Check if this specific claim had unescaped ampersands
          claimHadAmpersand = /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/.test(originalClaimContent);
        }
      }
    }

    // Required fields
    ["ID", "MemberID", "PayerID", "ProviderID", "EmiratesIDNumber", "Gross", "PatientShare", "Net"].forEach(tag => invalidIfNull(tag, claim));

    // MemberID check
    const memberID = text("MemberID");
    if (memberID && /^0/.test(memberID)) invalidFields.push("MemberID (starts with 0)");

    // EmiratesIDNumber checks (improved messages)
    if (present("EmiratesIDNumber")) {
      const eid = text("EmiratesIDNumber"), p = eid.split("-");
      if (p.length !== 4) invalidFields.push(`EmiratesIDNumber '${eid}' (must have 4 parts separated by dashes)`);
      else {
        if (p[0] !== "784") invalidFields.push(`EmiratesIDNumber '${eid}' (first part must be 784)`);
        if (!/^\d{4}$/.test(p[1])) invalidFields.push(`EmiratesIDNumber '${eid}' (second part must be 4 digits for year)`);
        if (!/^\d{7}$/.test(p[2])) invalidFields.push(`EmiratesIDNumber '${eid}' (third part must be 7 digits)`);
        if (!/^\d{1}$/.test(p[3])) invalidFields.push(`EmiratesIDNumber '${eid}' (fourth part must be 1 digit)`);
      }
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
      const prefix = `Activity[${i}].`, code = text("Code", act), qty = text("Quantity", act);
      ["Start","Type","Code","Quantity","Net","Clinician"].forEach(tag => invalidIfNull(tag, act, prefix));
      if (qty === "0") invalidFields.push(`Activity Code ${code || "(unknown)"} has invalid Quantity (0)`);
      Array.from(act.getElementsByTagName("Observation")).forEach((obs,j) => ["Type","Code"].forEach(tag => invalidIfNull(tag, obs, `${prefix}Observation[${j}].`)));
    });

    // NEW CHECK: use the extracted function for clarity/debugging
    checkSpecialActivityDiagnosis(activities, diagnoses, text, invalidFields);

    // NEW CHECK: implant-specific codes requiring certain diagnosis codes
    checkImplantActivityDiagnosis(activities, diagnoses, text, invalidFields);

    // Contract optional
    const contract = claim.getElementsByTagName("Contract")[0];
    contract && !text("PackageName", contract) ? invalidFields.push("Contract.PackageName (null/empty)") : null;

    // Check for false values
    checkForFalseValues(claim, invalidFields, "Claim.");

    // Mark claim as invalid if it had ampersands
    if (claimHadAmpersand) {
      invalidFields.push(AMPERSAND_REPLACEMENT_ERROR);
    }

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

function validatePersonSchema(xmlDoc, originalXmlContent = "") {
  const results = [];
  const persons = xmlDoc.getElementsByTagName("Person");
  for (const person of persons) {
    let missingFields = [], invalidFields = [], remarks = [];

    const present = (tag, parent = person) => parent.getElementsByTagName(tag).length > 0;
    const text = (tag, parent = person) => {
      const el = parent.getElementsByTagName(tag)[0];
      return el && el.textContent ? el.textContent.trim() : "";
    };
    const invalidIfNull = (tag, parent = person, prefix = "") => !text(tag, parent) ? invalidFields.push(prefix + tag + " (null/empty)") : null;

    // Check if this specific person had ampersands by comparing with original content
    const unifiedNumber = text("UnifiedNumber");
    let personHadAmpersand = false;
    if (originalXmlContent && unifiedNumber) {
      // Find this person in the original XML by locating its UnifiedNumber tag
      const unTag = `<UnifiedNumber>${unifiedNumber}</UnifiedNumber>`;
      const unPos = originalXmlContent.indexOf(unTag);
      
      if (unPos !== -1) {
        // Search backwards for the <Person> or <Person > tag (to avoid matching within text)
        let personStartPos = originalXmlContent.lastIndexOf('<Person>', unPos);
        if (personStartPos === -1) {
          personStartPos = originalXmlContent.lastIndexOf('<Person ', unPos);
        }
        // Search forwards for the </Person> tag
        const personEndPos = originalXmlContent.indexOf('</Person>', unPos);
        
        if (personStartPos !== -1 && personEndPos !== -1) {
          const originalPersonContent = originalXmlContent.substring(personStartPos, personEndPos + '</Person>'.length);
          // Check if this specific person had unescaped ampersands
          personHadAmpersand = /&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/.test(originalPersonContent);
        }
      }
    }

    [
      "UnifiedNumber", "FirstName", "FirstNameEn", "LastNameEn", "ContactNumber",
      "BirthDate", "Gender", "Nationality", "City", "CountryOfResidence", "EmirateOfResidence", "EmiratesIDNumber"
    ].forEach(tag => invalidIfNull(tag, person));

    // EmiratesIDNumber checks (detailed)
    if (present("EmiratesIDNumber")) {
      const eid = text("EmiratesIDNumber"), p = eid.split("-");
      if (p.length !== 4) {
        invalidFields.push(`EmiratesIDNumber '${eid}' (must have 4 parts separated by dashes)`);
      } else {
        if (p[0] !== "784") invalidFields.push(`EmiratesIDNumber '${eid}' (first part must be 784)`);
        if (!/^\d{4}$/.test(p[1])) invalidFields.push(`EmiratesIDNumber '${eid}' (second part must be 4 digits for year)`);
        if (!/^\d{7}$/.test(p[2])) invalidFields.push(`EmiratesIDNumber '${eid}' (third part must be 7 digits)`);
        if (!/^\d{1}$/.test(p[3])) invalidFields.push(`EmiratesIDNumber '${eid}' (fourth part must be 1 digit)`);
      }
      const eidDigits = eid.replace(/-/g, "");
      if (/^[129]+$/.test(eidDigits)) remarks.push("EmiratesIDNumber (Medical Tourism: all digits 1/2/9)");
      else if (/^0+$/.test(eidDigits)) remarks.push("EmiratesIDNumber (National without EID: all digits 0)");
    }

    // Member.ID check
    const member = person.getElementsByTagName("Member")[0];
    const memberID = member ? text("ID", member) : "Unknown";
    if (!member || !memberID) invalidFields.push("Member.ID (null/empty)");

    // False value check
    checkForFalseValues(person, invalidFields);

    // Mark person as invalid if it had ampersands
    if (personHadAmpersand) {
      invalidFields.push(AMPERSAND_REPLACEMENT_ERROR);
    }

    // Compile remarks
    missingFields.length && remarks.push("Missing: " + missingFields.join(", "));
    invalidFields.length && remarks.push("Invalid: " + invalidFields.join(", "));
    !remarks.length && remarks.push("OK");

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
      <div id="modalContent" style="background:#fff;max-width:900px;max-height:85vh;overflow:auto;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:20px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,0.2);">
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

// renderResults (stores last results on window - button removed for unified interface)
function renderResults(results, container, schemaType) {
  // keep a global reference so export works even if scopes change
  const safeResults = Array.isArray(results) ? results.slice() : [];
  window._lastValidationResults = safeResults;
  window._lastValidationSchema = schemaType || "claim";
  
  // Don't clear container here - validateXmlSchema() already cleared it at line 12
  // Clearing here would remove tables from OTHER checkers if schema runs after them
  
  // Export button removed - unified interface handles export

  const idLabel = schemaType === "person" ? "Member ID" : "Claim ID";
  
  // Build table using innerHTML for consistency with other checkers (teeth, elig, auths)
  const tableHTML = `
    <table class="table table-striped table-bordered" style="border-collapse:collapse;width:100%">
      <thead>
        <tr>
          <th style="padding:8px;border:1px solid #ccc">${idLabel}</th>
          <th style="padding:8px;border:1px solid #ccc">Remark</th>
          <th style="padding:8px;border:1px solid #ccc">Valid</th>
          <th style="padding:8px;border:1px solid #ccc">View Full Entry</th>
        </tr>
      </thead>
      <tbody>
        ${safeResults.map((row, index) => {
          // Use Bootstrap classes for consistent row coloring
          const rowClass = row.Valid ? 'table-success' : 'table-danger';
          return `
            <tr class="${rowClass}">
              <td style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.ClaimID)}</td>
              <td style="padding:6px;border:1px solid #ccc">${sanitizeForHTML(row.Remark)}</td>
              <td style="padding:6px;border:1px solid #ccc">${row.Valid ? "Yes" : "No"}</td>
              <td style="padding:6px;border:1px solid #ccc">
                <button class="view-claim-btn" data-index="${index}">View</button>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  
  container.innerHTML = tableHTML;
  
  // Attach event listeners to view buttons after DOM is updated
  safeResults.forEach((row, index) => {
    const btn = container.querySelector(`.view-claim-btn[data-index="${index}"]`);
    if (btn) {
      btn.onclick = () => showModal(claimToHtmlTable(row.ClaimXML));
    }
  });
}

// Helper function to sanitize text for HTML insertion
function sanitizeForHTML(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
