(function() {
  try {
    // checker_schema.js with modal table view and Person schema support
    // Requires SheetJS for Excel export: 
    // <script src="https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js"></script>

    // Error message constants
    const AMPERSAND_REPLACEMENT_ERROR = "Please replace `&` in the observations to `and` because this will cause error.";

function validateXmlSchema() {
  const status = document.getElementById("uploadStatus");
  const resultsDiv = document.getElementById("results");
  
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
    return null;
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const originalXmlContent = e.target.result;
        
        // Replace unescaped & with "and" (but preserve valid XML entities like &amp; &lt; &gt; &quot; &apos;)
        const xmlContent = originalXmlContent.replace(/&(?!(amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;))/g, "and");
        
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlContent, "application/xml");
        const parseErrors = xmlDoc.getElementsByTagName("parsererror");
        if (parseErrors.length > 0) {
          console.log('[SCHEMA] XML parsing error detected');
          if (status) status.textContent = "XML Parsing Error: The file is not well-formed.";
          const errorDiv = document.createElement('pre');
          errorDiv.textContent = parseErrors[0].textContent;
          resolve(errorDiv);
          return;
        }

        // Detect schema type
        let results = [];
        let schemaType = "";
        if (xmlDoc.documentElement.nodeName === "Claim.Submission") {
          schemaType = "claim";
          console.log('[SCHEMA] Validating Claim schema');
          results = validateClaimSchema(xmlDoc, originalXmlContent);
          console.log('[SCHEMA] Claim validation complete, results count:', results.length);
        } else if (xmlDoc.documentElement.nodeName === "Person.Register") {
          schemaType = "person";
          console.log('[SCHEMA] Validating Person schema');
          results = validatePersonSchema(xmlDoc, originalXmlContent);
          console.log('[SCHEMA] Person validation complete, results count:', results.length);
        } else {
          console.log('[SCHEMA] Unknown schema type:', xmlDoc.documentElement.nodeName);
          if (status) status.textContent = "Unknown schema: " + xmlDoc.documentElement.nodeName;
          resolve(null);
          return;
        }
        
        console.log('[SCHEMA] Rendering results table...');
        const tableElement = renderResults(results, schemaType);
        console.log('[SCHEMA] Table element created:', tableElement ? 'success' : 'failed');

        // Stats
        const total = results.length;
        const valid = results.filter(r => r.Valid).length;
        const percent = total > 0 ? ((valid / total) * 100).toFixed(1) : "0.0";
        if (status) status.textContent = `Valid ${schemaType === "claim" ? "claims" : "persons"}: ${valid} / ${total} (${percent}%)`;
        
        console.log('[SCHEMA] Resolving with table element');
        resolve(tableElement);
      } catch (error) {
        console.error('[SCHEMA] Error during validation:', error);
        if (status) status.textContent = "Error: " + error.message;
        resolve(null);
      }
    };
    reader.onerror = function () {
      console.error('[SCHEMA] FileReader error');
      if (status) status.textContent = "Error reading the file.";
      resolve(null);
    };
    reader.readAsText(file);
  });
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
 * then the claim must include at least one Diagnosis code matching K05.0x, K05.1x or K03.6x pattern.
 *
 * Pattern matching: Only the code before the decimal and the first digit after the decimal are checked.
 * Examples: K05.00, K05.01, K05.02 all match the K05.0x pattern
 *           K05.10, K05.11, K05.12 all match the K05.1x pattern
 *           K03.60, K03.61, K03.62 all match the K03.6x pattern
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
    // Required diagnosis patterns: code before decimal + first digit after decimal
    const requiredDiagnosisPatterns = [
      { pattern: "K05.0", displayCode: "K05.0" },
      { pattern: "K05.1", displayCode: "K05.1" },
      { pattern: "K03.6", displayCode: "K03.6" }
    ];

    /**
     * Helper function to check if a diagnosis code matches a pattern
     * @param {string} code - The diagnosis code to check (e.g., "K05.00", "K05.10", "K03.61")
     * @param {string} pattern - The pattern to match (e.g., "K05.0", "K05.1", "K03.6")
     * @returns {boolean} - True if the code matches the pattern
     */
    function matchesDiagnosisPattern(code, pattern) {
      // Check if code is long enough to match the pattern
      if (code.length < pattern.length) {
        return false;
      }
      // Compare the prefix: code before decimal + first digit after decimal
      return code.substring(0, pattern.length) === pattern;
    }

    // find special activity codes present in this claim
    const foundSpecialActivityCodes = Array.from(activities || [])
      .map(a => (getText("Code", a) || "").trim())
      .filter(c => c && specialActivityCodes.has(c));

    if (foundSpecialActivityCodes.length > 0) {
      // collect diagnosis codes (uppercased and normalized)
      const diagnosisCodes = Array.from(diagnoses || [])
        .map(d => (getText("Code", d) || "").toUpperCase().trim())
        .filter(c => c);

      // Check if at least one of the required patterns is present (OR logic)
      const hasAnyMatch = requiredDiagnosisPatterns.some(({ pattern }) => {
        return diagnosisCodes.some(code => matchesDiagnosisPattern(code, pattern));
      });

      if (!hasAnyMatch) {
        // None of the required patterns found
        const requiredCodes = requiredDiagnosisPatterns.map(p => p.displayCode).join(" or ");
        invalidFields.push(
          `Activity code(s) ${Array.from(new Set(foundSpecialActivityCodes)).join(" ")} require Diagnosis code(s): ${requiredCodes}`
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
          `Activity code(s) ${Array.from(new Set(foundImplantCodes)).join(" ")} require at least one Diagnosis code from: K08.1 or K08.4`
        );
      }
    }
  } catch (err) {
    console.error("Implant activity -> diagnosis check error:", err);
  }
}

