function parseXML() {
  const fileInput = document.getElementById("xmlFile");
  const resultsDiv = document.getElementById("results");

  if (!fileInput || !resultsDiv) {
    console.error("Missing required DOM elements.");
    return;
  }

  if (!fileInput.files.length) {
    resultsDiv.innerHTML = "<p>Please upload an XML file.</p>";
    return;
  }

  // Valid tooth code groups
  const anteriorTeeth = new Set(['6','7','8','9','10','11','22','23','24','25','26','27']);
  const premolarTeeth = new Set(['4','5','12','13','20','21','28','29']);
  const posteriorTeeth = new Set(['1','2','3','14','15','16','17','18','19','30','31','32']);

  // Activity code -> allowed region
  const codeRegionMap = {
    anterior: new Set(['23111','23112','23113','23114','23115','23101','23102','23103','23104','23105']),
    premolar: new Set(['23311','23312','23313','23314','23315','23211','23212','23213','23214','23215']),
    posterior: new Set(['23321','23322','23323','23324','23325','23221','23222','23223','23224','23225']),
  };

  const reader = new FileReader();
  reader.onload = function () {
    const parser = new DOMParser();
    const xml = parser.parseFromString(reader.result, "text/xml");
    const claims = xml.getElementsByTagName("Claim");

    let rows = [];

    for (let claim of claims) {
      const claimId = claim.getElementsByTagName("ID")[0]?.textContent || "(no claim ID)";
      const activities = claim.getElementsByTagName("Activity");

      for (let activity of activities) {
        const observations = activity.getElementsByTagName("Observation");
        if (observations.length > 0) {
          const activityId = activity.getElementsByTagName("ID")[0]?.textContent || "";
          const code = activity.getElementsByTagName("Code")[0]?.textContent.trim() || "";
          const net = activity.getElementsByTagName("Net")[0]?.textContent || "";

          let isValid = true;
          let remarks = [];

          const observationDetails = Array.from(observations).map(obs => {
            const type = obs.getElementsByTagName("Type")[0]?.textContent || "";
            const obsCode = obs.getElementsByTagName("Code")[0]?.textContent?.trim() || "";

            let reason = "";

            // Only check if it's a digit (assume permanent dentition for these cases)
            if (/^\d+$/.test(obsCode)) {
              const region = codeRegionMap.anterior.has(code)
                ? 'anterior'
                : codeRegionMap.premolar.has(code)
                ? 'premolar'
                : codeRegionMap.posterior.has(code)
                ? 'posterior'
                : null;

              const inRegion =
                region === 'anterior' && anteriorTeeth.has(obsCode) ||
                region === 'premolar' && premolarTeeth.has(obsCode) ||
                region === 'posterior' && posteriorTeeth.has(obsCode);

              if (!inRegion && region !== null) {
                isValid = false;
                reason = `Tooth ${obsCode} not valid for ${region} code ${code}`;
                remarks.push(reason);
              }
            }

            return `${type}: ${obsCode}`;
          }).join("<br>");

          const rowClass = isValid ? "valid" : "invalid";
          const remarkText = remarks.length > 0 ? remarks.join("; ") : "All valid";

          rows.push(`<tr class="${rowClass}">
            <td>${claimId}</td>
            <td>${activityId}</td>
            <td>${code}</td>
            <td>${net}</td>
            <td>${observationDetails}</td>
            <td>${remarkText}</td>
          </tr>`);
        }
      }
    }

    if (rows.length === 0) {
      resultsDiv.innerHTML = "<p>No activities with observations found.</p>";
    } else {
      resultsDiv.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Claim ID</th>
              <th>Activity ID</th>
              <th>Code</th>
              <th>Net Amount</th>
              <th>Observations</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            ${rows.join("\n")}
          </tbody>
        </table>
      `;
    }
  };

  reader.readAsText(fileInput.files[0]);
}
