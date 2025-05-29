let authRules = {};
let authRulesPromise = null;

/**
 * Load and index checker_auths.json into authRules map (cached)
 */
function loadAuthRules(url = "checker_auths.json") {
  if (!authRulesPromise) {
    console.log("[AuthRules] Loading rules from:", url); // [LOG ADDED]
    authRulesPromise = fetch(url)
      .then(res => { 
        if (!res.ok) throw new Error(`Failed to load ${url}`); 
        return res.json(); 
      })
      .then(data => {
        authRules = data.reduce((map, entry) => {
          map[entry.code] = entry;
          return map;
        }, {});
        console.log("[AuthRules] Loaded rules:", authRules); // [LOG ADDED]
      })
      .catch(e => {
        console.error("[AuthRules] Error loading:", e); // [LOG ADDED]
        throw e;
      });
  }
  return authRulesPromise;
}

/**
 * Safe text getter for XML elements
 */
function getText(parent, tag) {
  const el = parent.querySelector(tag);
  return el && el.textContent ? el.textContent.trim() : "";
}

/**
 * Parse XML file into XML Document
 */
function parseXMLFile(file) {
  console.log("[XML] Starting to parse file:", file); // [LOG ADDED]
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const doc = new DOMParser().parseFromString(e.target.result, "application/xml");
      const err = doc.querySelector("parsererror");
      if (err) {
        console.error("[XML] Parser error:", err.textContent); // [LOG ADDED]
        reject("Invalid XML file");
      } else {
        console.log("[XML] Parsed successfully"); // [LOG ADDED]
        resolve(doc);
      }
    };
    reader.onerror = () => {
      console.error("[XML] FileReader error"); // [LOG ADDED]
      reject("Failed to read XML file");
    };
    reader.readAsText(file);
  });
}

/**
 * Parse XLSX file and return JSON of HCPRequests sheet
 */