/**
 * GT License validation for Ordering Clinician:
 * 
 * Background: GT licenses are for Physiotherapy/Occupational Therapy and are only 
 * supported at specific facilities.
 * 
 * Validation Rules:
 * 1. DENTAL cases with GT license → INVALID (GT licenses not applicable to dental)
 * 2. MEDICAL cases with GT license at supported facilities (WLDY, Al Yahar, TrueLife) 
 *    → INVALID (requires confirmation from coders/auditors)
 * 3. MEDICAL cases with GT license at other facilities 
 *    → INVALID (facility doesn't support Physio/Occupational Therapy)
 * 4. All other cases → continue processing normally
 *
 * Parameters:
 *  - activities: HTMLCollection/array of Activity elements for this claim
 *  - facilityID: The FacilityID from the Encounter element
 *  - getText: function(tag, parent) -> returns text content for tag within parent
 *  - invalidFields: array to append any validation messages to
 */
function checkGTLicenseValidation(activities, facilityID, getText, invalidFields) {
  try {
    // Facilities that support Physio/Occupational Therapy (GT licenses)
    const gtSupportedFacilities = new Set([
      "MF5339",  // Wldy Medical Center
      "MF5357",  // New Look Medical Center (Al Yahar Branch 3)
      "MF7003",  // True Life Primary Care Center
      "MF7231",  // True Life Primary Care Center (Al Wagan Branch 1)
      "PF4000"   // True Life Pharmacy
    ]);

    // Check each activity for GT license
    Array.from(activities || []).forEach((activity, index) => {
      const orderingClinician = (getText("OrderingClinician", activity) || "").trim().toUpperCase();
      const activityType = (getText("Type", activity) || "").trim();
      const activityCode = (getText("Code", activity) || "").trim();

      // Check if ordering clinician starts with "GT"
      if (orderingClinician.startsWith("GT")) {
        const isMedical = activityType === "3";
        const isDental = activityType === "6";
        const isSupportedFacility = gtSupportedFacilities.has((facilityID || "").trim());

        // DENTAL validation: GT licenses are not valid for dental cases
        if (isDental) {
          invalidFields.push(
            `Activity[${index}] Code ${activityCode}: Ordering Clinician ${orderingClinician} (GT license) is INVALID for DENTAL cases`
          );
        }
        // MEDICAL validation: Check facility support
        else if (isMedical) {
          // Supported facilities: Require confirmation from coders/auditors
          if (isSupportedFacility) {
            invalidFields.push(
              `Activity[${index}] Code ${activityCode}: Ordering Clinician ${orderingClinician} (GT license) requires confirmation from coders/auditors`
            );
          }
          // Unsupported facilities: Facility doesn't support Physio/Occupational Therapy
          else {
            invalidFields.push(
              `Activity[${index}] Code ${activityCode}: Ordering Clinician ${orderingClinician} (GT license) is INVALID - Facility does NOT support Physio or Occupational Therapy`
            );
          }
        }
      }
    });
  } catch (err) {
    console.error("GT license validation check error:", err);
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
      const eidDigits = eid.replace(/-/g, "");
      const isMedicalTourism = /^[129]+$/.test(eidDigits);
      const isNationalWithoutEID = /^0+$/.test(eidDigits);
      
      if (p.length !== 4) invalidFields.push(`EmiratesIDNumber '${eid}' (must have 4 parts separated by dashes)`);
      else {
        // Skip 784 validation for Medical Tourism and National without EID cases
        if (!isMedicalTourism && !isNationalWithoutEID && p[0] !== "784") invalidFields.push(`EmiratesIDNumber '${eid}' (first part must be 784)`);
        if (!/^\d{4}$/.test(p[1])) invalidFields.push(`EmiratesIDNumber '${eid}' (second part must be 4 digits for year)`);
        if (!/^\d{7}$/.test(p[2])) invalidFields.push(`EmiratesIDNumber '${eid}' (third part must be 7 digits)`);
        if (!/^\d{1}$/.test(p[3])) invalidFields.push(`EmiratesIDNumber '${eid}' (fourth part must be 1 digit)`);
      }
      
      if (isMedicalTourism) remarks.push("EmiratesIDNumber (Medical Tourism: all digits 1/2/9)");
      else if (isNationalWithoutEID) remarks.push("EmiratesIDNumber (National without EID: all digits 0)");
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

    // NEW CHECK: GT license validation for Ordering Clinician
    const facilityID = encounter ? text("FacilityID", encounter) : "";
    checkGTLicenseValidation(activities, facilityID, text, invalidFields);

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
    if (missingFields.length) {
      remarks.push("Missing: " + missingFields.join(", "));
    }
    if (invalidFields.length) {
      invalidFields.forEach(field => remarks.push(field));
    }
    !remarks.length && remarks.push("OK");

    results.push({
      ClaimID: text("ID") || "Unknown",
      Valid: !missingFields.length && !invalidFields.length,
      Remark: remarks.join("\n"),
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
      const eidDigits = eid.replace(/-/g, "");
      const isMedicalTourism = /^[129]+$/.test(eidDigits);
      const isNationalWithoutEID = /^0+$/.test(eidDigits);
      
      if (p.length !== 4) {
        invalidFields.push(`EmiratesIDNumber '${eid}' (must have 4 parts separated by dashes)`);
      } else {
        // Skip 784 validation for Medical Tourism and National without EID cases
        if (!isMedicalTourism && !isNationalWithoutEID && p[0] !== "784") invalidFields.push(`EmiratesIDNumber '${eid}' (first part must be 784)`);
        if (!/^\d{4}$/.test(p[1])) invalidFields.push(`EmiratesIDNumber '${eid}' (second part must be 4 digits for year)`);
        if (!/^\d{7}$/.test(p[2])) invalidFields.push(`EmiratesIDNumber '${eid}' (third part must be 7 digits)`);
        if (!/^\d{1}$/.test(p[3])) invalidFields.push(`EmiratesIDNumber '${eid}' (fourth part must be 1 digit)`);
      }
      
      if (isMedicalTourism) remarks.push("EmiratesIDNumber (Medical Tourism: all digits 1/2/9)");
      else if (isNationalWithoutEID) remarks.push("EmiratesIDNumber (National without EID: all digits 0)");
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
    if (missingFields.length) {
      remarks.push("Missing: " + missingFields.join(", "));
    }
    if (invalidFields.length) {
      invalidFields.forEach(field => remarks.push(field));
    }
    !remarks.length && remarks.push("OK");

    results.push({
      ClaimID: memberID,
      Valid: !missingFields.length && !invalidFields.length,
      Remark: remarks.join("\n"),
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
      <div id="modalContent" style="background:#fff;width:90%;max-width:1000px;max-height:95vh;overflow:auto;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:20px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,0.2);">
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

// renderResults - builds and RETURNS table element instead of inserting into DOM
function renderResults(results, schemaType) {
  // keep a global reference so export works even if scopes change
  const safeResults = Array.isArray(results) ? results.slice() : [];
  window._lastValidationResults = safeResults;
  window._lastValidationSchema = schemaType || "claim";

  const idLabel = schemaType === "person" ? "Member ID" : "Claim ID";
  
  // Create table element
  const table = document.createElement('table');
  table.className = 'table table-striped table-bordered';
  table.style.borderCollapse = 'collapse';
  table.style.width = '100%';
  
  // Build table using innerHTML for consistency with other checkers (teeth, elig, auths)
  const tableHTML = `
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
    </tbody>`;
  
  table.innerHTML = tableHTML;
  
  // Attach event listeners to view buttons
  safeResults.forEach((row, index) => {
    const btn = table.querySelector(`.view-claim-btn[data-index="${index}"]`);
    if (btn) {
      btn.onclick = () => showModal(claimToHtmlTable(row.ClaimXML));
    }
  });
  
  return table;
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

    // Expose functions globally for unified checker and modal functionality
    window.validateXmlSchema = validateXmlSchema;
    window.showModal = showModal;
    window.hideModal = hideModal;
    window.claimToHtmlTable = claimToHtmlTable;
    window.ensureModal = ensureModal;

  } catch (error) {
    console.error('[CHECKER-ERROR] Failed to load checker:', error);
    console.error(error.stack);
  }
})();
