// checker_auths.js

let authRules = {};
let authRulesPromise = null;

/**
 * Load and index checker_auths.json into authRules map (cached)
 */
function loadAuthRules(url = "checker_auths.json") {
  if (!authRulesPromise) {
    authRulesPromise = fetch(url)
      .then(res => { if (!res.ok) throw new Error(`Failed to load ${url}`); return res.json(); })
      .then(data => {
        authRules = data.reduce((map, entry) => {
          map[entry.code] = entry;
          return map;
        }, {});
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const doc = new DOMParser().parseFromString(e.target.result, "application/xml");
      const err = doc.querySelector("parsererror");
      err ? reject("Invalid XML file") : resolve(doc);
    };
    reader.onerror = () => reject("Failed to read XML file");
    reader.readAsText(file);
  });
}

/**
 * Parse XLSX file and return JSON of HCPRequests sheet
 */
function parseXLSXFile(file) {
  return new Promise((resolve, reject) => {
    // [ADDED]: Check if XLSX library is loaded
    if (typeof XLSX === "undefined") {
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
        resolve(json);
      } catch {
        reject("Invalid XLSX file");
      }
    };
    reader.onerror = () => reject("Failed to read XLSX file");
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Build map of XLSX data keyed by AuthorizationID
 */
function mapXLSXData(rows) {
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
    return remarks;
  }
  const needsAuth = !/NOT\s+REQUIRED/i.test(rule.approval_details || "");
  if (needsAuth && !authID) remarks.push("Missing required AuthorizationID");
  if (!needsAuth && authID) remarks.push("AuthorizationID provided but not required");
  return remarks;
}

/**
 * Validation: exact match of activity fields against XLSX data
 */
function validateXLSXMatch(row, fields) {
  const remarks = [];
  // [MODIFIED]: Coerce both XLSX and XML values to trimmed strings for comparison
  const safeStr = val => (val === undefined || val === null) ? "" : String(val).trim();
  const { memberId, code, quantity, netTotal, ordering, authID } = fields;
  if (safeStr(row["Card Number / DHA Member ID"]) !== safeStr(memberId)) remarks.push(`MemberID mismatch: XLSX=${safeStr(row["Card Number / DHA Member ID"])}`);
  if (safeStr(row["Item Code"]) !== safeStr(code)) remarks.push(`Item Code mismatch: XLSX=${safeStr(row["Item Code"])}`);
  if (safeStr(row["Item Amount"]) !== safeStr(quantity)) remarks.push(`Quantity mismatch: XLSX=${safeStr(row["Item Amount"])}`);
  if (safeStr(row["Payer Share"]) !== safeStr(netTotal)) remarks.push(`Payer Share mismatch: XLSX=${safeStr(row["Payer Share"])}`);
  if (safeStr(row["Ordering Clinician"]) !== safeStr(ordering)) remarks.push(`Ordering Clinician mismatch: XLSX=${safeStr(row["Ordering Clinician"])}`);
  if (safeStr(row.AuthorizationID) !== safeStr(authID)) remarks.push(`AuthorizationID mismatch: XLSX=${safeStr(row.AuthorizationID)}`);
  return remarks;
}

/**
 * Validation: date and status checks
 */
function validateDateAndStatus(row, start) {
  const remarks = [];
  // [MODIFIED]: Robust date parsing and comparison
  let xlsDate = row["Ordered On"];
  if (!(xlsDate instanceof Date)) {
    xlsDate = new Date(xlsDate);
  }
  const xmlDate = new Date(start);
  if (!(xlsDate instanceof Date) || isNaN(xlsDate)) remarks.push("Invalid XLSX Ordered On date");
  if (!(xmlDate instanceof Date) || isNaN(xmlDate)) remarks.push("Invalid XML Start date");
  // [MODIFIED]: Only flag if xlsDate is strictly after xmlDate
  if (xlsDate > xmlDate) remarks.push("Ordered On date must be before or equal to Activity Start date");
  const status = (row.status || "").toLowerCase();
  if (!status.includes("approved")) {
    if (status.includes("rejected")) {
      remarks.push(`Rejected: Code=${row["Denial Code (if any)"] || 'N/A'} Reason=${row["Denial Reason (if any)"] || 'N/A'}`);
    } else {
      remarks.push("Status not approved");
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
    } else {
      xlsRow = rows.find(r => (r.AuthorizationID || "") === authID && (r["Item Code"] || "") === code);
      if (!xlsRow) {
        remarks.push("No matching row for code/AuthID in XLSX");
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

  for (const claim of claims) {
    const claimId = getText(claim, "ID");
    const memberId = getText(claim, "MemberID");
    const activities = Array.from(claim.getElementsByTagName("Activity"));
    for (const act of activities) {
      const res = validateActivity(act, xlsxMap, memberId);
      results.push({ claimId, memberId, ...res });
    }
  }
  return results;
}

/**
 * Render the results table with all fields for manual review
 */
function renderResults(results) {
  // [MODIFIED]: Ensure container exists
  const container = document.getElementById("results");
  if (!container) return; // [ADDED]: Guard against missing element
  container.innerHTML = "";
  if (!results.length) {
    container.textContent = "✅ No activities to validate.";
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
}

/**
 * Show a basic loading indicator
 * [ADDED]: New function for user feedback during async processing
 */
function setLoading(isLoading) {
  const resultsDiv = document.getElementById("results");
  if (!resultsDiv) return;
  if (isLoading) {
    resultsDiv.innerHTML = '<span style="font-style:italic">Processing, please wait...</span>';
  } else {
    resultsDiv.innerHTML = '';
  }
}

/**
 * Main entry: handle Run button click
 */
async function handleRun() {
  // [MODIFIED]: Check for required DOM elements
  const xmlInput = document.getElementById("xmlInput");
  const xlsxInput = document.getElementById("xlsxInput");
  const resultsDiv = document.getElementById("results");
  if (!xmlInput || !xlsxInput || !resultsDiv) {
    alert("Required input elements are missing in the HTML.");
    return;
  }

  const xmlFile = xmlInput.files[0];
  const xlsxFile = xlsxInput.files[0];

  if (!xmlFile || !xlsxFile) {
    resultsDiv.textContent = "Please upload both XML and XLSX files.";
    return;
  }

  setLoading(true); // [ADDED]: Show loading indicator

  try {
    await loadAuthRules();
    const [xmlDoc, xlsxData] = await Promise.all([
      parseXMLFile(xmlFile),
      parseXLSXFile(xlsxFile)
    ]);
    const results = validateClaims(xmlDoc, xlsxData);
    renderResults(results);
  } catch (err) {
    resultsDiv.textContent = `Error: ${err}`;
  } finally {
    setLoading(false); // [ADDED]: Hide loading indicator
  }
}

// [MODIFIED]: Prevent double event listener registration
(function attachHandler() {
  const runButton = document.getElementById("runButton");
  if (runButton && !runButton._checkerAttached) {
    runButton.addEventListener("click", handleRun);
    runButton._checkerAttached = true; // [ADDED]: Custom property to flag listener
  }
})();
