// diagnosis_checker.js

function parseClaimsAndCheckDiagnoses(xmlString) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlString, "text/xml");
  const claims = xml.querySelectorAll("Claim");
  const output = [];

  claims.forEach(claim => {
    const claimID = claim.querySelector("ID")?.textContent || "Unknown";
    const outputRow = {
      claimID,
      remarks: []
    };

    const principalDiagnoses = claim.querySelectorAll("PrincipalDiagnosis");
    const count = principalDiagnoses.length;

    if (count === 0) {
      outputRow.remarks.push("❌ No PrincipalDiagnosis in claim");
    } else if (count > 1) {
      outputRow.remarks.push(`❌ Multiple PrincipalDiagnoses found (${count})`);
    }

    output.push(outputRow);
  });

  return output;
}

function renderResults(results, tableId) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = "";

  results.forEach(row => {
    const tr = document.createElement("tr");
    const tdID = document.createElement("td");
    tdID.textContent = row.claimID;

    const tdRemarks = document.createElement("td");
    tdRemarks.textContent = row.remarks.join("; ") || "✅ 1 PrincipalDiagnosis";

    tr.appendChild(tdID);
    tr.appendChild(tdRemarks);
    tbody.appendChild(tr);
  });
}

function exportTable(tableId, filename) {
  const rows = Array.from(document.querySelectorAll(`#${tableId} tr`));
  const csv = rows.map(row =>
    Array.from(row.children)
      .map(cell => `"${cell.textContent.replace(/"/g, '""')}"`)
      .join(",")
  ).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function handleFileUpload(event, tableId) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const xmlText = e.target.result;
    const results = parseClaimsAndCheckDiagnoses(xmlText);
    renderResults(results, tableId);
  };
  reader.readAsText(file);
}
