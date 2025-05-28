// checker_auths.js OH MAI GAHD

import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.0/package/xlsx.mjs";

const xmlInput = document.getElementById("xmlInput");
const xlsxInput = document.getElementById("xlsxInput");
const resultsContainer = document.getElementById("resultsContainer");

let insuranceLicenses = {};
let approvalCodes = {};
let licensesLoaded = false;
let codesLoaded = false;

// Display error message utility
function showError(message) {
  resultsContainer.innerHTML = `<div class="error-box">${message}</div>`;
}

fetch("insurance_licenses.json")
  .then((res) => res.json())
  .then((data) => {
    if (!data || !data.licenses || data.licenses.length === 0) {
      showError("Error: insurance_licenses.json is empty or invalid.");
    } else {
      insuranceLicenses = data;
      licensesLoaded = true;
    }
  })
  .catch(() => showError("Error: Failed to load insurance_licenses.json."));

fetch("checker_auths.json")
  .then((res) => res.json())
  .then((data) => {
    if (!data || Object.keys(data).length === 0) {
      showError("Error: checker_auths.json is empty or invalid.");
    } else {
      approvalCodes = data;
      codesLoaded = true;
    }
  })
  .catch(() => showError("Error: Failed to load checker_auths.json."));

function parseXML(xmlText) {
  const parser = new DOMParser();
  return parser.parseFromString(xmlText, "application/xml");
}

function getTextContent(el, tag) {
  const found = el.getElementsByTagName(tag)[0];
  return found ? found.textContent.trim() : "";
}

function validateEmiratesID(id) {
  const parts = id.split("-");
  return (
    parts.length === 4 &&
    parts[0].length === 3 &&
    parts[1].length === 4 &&
    parts[2].length === 7 &&
    parts[3].length === 1
  );
}

function validateAuthCode(code, payer) {
  if (payer === "E001") return code.length === 20;
  if (payer === "A001") return /^\d{9}$/.test(code);
  return false;
}

function parseXLSX(sheet) {
  const data = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const map = {};
  data.forEach((row) => {
    const authId = row["AuthorizationID"];
    if (!map[authId]) map[authId] = [];
    map[authId].push(row);
  });
  return map;
}

function validateClaim(claim, header, xlsxMap) {
  const claimID = getTextContent(claim, "ID");
  const memberID = getTextContent(claim, "MemberID");
  const payerID = getTextContent(claim, "PayerID");
  const receiverID = getTextContent(header, "ReceiverID");
  const emiratesID = getTextContent(claim, "EmiratesIDNumber");
  const contract = claim.getElementsByTagName("Contract")[0];
  const packageName = contract ? getTextContent(contract, "PackageName") : "";
  const diagnoses = claim.getElementsByTagName("Diagnosis");
  const remarks = [];

  if (/\s/.test(memberID)) remarks.push("Member ID contains whitespace");
  const validPackages = ["Thiqa 1", "Thiqa 2", "Daman", "NextCare", "NAS", "Mednet"];
  if (!validPackages.includes(packageName)) remarks.push(`Invalid Package Name: ${packageName}`);
  if (!validateEmiratesID(emiratesID)) remarks.push("Invalid Emirates ID format");

  const vat = parseFloat(getTextContent(claim, "VAT") || "0");
  const vatPerc = parseFloat(getTextContent(claim, "VATPercentage") || "0");
  const patientShare = parseFloat(getTextContent(claim, "PatientShare") || "0");
  if (packageName.includes("Thiqa")) {
    if (vat !== 0 || vatPerc !== 0) remarks.push("Thiqa claims must have 0 VAT and VAT Percentage");
    if (patientShare !== 0) remarks.push("Thiqa claims must have 0 Patient Share");
  } else {
    if (vat !== 0 || vatPerc !== 0) remarks.push("VAT and VAT Percentage must be 0");
  }

  const license = insuranceLicenses.licenses.find(
    (l) => l.PayerID === payerID && l.ReceiverID === receiverID && packageName.includes(l.Plan)
  );
  if (!license) remarks.push("Invalid payer/receiver/package match");

  const icdCodes = new Set();
  const duplicates = new Set();
  for (const diag of diagnoses) {
    const code = getTextContent(diag, "Code");
    if (icdCodes.has(code)) duplicates.add(code);
    icdCodes.add(code);
  }
  if (duplicates.size) remarks.push(`Duplicate ICD diagnosis code(s): ${[...duplicates].join(", ")}`);

  const activities = claim.getElementsByTagName("Activity");
  const activityData = [];

  for (const act of activities) {
    const id = getTextContent(act, "ID");
    const start = getTextContent(act, "Start");
    const type = getTextContent(act, "Type");
    const code = getTextContent(act, "Code");
    const authID = getTextContent(act, "PriorAuthorizationID");
    const orderingClinician = getTextContent(act, "OrderingClinician");
    const performingClinician = getTextContent(act, "Clinician");

    if (type !== "6") remarks.push(`Activity ID ${id}: Invalid type, must be 6`);
    if (approvalCodes[code] && !authID) remarks.push(`Activity ID ${id}: Missing prior authorization`);
    if (authID && !validateAuthCode(authID, payerID)) remarks.push(`Activity ID ${id}: Invalid auth code format`);

    const xlsxRows = xlsxMap[authID] || [];
    if (xlsxRows.length === 0) {
      remarks.push(`Activity ID ${id}: Authorization ID not found in XLSX`);
    } else {
      const codeMatch = xlsxRows.some((row) => row["Item Code"] === code);
      const orderedOnValid = xlsxRows.some((row) => new Date(row["Ordered On"]) <= new Date(start));
      const cliniciansMatch = xlsxRows.some(
        (row) =>
          row["Ordering Clinician"] === orderingClinician &&
          row["Performing Clinician"] === performingClinician
      );
      if (!codeMatch) remarks.push(`Activity ID ${id}: Code not in XLSX Item Code`);
      if (!orderedOnValid) remarks.push(`Activity ID ${id}: Ordered On date is after performing date`);
      if (!cliniciansMatch) remarks.push(`Activity ID ${id}: Ordering or Performing Clinician mismatch`);
    }

    activityData.push({ ID: id, Start: start, Type: type, Code: code, PriorAuthorizationID: authID });
  }

  return { ClaimID: claimID, MemberID: memberID, PayerID: payerID, Activity: activityData, Remarks: remarks };
}

