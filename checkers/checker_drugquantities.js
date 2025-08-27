let _drugsLookupMap = null, _drugQuantityOutputRows = [];
function updateCheckSingleCodeBtnState() {
    const drugsLoaded = !!_drugsLookupMap, codePresent = !!document.getElementById('singleDrugCodeInput').value.trim();
    document.getElementById('checkSingleCodeBtn').disabled = !(drugsLoaded && codePresent);
}
function enableSingleCodeChecker(drugsMap) {
    _drugsLookupMap = drugsMap; updateCheckSingleCodeBtnState();
}
document.getElementById('singleDrugCodeInput').addEventListener('input', updateCheckSingleCodeBtnState);
document.getElementById('singleDrugCodeInput').addEventListener('paste', ()=>setTimeout(updateCheckSingleCodeBtnState,0));
document.getElementById('processBtn').addEventListener('click', function() {
    const xlsxInput = document.getElementById('xlsxFile').files[0], xmlInput = document.getElementById('xmlFile').files[0];
    if (!xmlInput || !xlsxInput) return alert('Please upload both XML and XLSX files.');
    const readerXLSX = new FileReader();
    readerXLSX.onload = function(e) {
        const data = new Uint8Array(e.target.result), workbook = XLSX.read(data, {type: 'array'});
        const sheetName = workbook.SheetNames.find(n=>n.trim().toLowerCase()==="drugs");
        if (!sheetName) {
            document.getElementById('results').innerHTML = "<p style='color:red'>No 'Drugs' sheet found in XLSX file.</p>";
            document.getElementById('exportErrorsBtn').disabled = true; enableSingleCodeChecker({}); return;
        }
        const worksheet = workbook.Sheets[sheetName], drugsArr = XLSX.utils.sheet_to_json(worksheet, {defval:""}), drugsMap = {};
        drugsArr.forEach(r=>{if(r['Drug Code']) drugsMap[String(r['Drug Code']).trim()] = r;});
        enableSingleCodeChecker(drugsMap);
        const readerXML = new FileReader();
        readerXML.onload = function(e2) {
            const xmlText = e2.target.result, parser = new DOMParser(), xmlDoc = parser.parseFromString(xmlText, "application/xml");
            if (xmlDoc.getElementsByTagName('parsererror').length>0) {
                document.getElementById('results').innerHTML = "<p style='color:red'>Error parsing XML file.</p>";
                document.getElementById('exportErrorsBtn').disabled = true; return;
            }
            let claims = Array.from(xmlDoc.getElementsByTagName('Claim'));
            claims.sort((a,b)=>{
                const idA=a.getElementsByTagName('ID')[0]?.textContent||'', idB=b.getElementsByTagName('ID')[0]?.textContent||'';
                if (!isNaN(idA)&&!isNaN(idB)) return Number(idA)-Number(idB);
                return idA.localeCompare(idB);
            });
            let outputRows = [];
            claims.forEach(claim=>{
                const claimId = claim.getElementsByTagName('ID')[0]?.textContent||'';
                Array.from(claim.getElementsByTagName('Activity')).forEach(act=>{
                    const code = act.getElementsByTagName('Code')[0]?.textContent?.trim()||'';
                    if(!drugsMap[code]) return;
                    const quantity = act.getElementsByTagName('Quantity')[0]?.textContent||'', drug = drugsMap[code];
                    const packageName=drug['Package Name']||'', packagePrice=parseFloat(drug['Package Price to Public'])||0, unitPrice=parseFloat(drug['Unit Price to Public'])||0;
                    let unitPerPackage="", correctQuantity="";
                    if(packagePrice>0&&unitPrice>0){unitPerPackage=(packagePrice/unitPrice).toFixed(2);correctQuantity=(1/(packagePrice/unitPrice)).toFixed(2);}
                    let errors=[], type=act.getElementsByTagName('Type')[0]?.textContent||'';
                    if(type!=="5") errors.push("Activity type is not 5");
                    if(quantity!==""&&correctQuantity!==""&&Number(quantity).toFixed(2)!==Number(correctQuantity).toFixed(2)) errors.push("XML quantity does not match correct quantity");
                    outputRows.push({claimId,code,xmlQuantity:quantity,packageName,packagePrice,unitPrice,unitPerPackage,correctQuantity,error:errors.join("; ")});
                });
            });
            outputRows.sort((a,b)=>{
                if(!isNaN(a.claimId)&&!isNaN(b.claimId)) return Number(a.claimId)-Number(b.claimId);
                return String(a.claimId).localeCompare(String(b.claimId));
            });
            document.getElementById('exportErrorsBtn').disabled = !outputRows.some(r=>r.error&&r.error.trim()!=="");
            _drugQuantityOutputRows = outputRows;
            let table = `<table class="shared-table"><thead><tr>
                <th>Claim ID</th><th>Drug Code</th><th>XML Quantity</th><th class="wrap-col">Package Name</th>
                <th>Package Price to Public</th><th>Unit Price to Public</th><th>Unit per Package</th>
                <th>Correct Quantity</th><th class="description-col">Error Remark</th>
                </tr></thead><tbody>`;
            let lastClaimId = null;
            outputRows.forEach(row=>{
                const rowClass=row.error?'invalid':'valid';
                table+=`<tr class="${rowClass}">
                    <td>${row.claimId===lastClaimId?"":row.claimId}</td>
                    <td>${row.code}</td><td>${row.xmlQuantity}</td><td class="wrap-col">${row.packageName}</td>
                    <td>${row.packagePrice!==""?row.packagePrice:""}</td><td>${row.unitPrice!==""?row.unitPrice:""}</td>
                    <td>${row.unitPerPackage}</td><td>${row.correctQuantity}</td><td class="description-col">${row.error}</td>
                </tr>`;lastClaimId=row.claimId;
            });
            table+="</tbody></table>";
            document.getElementById('results').innerHTML=table;
        };
        readerXML.readAsText(xmlInput);
    };
    readerXLSX.readAsArrayBuffer(xlsxInput);
});
document.getElementById('exportErrorsBtn').addEventListener('click', function() {
    const errorRows = (_drugQuantityOutputRows||[]).filter(r=>r.error&&r.error.trim()!=="");
    if(errorRows.length===0) return alert("There are no errors to export.");
    const header=["Claim ID","Drug Code","XML Quantity","Package Name","Package Price to Public","Unit Price to Public","Unit per Package","Correct Quantity","Error Remark"];
    const data = errorRows.map(r=>[r.claimId,r.code,r.xmlQuantity,r.packageName,r.packagePrice,r.unitPrice,r.unitPerPackage,r.correctQuantity,r.error]);
    const ws = XLSX.utils.aoa_to_sheet([header,...data]), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Errors"); XLSX.writeFile(wb, "DrugQuantityErrors.xlsx");
});
document.getElementById('checkSingleCodeBtn').addEventListener('click', function() {
    const code = document.getElementById('singleDrugCodeInput').value.trim(), outDiv = document.getElementById('singleCodeResults'), statusDiv = document.getElementById('singleCodeStatus');
    if(!_drugsLookupMap){statusDiv.innerHTML="<span style='color:red'>Please upload the Drugs Excel file first.</span>";outDiv.innerHTML="";return;}
    if(!code){statusDiv.innerHTML="<span style='color:red'>Please enter a drug code.</span>";outDiv.innerHTML="";return;}
    const drug=_drugsLookupMap[code];
    if(!drug){statusDiv.innerHTML="<span style='color:red'>Drug code not found in uploaded file.</span>";outDiv.innerHTML="";return;}
    statusDiv.innerHTML="";
    const packageName=drug['Package Name']||'', packagePrice=parseFloat(drug['Package Price to Public'])||0, unitPrice=parseFloat(drug['Unit Price to Public'])||0;
    let unitPerPackage="", correctQuantity="";
    if(packagePrice>0&&unitPrice>0){unitPerPackage=(packagePrice/unitPrice).toFixed(2);correctQuantity=(1/(packagePrice/unitPrice)).toFixed(2);}
    let table = `<table class="shared-table"><thead><tr>
        <th>Drug Code</th><th class="wrap-col">Package Name</th><th>Package Price to Public</th>
        <th>Unit Price to Public</th><th>Unit per Package</th><th>Correct Quantity</th>
        </tr></thead><tbody>
        <tr><td>${code}</td><td class="wrap-col">${packageName}</td><td>${packagePrice||""}</td>
        <td>${unitPrice||""}</td><td>${unitPerPackage}</td><td>${correctQuantity}</td></tr>
        </tbody></table>`;
    outDiv.innerHTML=table;
});
