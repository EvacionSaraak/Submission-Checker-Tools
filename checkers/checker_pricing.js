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

// modified: process button handler
document.getElementById("processBtn").addEventListener("click", () => {
  if (!xmlData || !xlsxData) return alert("Upload both XML and XLSX first.");
  const results = []; const activities = xmlData.getElementsByTagName("Activity");
  for (let act of activities) {
    const code = act.getElementsByTagName("ActivityCode")[0]?.textContent?.trim() || '';
    const net = parseFloat(act.getElementsByTagName("Net")[0]?.textContent || "0");
    const qty = parseFloat(act.getElementsByTagName("Quantity")[0]?.textContent || "0");
    const xlsxMatch = xlsxData.find(r => String(r["Code"]||r["CPT"]||'').trim() === code);
    let status = "Invalid", remark = "No matching code found";
    if (qty <= 0) status = "Invalid", remark = qty === 0 ? "Quantity is 0 (invalid)" : "Quantity is less than 0 (invalid)";
    else if (xlsxMatch) {
      const xPrice = parseFloat(String(xlsxMatch["Net Price"]||xlsxMatch["NetPrice"]||"0"));
      if (Number.isNaN(xPrice)) status = "Invalid", remark = "Reference Net Price is not a number";
      else if (xPrice === net) status = "Valid", remark = "Exact price match";
      else if ((net / qty) === xPrice) status = "Valid", remark = "Unit price matches";
      else status = "Invalid", remark = `Mismatch: XML Net ${net}, XLSX Price ${xPrice}`;
    }
    results.push({ code, net, qty, status, remark, xlsxPrice: xlsxMatch?.["Net Price"]||xlsxMatch?.["NetPrice"]||"N/A" });
  }
  renderResults(results);
  window.comparisonResults = results;
});

function renderResults(results) {
  const container = document.getElementById("outputTableContainer");
  if (!results.length) return container.innerHTML = "<p>No results.</p>";

  let html = `<table class="results-table">
    <thead>
      <tr>
        <th>Activity Code</th>
        <th>XML Net</th>
        <th>Quantity</th>
        <th>XLSX Net Price</th>
        <th>Status</th>
        <th>Remark</th>
        <th>Compare</th>
      </tr>
    </thead><tbody>`;

  for (const r of results) {
    const rowClass = r.status === "Valid" ? "valid" : "invalid";
    html += `<tr class="${rowClass}">
      <td>${r.code}</td>
      <td>${r.net}</td>
      <td>${r.qty}</td>
      <td>${r.xlsxPrice}</td>
      <td>${r.status}</td>
      <td>${r.remark}</td>
      <td><button onclick="showComparisonModal('${r.code}', '${r.net}', '${r.qty}', '${r.xlsxPrice}')">View</button></td>
    </tr>`;
  }

  html += "</tbody></table>";
  container.innerHTML = html;
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
