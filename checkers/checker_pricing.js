let xmlData, xlsxData;

document.getElementById("xmlFile").addEventListener("change", e => {
  const reader = new FileReader();
  reader.onload = evt => xmlData = new DOMParser().parseFromString(evt.target.result, "text/xml");
  reader.readAsText(e.target.files[0]);
});

document.getElementById("xlsxFile").addEventListener("change", e => {
  const reader = new FileReader();
  reader.onload = evt => {
    const workbook = XLSX.read(new Uint8Array(evt.target.result), { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    xlsxData = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  };
  reader.readAsArrayBuffer(e.target.files[0]);
});

document.getElementById("processBtn").addEventListener("click", () => {
  if (!xmlData || !xlsxData) return alert("Upload both XML and XLSX first.");
  const results = [];
  const activities = xmlData.getElementsByTagName("Activity");
  for (let act of activities) {
    const code = act.getElementsByTagName("ActivityCode")[0]?.textContent || "";
    const net = parseFloat(act.getElementsByTagName("Net")[0]?.textContent || "0");
    const qty = parseFloat(act.getElementsByTagName("Quantity")[0]?.textContent || "1");
    const xlsxMatch = xlsxData.find(r => String(r["Code"]) === code);
    let status = "Invalid", remark = "No matching code found";
    if (xlsxMatch) {
      const xPrice = parseFloat(xlsxMatch["Net Price"] || "0");
      if (xPrice === net) { status = "Valid"; remark = "Exact price match"; }
      else if (qty > 0 && (net / qty) === xPrice) { status = "Valid"; remark = "Unit price matches"; }
      else { status = "Invalid"; remark = `Mismatch: XML Net ${net}, XLSX Price ${xPrice}`; }
    }
    results.push({ code, net, qty, status, remark, xlsxPrice: xlsxMatch?.["Net Price"] || "N/A" });
  }
  renderResults(results);
});

function renderResults(results) {
  const tbody = document.querySelector("#resultsTable tbody");
  tbody.innerHTML = "";
  results.forEach((r, i) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${r.code}</td>
      <td>${r.net}</td>
      <td>${r.qty}</td>
      <td class="${r.status.toLowerCase()}">${r.status}</td>
      <td>${r.remark}</td>
      <td><button onclick="showModal(${i})">View</button></td>
    `;
    tbody.appendChild(row);
  });
  window.comparisonResults = results;
}

function showModal(index) {
  const r = window.comparisonResults[index];
  document.getElementById("modalBody").innerHTML = `
    <div style="display:flex;justify-content:space-between">
      <div><h3>XML</h3><p>Code: ${r.code}</p><p>Net: ${r.net}</p><p>Quantity: ${r.qty}</p></div>
      <div><h3>XLSX</h3><p>Code: ${r.code}</p><p>Net Price: ${r.xlsxPrice}</p></div>
    </div>
  `;
  document.getElementById("modal").style.display = "block";
}

function closeModal() { document.getElementById("modal").style.display = "none"; }