function renderResults(results) {
  if (results.length === 0) {
    resultsContainer.innerHTML = `<div class="error-box">No claims found in the XML file.</div>`;
    return;
  }

  const table = document.createElement("table");
  table.classList.add("styled-table");

  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Claim ID</th>
      <th>Member ID</th>
      <th>Payer ID</th>
      <th>Activities</th>
      <th>Remarks</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  results.forEach((entry) => {
    const row = document.createElement("tr");
    const activityDetails = entry.Activity.map(
      (a) =>
        `ID: ${a.ID}<br>Start: ${a.Start}<br>Type: ${a.Type}<br>Code: ${a.Code}<br>Auth ID: ${a.PriorAuthorizationID}`
    ).join("<hr>");

    row.innerHTML = `
      <td>${entry.ClaimID}</td>
      <td>${entry.MemberID}</td>
      <td>${entry.PayerID}</td>
      <td>${activityDetails}</td>
      <td>${entry.Remarks.join("<br>")}</td>
    `;
    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  resultsContainer.innerHTML = "";
  resultsContainer.appendChild(table);
}

function handleFiles() {
  if (!licensesLoaded || !codesLoaded) {
    showError("JSON data not fully loaded. Please wait and try again.");
    return;
  }

  const xmlFile = xmlInput.files[0];
  const xlsxFile = xlsxInput.files[0];
  if (!xmlFile || !xlsxFile) {
    showError("Please upload both XML and XLSX files.");
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const xmlDoc = parseXML(e.target.result);
    const header = xmlDoc.getElementsByTagName("Header")[0];
    const claims = Array.from(xmlDoc.getElementsByTagName("Claim"));

    const xlsxReader = new FileReader();
    xlsxReader.onload = (e2) => {
      const workbook = XLSX.read(e2.target.result, { type: "binary" });
      const sheet2 = workbook.Sheets[workbook.SheetNames[1]];
      const xlsxMap = parseXLSX(sheet2);
      const results = claims.map((c) => validateClaim(c, header, xlsxMap));
      renderResults(results);
    };
    xlsxReader.readAsBinaryString(xlsxFile);
  };
  reader.readAsText(xmlFile);
}

document.getElementById("runButton").addEventListener("click", handleFiles);
