function parseXML() {
  const xmlInput = document.getElementById("xmlFile");
  const jsonInput = document.getElementById("jsonFile");
  const resultsDiv = document.getElementById("results");

  const ANTERIOR_TEETH = new Set(['6','7','8','9','10','11','22','23','24','25','26','27']);
  const BICUSPID_TEETH = new Set(['4','5','12','13','20','21','28','29']);
  const POSTERIOR_TEETH = new Set(['1','2','3','14','15','16','17','18','19','30','31','32']);


  if (!xmlInput || !jsonInput || !resultsDiv) {
    console.error("Missing required DOM elements.");
    return;
  }

  if (!xmlInput.files.length || !jsonInput.files.length) {
    resultsDiv.innerHTML = "<p>Please upload both XML and JSON files.</p>";
    return;
  }

  const xmlReader = new FileReader();
  const jsonReader = new FileReader();

  let xmlData = null;
  let jsonData = null;

  // When both files are loaded, process them
  function tryProcess() {
    if (!xmlData || !jsonData) return;

    let codeToTeethMap = {};

    try {
      const parsedJSON = JSON.parse(jsonData);
    
      for (const entry of parsedJSON) {
        let teethSet;
    
        switch (entry.affiliated_teeth.toLowerCase()) {
          case "all":
            teethSet = new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH, ...POSTERIOR_TEETH]);
            break;
          case "anteriors":
            teethSet = ANTERIOR_TEETH;
            break;
          case "posteriors":
            teethSet = POSTERIOR_TEETH;
            break;
          case "bicuspid":
            teethSet = BICUSPID_TEETH;
            break;
          case "anteriors/bicuspid":
            teethSet = new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH]);
            break;
          default:
            teethSet = new Set(); // fallback if unknown label
        }
        for (const code of entry.codes) {
          codeToTeethMap[code.trim()] = teethSet;
        }
      }
    } catch (err) {
      console.error("Error parsing JSON:", err);
      resultsDiv.innerHTML = "<p>Invalid JSON file.</p>";
      return;
    }

    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlData, "text/xml");
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

          const allowedTeeth = codeToTeethMap[code] || null;

          const observationDetails = Array.from(observations).map(obs => {
            const type = obs.getElementsByTagName("Type")[0]?.textContent || "";
            const obsCode = obs.getElementsByTagName("Code")[0]?.textContent?.trim() || "";

            if (/^\d+$/.test(obsCode) && allowedTeeth) {
              if (!allowedTeeth.has(obsCode)) {
                isValid = false;
                remarks.push(`Tooth ${obsCode} not valid for code ${code}`);
              }
            }

            return `${type}: ${obsCode}`;
          }).join("<br>");

          const rowClass = isValid ? "valid" : "invalid";
          const remarkText = remarks.length > 0 ? remarks.join("<br>") : "All valid";
          
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

    resultsDiv.innerHTML = rows.length === 0
      ? "<p>No activities with observations found.</p>"
      : `
        <table border="1">
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

  // Read XML
  xmlReader.onload = () => {
    xmlData = xmlReader.result;
    tryProcess();
  };

  // Read JSON
  jsonReader.onload = () => {
    jsonData = jsonReader.result;
    tryProcess();
  };

  xmlReader.readAsText(xmlInput.files[0]);
  jsonReader.readAsText(jsonInput.files[0]);
}