function parseXLSXFile(file) {
  console.log("[XLSX] Starting to parse file:", file); // [LOG ADDED]
  return new Promise((resolve, reject) => {
    if (typeof XLSX === "undefined") {
      console.error("[XLSX] XLSX.js library not loaded!"); // [LOG ADDED]
      reject("XLSX library not loaded. Please include SheetJS (XLSX.js) in your HTML.");
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const sheetName = wb.SheetNames.includes("HCPRequests")
          ? "HCPRequests"
          : wb.SheetNames[1] || wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        console.log("[XLSX] Parsed sheet: ", sheetName, "Rows count:", json.length); // [LOG ADDED]
        resolve(json);
      } catch (e) {
        console.error("[XLSX] Exception during parse:", e); // [LOG ADDED]
        reject("Invalid XLSX file");
      }
    };
    reader.onerror = () => {
      console.error("[XLSX] FileReader error"); // [LOG ADDED]
      reject("Failed to read XLSX file");
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Build map of XLSX data keyed by AuthorizationID
 */
function mapXLSXData(rows) {
  console.log("[XLSX] Mapping data by AuthorizationID, input length:", rows.length); // [LOG ADDED]
  return rows.reduce((map, row) => {
    const id = row.AuthorizationID || "";
    map[id] = map[id] || [];
    map[id].push(row);
    return map;
  }, {});
}

/**
 * Validation: approval requirement based on JSON policy
 */
function validateApprovalRequirement(code, authID) {
  const remarks = [];
  const rule = authRules[code];
  if (!rule) {
    remarks.push("Code not found in checker_auths.json");
    console.warn("[Validation] Code not found in authRules:", code); // [LOG ADDED]
    return remarks;
  }
  const needsAuth = !/NOT\s+REQUIRED/i.test(rule.approval_details || "");
  if (needsAuth && !authID) { 
    remarks.push("Missing required AuthorizationID");
    console.log(`[Validation] Missing AuthorizationID for code ${code}`); // [LOG ADDED]
  }
  if (!needsAuth && authID) {
    remarks.push("AuthorizationID provided but not required");
    console.log(`[Validation] Unnecessary AuthorizationID for code ${code}`); // [LOG ADDED]
  }
  return remarks;
}

/**
 * Validation: exact match of activity fields against XLSX data
 */
function validateXLSXMatch(row, fields) {
  const remarks = [];
  const safeStr = val => (val === undefined || val === null) ? "" : String(val).trim();
  const { memberId, code, quantity, netTotal, ordering, authID } = fields;
  if (safeStr(row["Card Number / DHA Member ID"]) !== safeStr(memberId)) {
    remarks.push(`MemberID mismatch: XLSX=${safeStr(row["Card Number / DHA Member ID"])}`);
    console.log("[Validation] MemberID mismatch:", row["Card Number / DHA Member ID"], memberId); // [LOG ADDED]
  }
  if (safeStr(row["Item Code"]) !== safeStr(code)) {
    remarks.push(`Item Code mismatch: XLSX=${safeStr(row["Item Code"])}`);
    console.log("[Validation] Item Code mismatch:", row["Item Code"], code); // [LOG ADDED]
  }
  if (safeStr(row["Item Amount"]) !== safeStr(quantity)) {
    remarks.push(`Quantity mismatch: XLSX=${safeStr(row["Item Amount"])}`);
    console.log("[Validation] Quantity mismatch:", row["Item Amount"], quantity); // [LOG ADDED]
  }
  if (safeStr(row["Payer Share"]) !== safeStr(netTotal)) {
    remarks.push(`Payer Share mismatch: XLSX=${safeStr(row["Payer Share"])}`);
    console.log("[Validation] Payer Share mismatch:", row["Payer Share"], netTotal); // [LOG ADDED]
  }
  if (safeStr(row["Ordering Clinician"]) !== safeStr(ordering)) {
    remarks.push(`Ordering Clinician mismatch: XLSX=${safeStr(row["Ordering Clinician"])}`);
    console.log("[Validation] Ordering Clinician mismatch:", row["Ordering Clinician"], ordering); // [LOG ADDED]
  }
  if (safeStr(row.AuthorizationID) !== safeStr(authID)) {
    remarks.push(`AuthorizationID mismatch: XLSX=${safeStr(row.AuthorizationID)}`);
    console.log("[Validation] AuthorizationID mismatch:", row.AuthorizationID, authID); // [LOG ADDED]
  }
  return remarks;
}

/**
 * Validation: date and status checks
 */
function validateDateAndStatus(row, start) {
  const remarks = [];
  let xlsDate = row["Ordered On"];
  if (!(xlsDate instanceof Date)) {
    xlsDate = new Date(xlsDate);
  }
  const xmlDate = new Date(start);
  if (!(xlsDate instanceof Date) || isNaN(xlsDate)) {
    remarks.push("Invalid XLSX Ordered On date");
    console.log("[Validation] Invalid XLSX Ordered On date:", row["Ordered On"]); // [LOG ADDED]
  }
  if (!(xmlDate instanceof Date) || isNaN(xmlDate)) {
    remarks.push("Invalid XML Start date");
    console.log("[Validation] Invalid XML Start date:", start); // [LOG ADDED]
  }
  if (xlsDate > xmlDate) {
    remarks.push("Ordered On date must be before or equal to Activity Start date");
    console.log("[Validation] Date logic fail: XLSX", xlsDate, "XML", xmlDate); // [LOG ADDED]
  }
  const status = (row.status || "").toLowerCase();
  if (!status.includes("approved")) {
    if (status.includes("rejected")) {
      remarks.push(`Rejected: Code=${row["Denial Code (if any)"] || 'N/A'} Reason=${row["Denial Reason (if any)"] || 'N/A'}`);
      console.log("[Validation] Row rejected with code/reason:", row["Denial Code (if any)"], row["Denial Reason (if any)"]); // [LOG ADDED]
    } else {
      remarks.push("Status not approved");
      console.log("[Validation] Status not approved:", row.status); // [LOG ADDED]
    }
  }
  return remarks;
}

/**
 * Validate a single <Activity> element
 */
function validateActivity(activity, xlsxMap, memberId) {
  const id = getText(activity, "ID");
  const code = getText(activity, "Code");
  const start = getText(activity, "Start");
  const quantity = getText(activity, "Quantity");
  const netTotal = getText(activity, "NetTotal");
  const ordering = getText(activity, "OrderingClinician");
  const authID = getText(activity, "PriorAuthorizationID");

  let remarks = [];
  remarks = remarks.concat(validateApprovalRequirement(code, authID));

  let xlsRow = null;
  if (authID) {
    const rows = xlsxMap[authID] || [];
    if (!rows.length) {
      remarks.push(`AuthID ${authID} not in HCPRequests sheet`);
      console.log("[Validation] AuthID not found in XLSX:", authID); // [LOG ADDED]
    } else {
      xlsRow = rows.find(r => (r.AuthorizationID || "") === authID && (r["Item Code"] || "") === code);
      if (!xlsRow) {
        remarks.push("No matching row for code/AuthID in XLSX");
        console.log("[Validation] No matching row for code/AuthID:", authID, code); // [LOG ADDED]
      } else {
        const fields = { memberId, code, quantity, netTotal, ordering, authID };
        remarks = remarks.concat(validateXLSXMatch(xlsRow, fields));
        remarks = remarks.concat(validateDateAndStatus(xlsRow, start));
      }
    }
  }

  return { id, code, start, quantity, netTotal, ordering, authID, xlsRow, remarks };
}

/**
 * Iterate through all Claims and Activities
 */
function validateClaims(xmlDoc, xlsxData) {
  const results = [];
  const xlsxMap = mapXLSXData(xlsxData);
  const claims = Array.from(xmlDoc.getElementsByTagName("Claim"));
  console.log(`[Validation] Processing ${claims.length} claims...`); // [LOG ADDED]

  for (const claim of claims) {
    const claimId = getText(claim, "ID");
    const memberId = getText(claim, "MemberID");
    const activities = Array.from(claim.getElementsByTagName("Activity"));
    for (const act of activities) {
      const res = validateActivity(act, xlsxMap, memberId);
      results.push({ claimId, memberId, ...res });
    }
  }
  console.log("[Validation] Results array:", results); // [LOG ADDED]
  return results;
}

/**
 * Render the results table with all fields for manual review
 */
function renderResults(results) {
  const container = document.getElementById("results");
  if (!container) {
    console.error("[Render] 'results' div not found!"); // [LOG ADDED]
    return;
  }
  container.innerHTML = "";
  if (!results.length) {
    container.textContent = "✅ No activities to validate.";
    console.log("[Render] No activities to validate."); // [LOG ADDED]
    return;
  }

  const table = document.createElement("table");
  table.className = "styled-table";
  // header
  table.innerHTML = `
    <thead>
      <tr>
        <th>Claim ID</th>
        <th>Member ID</th>
        <th>Activity ID</th>
        <th>Code</th>
        <th>Quantity</th>
        <th>Net Total</th>
        <th>Ordering Clinician</th>
        <th>Auth ID</th>
        <th>Start Date</th>
        <th>Ordered On</th>
        <th>Status</th>
        <th>Denial Code</th>
        <th>Denial Reason</th>
        <th>Remarks</th>
      </tr>
    </thead>`;

  const tbody = document.createElement("tbody");
  let lastClaim = null;
  results.forEach(r => {
    const tr = document.createElement("tr");
    const claimCell = document.createElement("td");
    claimCell.textContent = r.claimId === lastClaim ? "" : r.claimId;
    lastClaim = r.claimId;
    tr.appendChild(claimCell);

    [r.memberId, r.id, r.code, r.quantity, r.netTotal, r.ordering, r.authID, r.start].forEach(val => {
      const td = document.createElement("td"); td.textContent = val || ""; tr.appendChild(td);
    });

    if (r.xlsRow) {
      [r.xlsRow["Ordered On"], r.xlsRow.status, r.xlsRow["Denial Code (if any)"], r.xlsRow["Denial Reason (if any)"]].forEach(val => {
        const td = document.createElement("td"); td.textContent = val || ""; tr.appendChild(td);
      });
    } else {
      ["", "", "", ""].forEach(() => { tr.appendChild(document.createElement("td")); });
    }

    const remarksTd = document.createElement("td");
    remarksTd.innerHTML = r.remarks.map(m => `<div>${m}</div>`).join("");
    tr.appendChild(remarksTd);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
  console.log("[Render] Table rendered, row count:", results.length); // [LOG ADDED]
}

/**
 * Show a basic loading indicator
 */
function setLoading(isLoading) {
  const resultsDiv = document.getElementById("results");
  if (!resultsDiv) {
    console.warn("[Loading] 'results' div not found!"); // [LOG ADDED]
    return;
  }
  if (isLoading) {
    resultsDiv.innerHTML = '<span style="font-style:italic">Processing, please wait...</span>';
    console.log("[Loading] Showing loading indicator."); // [LOG ADDED]
  } else {
    resultsDiv.innerHTML = '';
    console.log("[Loading] Hiding loading indicator."); // [LOG ADDED]
  }
}

/**
 * Show file summary counts in results div [ADDED]
 */
function showFileSummary(xmlClaimsCount, xlsxAuthCount) { // [ADDED]
  const resultsDiv = document.getElementById("results");
  if (!resultsDiv) return;
  resultsDiv.innerHTML = `
    <div>
      <strong>Claims loaded from XML:</strong> ${xmlClaimsCount}<br>
      <strong>Authorizations loaded from XLSX:</strong> ${xlsxAuthCount}
    </div>
  `;
}

// --- Attach file input listeners to show file summary counts [ADDED] ---
(function attachInputListeners() {
  const xmlInput = document.getElementById("xmlInput");
  const xlsxInput = document.getElementById("xlsxInput");
  if (!xmlInput || !xlsxInput) return;

  let xmlClaimsCount = 0, xlsxAuthCount = 0, xmlLoaded = false, xlsxLoaded = false, xmlDoc = null, xlsxData = null;

  async function updateSummary() {
    // Only show counts when both are loaded and valid
    if (xmlLoaded && xlsxLoaded && xmlClaimsCount !== null && xlsxAuthCount !== null) {
      showFileSummary(xmlClaimsCount, xlsxAuthCount);
    }
  }

  xmlInput.addEventListener("change", async e => {
    xmlLoaded = false;
    xmlClaimsCount = null;
    const file = xmlInput.files[0];
    if (file) {
      try {
        xmlDoc = await parseXMLFile(file);
        xmlClaimsCount = xmlDoc.getElementsByTagName("Claim").length;
        xmlLoaded = true;
      } catch {
        xmlLoaded = false;
        xmlClaimsCount = null;
      }
    }
    updateSummary();
  });

  xlsxInput.addEventListener("change", async e => {
    xlsxLoaded = false;
    xlsxAuthCount = null;
    const file = xlsxInput.files[0];
    if (file) {
      try {
        xlsxData = await parseXLSXFile(file);
        // Count unique AuthorizationID values
        const authSet = new Set(xlsxData.map(row => row.AuthorizationID).filter(Boolean));
        xlsxAuthCount = authSet.size;
        xlsxLoaded = true;
      } catch {
        xlsxLoaded = false;
        xlsxAuthCount = null;
      }
    }
    updateSummary();
  });
})();

/**
 * Main entry: handle Run button click
 */
async function handleRun() {
  const xmlInput = document.getElementById("xmlInput");
  const xlsxInput = document.getElementById("xlsxInput");
  const resultsDiv = document.getElementById("results");

  if (!xmlInput || !xlsxInput || !resultsDiv) {
    alert("Required input elements are missing in the HTML.");
    console.error("[Init] Missing input elements."); // [LOG ADDED]
    return;
  }

  const xmlFile = xmlInput.files[0];
  const xlsxFile = xlsxInput.files[0];

  if (!xmlFile || !xlsxFile) {
    resultsDiv.innerHTML = "Please upload both XML and XLSX files."; // [MODIFIED]
    console.warn("[Init] Missing one or both files."); // [LOG ADDED]
    return;
  }

  setLoading(true);

  try {
    await loadAuthRules();
    const [xmlDoc, xlsxData] = await Promise.all([
      parseXMLFile(xmlFile),
      parseXLSXFile(xlsxFile)
    ]);
    const results = validateClaims(xmlDoc, xlsxData);

    // [LOG ADDED] Output the results array before rendering
    console.log("[Main] Final results before render:", results);

    renderResults(results); // this will replace the summary with the table
  } catch (err) {
    resultsDiv.textContent = `Error: ${err}`;
    console.error("[Main] Exception caught:", err); // [LOG ADDED]
  } finally {
    setLoading(false);
  }
}

// Prevent double event listener registration
(function attachHandler() {
  const runButton = document.getElementById("runButton");
  if (runButton && !runButton._checkerAttached) {
    runButton.addEventListener("click", handleRun);
    runButton._checkerAttached = true;
    console.log("[Init] Run button handler attached."); // [LOG ADDED]
  } else {
    console.warn("[Init] Run button not found or handler already attached."); // [LOG ADDED]
  }
})();
