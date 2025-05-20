function parseXML() {
  const xmlInput = document.getElementById("xmlFile");
  const jsonInput = document.getElementById("jsonFile");
  const resultsDiv = document.getElementById("results");

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
        const teethSet = new Set();
        const category = entry.affiliated_teeth.toLowerCase();

        if (category === "all") {
          for (let i = 1; i <= 32; i++) teethSet.add(String(i));
        } else if (category === "anteriors") {
          ["6","7","8","9","10","11","22","23","24","25","26","27"].forEach(t => teethSet.add(t));
        } else if (category === "posteriors") {
          ["1","2","3","14","15","16","17","18","19","30","31","32"].forEach(t => teethSet.add(t));
        } else if (category === "anteriors/bicuspid") {
          ["4","5","6","7","8","9","10","11","12","13","20","21","22","23","24","25","26","27","28","29"].forEach(t => teethSet.add(t));
        }

        for (const code of entry.codes) {
          codeToTeethMap[code] = teethSet;
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
