// checker_auths.js

// Globals to store the uploaded data
let xmlData = null;
let xlsxSheet2 = null;
let licensesJson = null;
let authsJson = null;

// Event listener for Process button
document.getElementById("processBtn").addEventListener("click", async () => {
  const xmlFile = document.getElementById("xmlFile").files[0];
  const xlsxFile = document.getElementById("xlsxFile").files[0];

  if (!xmlFile || !xlsxFile) {
    alert("Please upload both XML and XLSX files.");
    return;
  }

  // Load JSON files
  [licensesJson, authsJson] = await Promise.all([
    fetch('insurance_licenses.json'),
    fetch('checker_auths.json')
  ]);

  // Parse XML and XLSX
  const xmlText = await xmlFile.text();
  const parser = new DOMParser();
  xmlData = parser.parseFromString(xmlText, "application/xml");

  const workbook = await readXlsxFile(xlsxFile);
  xlsxSheet2 = workbook.Sheets[workbook.SheetNames[1]];

  const xlsxJson = XLSX.utils.sheet_to_json(xlsxSheet2);
  const results = processClaims(xmlData, xlsxJson);

  displayResults(results);
});

// Read XLSX with SheetJS
async function readXlsxFile(file) {
  const data = await file.arrayBuffer();
  return XLSX.read(data, { type: "array" });
}

function processClaims(xml, xlsxData) {
  const claims = Array.from(xml.getElementsByTagName("Claim"));
  const header = xml.getElementsByTagName("Header")[0];
  const receiverID = header?.getElementsByTagName("ReceiverID")[0]?.textContent;

  return claims.map(claim => {
    const claimID = claim.getElementsByTagName("ID")[0]?.textContent;
    const payerID = claim.getElementsByTagName("PayerID")[0]?.textContent;
    const memberID = claim.getElementsByTagName("MemberID")[0]?.textContent;
    const emiratesID = claim.getElementsByTagName("EmiratesIDNumber")[0]?.textContent;
    const activities = Array.from(claim.getElementsByTagName("Activity"));
    const contract = claim.getElementsByTagName("Contract")[0];
    const packageName = contract?.getElementsByTagName("PackageName")[0]?.textContent || "";

    const remarks = [];
    const license = licensesJson.licenses.find(l =>
      l.PayerID === payerID &&
      l.ReceiverID === receiverID &&
      packageName.includes(l.Plan)
    );
    if (!license) remarks.push("Invalid PayerID/ReceiverID/Plan match.");

    if (!validateEmiratesID(emiratesID)) remarks.push("Invalid Emirates ID format.");

    const actResults = activities.map(act => {
      const id = act.getElementsByTagName("ID")[0]?.textContent;
      const type = act.getElementsByTagName("Type")[0]?.textContent;
      const code = act.getElementsByTagName("Code")[0]?.textContent;
      const start = act.getElementsByTagName("Start")[0]?.textContent;
      const priorAuthID = act.getElementsByTagName("PriorAuthorizationID")[0]?.textContent || "";
      const orderingClinician = act.getElementsByTagName("OrderingClinician")[0]?.textContent;
      const clinician = act.getElementsByTagName("Clinician")[0]?.textContent;

      if (type !== "6") remarks.push(`Activity ${id}: Type is not 6.`);

      if (authsJson[code] && !priorAuthID)
        remarks.push(`Activity ${id}: Missing prior auth ID for code ${code}.`);

      if (payerID !== "E001" && priorAuthID.length !== 20)
        remarks.push(`Activity ${id}: Thiqa code must be 20 chars.`);

      if (payerID !== "A001" && (!/^[0-9]{9}$/.test(priorAuthID)))
        remarks.push(`Activity ${id}: Daman code must be 9 digits.`);

      const xlsxAuth = xlsxData.find(row => row["AuthorizationID"] == priorAuthID);
      if (!xlsxAuth) {
        remarks.push(`Activity ${id}: Authorization ID not found in XLSX.`);
      } else {
        if (xlsxAuth["Ordering Clinician"] !== orderingClinician)
          remarks.push(`Activity ${id}: Ordering Clinician mismatch.`);

        if (xlsxAuth["Performing Clinician"] !== clinician)
          remarks.push(`Activity ${id}: Performing Clinician mismatch.`);

        const codesForAuth = xlsxData.filter(r => r["AuthorizationID"] === priorAuthID).map(r => r["Item Code"]);
        if (!codesForAuth.includes(code))
          remarks.push(`Activity ${id}: Code ${code} not found in XLSX for this Auth.`);

        const orderedOn = new Date(xlsxAuth["Ordered On"]);
        const startDate = new Date(start);
        if (orderedOn >= startDate)
          remarks.push(`Activity ${id}: Ordered On is not earlier than Start.`);
      }

      return {
        ID: id,
        Start: start,
        Type: type,
        Code: code,
        PriorAuthorizationID: priorAuthID
      };
    });

    return {
      "Claim ID": claimID,
      "Member ID": memberID,
      "Payer ID": payerID,
      Activity: actResults,
      Remarks: remarks
    };
  });
}

function validateEmiratesID(id) {
  if (!id || typeof id !== "string") return false;
  const parts = id.split("-");
  return parts.length === 4 &&
         parts[0].length === 3 &&
         parts[1].length === 4 &&
         parts[2].length === 7 &&
         parts[3].length === 1;
}

function displayResults(data) {
  const container = document.getElementById("resultsTable");
  container.innerHTML = "";

  const table = document.createElement("table");
  const header = document.createElement("tr");
  ["Claim ID", "Member ID", "Payer ID", "Activity", "Remarks"].forEach(col => {
    const th = document.createElement("th");
    th.textContent = col;
    header.appendChild(th);
  });
  table.appendChild(header);

  data.forEach(row => {
    const tr = document.createElement("tr");
    [row["Claim ID"], row["Member ID"], row["Payer ID"]].forEach(text => {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    });

    const actTd = document.createElement("td");
    actTd.innerHTML = row.Activity.map(a =>
      `ID: ${a.ID}<br>Start: ${a.Start}<br>Type: ${a.Type}<br>Code: ${a.Code}<br>PriorAuthID: ${a.PriorAuthorizationID}<br><br>`
    ).join("");
    tr.appendChild(actTd);

    const remarksTd = document.createElement("td");
    remarksTd.innerHTML = row.Remarks.map(r => `- ${r}<br>`).join("");
    tr.appendChild(remarksTd);

    table.appendChild(tr);
  });

  container.appendChild(table);
}
