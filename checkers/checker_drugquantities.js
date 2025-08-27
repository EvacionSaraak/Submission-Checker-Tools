document.getElementById('processBtn').addEventListener('click', function() {
    const xlsxInput = document.getElementById('xlsxFile').files[0];
    const xmlInput = document.getElementById('xmlFile').files[0];

    if (!xmlInput || !xlsxInput) {
        alert('Please upload both XML and XLSX files.');
        return;
    }

    const readerXLSX = new FileReader();
    readerXLSX.onload = function(e) {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, {type: 'array'});
        const sheetName = workbook.SheetNames.find(name => name.trim().toLowerCase() === "drugs");
        if (!sheetName) {
            document.getElementById('results').innerHTML = "<p style='color:red'>No 'Drugs' sheet found in XLSX file.</p>";
            document.getElementById('exportErrorsBtn').disabled = true;
            return;
        }
        const worksheet = workbook.Sheets[sheetName];
        const drugsArr = XLSX.utils.sheet_to_json(worksheet, {defval: ""});
        const drugsMap = {};
        drugsArr.forEach(row => {
            if (row['Drug Code']) {
                drugsMap[String(row['Drug Code']).trim()] = row;
            }
        });

        const readerXML = new FileReader();
        readerXML.onload = function(e2) {
            const xmlText = e2.target.result;
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, "application/xml");
            if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
                document.getElementById('results').innerHTML = "<p style='color:red'>Error parsing XML file.</p>";
                document.getElementById('exportErrorsBtn').disabled = true;
                return;
            }

            let claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
            claims.sort((a, b) => {
                const idA = a.getElementsByTagName('ID')[0]?.textContent || '';
                const idB = b.getElementsByTagName('ID')[0]?.textContent || '';
                if (!isNaN(idA) && !isNaN(idB)) {
                    return Number(idA) - Number(idB);
                }
                return idA.localeCompare(idB);
            });

            let outputRows = [];
            claims.forEach(claim => {
                const claimId = claim.getElementsByTagName('ID')[0]?.textContent || '';
                const activities = Array.from(claim.getElementsByTagName('Activity'));
                activities.forEach(activity => {
                    const code = activity.getElementsByTagName('Code')[0]?.textContent?.trim() || '';
                    if (!drugsMap[code]) return;
                    const quantity = activity.getElementsByTagName('Quantity')[0]?.textContent || '';
                    const drug = drugsMap[code];
                    const packageName = drug['Package Name'] || '';
                    const packagePrice = parseFloat(drug['Package Price to Public']) || 0;
                    const unitPrice = parseFloat(drug['Unit Price to Public']) || 0;
                    let unitPerPackage = "";
                    let quantityPerPackage = "";
                    if (packagePrice > 0 && unitPrice > 0) {
                        unitPerPackage = (packagePrice / unitPrice).toFixed(2);
                        quantityPerPackage = (1 / (packagePrice / unitPrice)).toFixed(2);
                    }
                    let errors = [];
                    const type = activity.getElementsByTagName('Type')[0]?.textContent || '';
                    if (type !== "5") {
                        errors.push("Activity type is not 5");
                    }
                    // Only check for mismatch if both are non-empty
                    if (
                        quantity !== "" && quantityPerPackage !== "" &&
                        Number(quantity).toFixed(2) !== Number(quantityPerPackage).toFixed(2)
                    ) {
                        errors.push("Quantity does not match quantity per package");
                    }
                    outputRows.push({
                        claimId,
                        code,
                        quantity,
                        packageName,
                        packagePrice,
                        unitPrice,
                        unitPerPackage,
                        quantityPerPackage,
                        error: errors.join("; ")
                    });
                });
            });

            outputRows.sort((a, b) => {
                if (!isNaN(a.claimId) && !isNaN(b.claimId)) {
                    return Number(a.claimId) - Number(b.claimId);
                }
                return String(a.claimId).localeCompare(String(b.claimId));
            });

            // --- Enable/Disable Export Button depending on errors ---
            const hasErrors = outputRows.some(row => row.error && row.error.trim() !== "");
            document.getElementById('exportErrorsBtn').disabled = !hasErrors;

            // --- Store for export ---
            window._drugQuantityOutputRows = outputRows; // For export button handler

            let table = `<table class="shared-table">
                <thead>
                    <tr>
                        <th>Claim ID</th>
                        <th>Drug Code</th>
                        <th>XML Quantity</th>
                        <th class="wrap-col">Package Name</th>
                        <th>Package Price to Public</th>
                        <th>Unit Price to Public</th>
                        <th>Unit per Package</th>
                        <th>Correct Quantity</th>
                        <th class="description-col">Error Remark</th>
                    </tr>
                </thead>
                <tbody>`;
            let lastClaimId = null;
            outputRows.forEach(row => {
                const rowClass = row.error ? 'invalid' : 'valid';
                table += `<tr class="${rowClass}">
                    <td>${row.claimId === lastClaimId ? "" : row.claimId}</td>
                    <td>${row.code}</td>
                    <td>${row.quantity}</td>
                    <td class="wrap-col">${row.packageName}</td>
                    <td>${row.packagePrice !== "" ? row.packagePrice : ""}</td>
                    <td>${row.unitPrice !== "" ? row.unitPrice : ""}</td>
                    <td>${row.unitPerPackage}</td>
                    <td>${row.quantityPerPackage}</td>
                    <td class="description-col">${row.error}</td>
                </tr>`;
                lastClaimId = row.claimId;
            });
            table += "</tbody></table>";

            document.getElementById('results').innerHTML = table;
        };
        readerXML.readAsText(xmlInput);
    };
    readerXLSX.readAsArrayBuffer(xlsxInput);
});

// --- Export Errors Button Handler ---
document.getElementById('exportErrorsBtn').addEventListener('click', function() {
    const outputRows = window._drugQuantityOutputRows || [];
    // Filter to only rows with errors
    const errorRows = outputRows.filter(row => row.error && row.error.trim() !== "");
    if (errorRows.length === 0) {
        alert("There are no errors to export.");
        return;
    }

    // Define the header and data order to match table columns
    const header = [
        "Claim ID",
        "Drug Code",
        "XML Quantity",
        "Package Name",
        "Package Price to Public",
        "Unit Price to Public",
        "Unit per Package",
        "Correct Quantity",
        "Error Remark"
    ];

    // Map data to array of arrays
    const data = errorRows.map(row => [
        row.claimId,
        row.code,
        row.quantity,
        row.packageName,
        row.packagePrice,
        row.unitPrice,
        row.unitPerPackage,
        row.quantityPerPackage,
        row.error
    ]);

    // Combine header and data
    const exportArr = [header, ...data];

    // Create worksheet and workbook
    const ws = XLSX.utils.aoa_to_sheet(exportArr);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Errors");
    XLSX.writeFile(wb, "DrugQuantityErrors.xlsx");
});
