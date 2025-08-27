// --- Globals to share state between handlers ---
let _drugsLookupMap = null; // for single code lookup
let _drugQuantityOutputRows = []; // for export

// --- Enable single code checker when drugsMap is ready ---
function enableSingleCodeChecker(drugsMap) {
    _drugsLookupMap = drugsMap;
    document.getElementById('checkSingleCodeBtn').disabled = false;
}

// --- Handle process button ---
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
            enableSingleCodeChecker({});
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

        // Enable single code checker now that the map is ready
        enableSingleCodeChecker(drugsMap);

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
                    let correctQuantity = "";
                    if (packagePrice > 0 && unitPrice > 0) {
                        unitPerPackage = (packagePrice / unitPrice).toFixed(2);
                        correctQuantity = (1 / (packagePrice / unitPrice)).toFixed(2);
                    }
                    let errors = [];
                    const type = activity.getElementsByTagName('Type')[0]?.textContent || '';
                    if (type !== "5") {
                        errors.push("Activity type is not 5");
                    }
                    // Only check for mismatch if both are non-empty
                    if (
                        quantity !== "" && correctQuantity !== "" &&
                        Number(quantity).toFixed(2) !== Number(correctQuantity).toFixed(2)
                    ) {
                        errors.push("XML quantity does not match correct quantity");
                    }
                    outputRows.push({
                        claimId,
                        code,
                        xmlQuantity: quantity,
                        packageName,
                        packagePrice,
                        unitPrice,
                        unitPerPackage,
                        correctQuantity,
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
            _drugQuantityOutputRows = outputRows; // For export button handler

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
                    <td>${row.xmlQuantity}</td>
                    <td class="wrap-col">${row.packageName}</td>
                    <td>${row.packagePrice !== "" ? row.packagePrice : ""}</td>
                    <td>${row.unitPrice !== "" ? row.unitPrice : ""}</td>
                    <td>${row.unitPerPackage}</td>
                    <td>${row.correctQuantity}</td>
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
    const outputRows = _drugQuantityOutputRows || [];
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
        row.xmlQuantity,
        row.packageName,
        row.packagePrice,
        row.unitPrice,
        row.unitPerPackage,
        row.correctQuantity,
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

// --- Single code lookup logic ---
document.getElementById('checkSingleCodeBtn').addEventListener('click', function() {
    const code = document.getElementById('singleDrugCodeInput').value.trim();
    const outDiv = document.getElementById('singleCodeResults');
    const statusDiv = document.getElementById('singleCodeStatus');
    if (!_drugsLookupMap) {
        statusDiv.innerHTML = "<span style='color:red'>Please upload the Drugs Excel file first.</span>";
        outDiv.innerHTML = "";
        return;
    }
    if (!code) {
        statusDiv.innerHTML = "<span style='color:red'>Please enter a drug code.</span>";
        outDiv.innerHTML = "";
        return;
    }
    const drug = _drugsLookupMap[code];
    if (!drug) {
        statusDiv.innerHTML = "<span style='color:red'>Drug code not found in uploaded file.</span>";
        outDiv.innerHTML = "";
        return;
    }
    statusDiv.innerHTML = "";
    const packageName = drug['Package Name'] || '';
    const packagePrice = parseFloat(drug['Package Price to Public']) || 0;
    const unitPrice = parseFloat(drug['Unit Price to Public']) || 0;
    let unitPerPackage = "";
    let correctQuantity = "";
    if (packagePrice > 0 && unitPrice > 0) {
        unitPerPackage = (packagePrice / unitPrice).toFixed(2);
        correctQuantity = (1 / (packagePrice / unitPrice)).toFixed(2);
    }
    let table = `<table class="shared-table">
        <thead>
            <tr>
                <th>Drug Code</th>
                <th class="wrap-col">Package Name</th>
                <th>Package Price to Public</th>
                <th>Unit Price to Public</th>
                <th>Unit per Package</th>
                <th>Correct Quantity</th>
            </tr>
        </thead>
        <tbody>
            <tr>
                <td>${code}</td>
                <td class="wrap-col">${packageName}</td>
                <td>${packagePrice || ""}</td>
                <td>${unitPrice || ""}</td>
                <td>${unitPerPackage}</td>
                <td>${correctQuantity}</td>
            </tr>
        </tbody>
    </table>`;
    outDiv.innerHTML = table;
});

// Enable the check button only after XLSX is loaded
document.getElementById('singleDrugCodeInput').addEventListener('input', function() {
    document.getElementById('checkSingleCodeBtn').disabled = !_drugsLookupMap;
});
