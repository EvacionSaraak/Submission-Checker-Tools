// script.js
// -----------------------

function parseXML() {
  const xmlInput = document.getElementById("xmlFile");
  const jsonInput = document.getElementById("jsonFile");
  const resultsDiv = document.getElementById("results");

  // region definitions
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

  let xmlData = null;
  let jsonData = null;

  const xmlReader = new FileReader();
  const jsonReader = new FileReader();

  xmlReader.onload = () => {
    xmlData = xmlReader.result;
    tryProcess();
  };
  xmlReader.onerror = () => {
    console.error("Error reading XML file");
  };

  jsonReader.onload = () => {
    jsonData = jsonReader.result;
    tryProcess();
  };
  jsonReader.onerror = () => {
    console.error("Error reading JSON file");
  };

  xmlReader.readAsText(xmlInput.files[0]);
  jsonReader.readAsText(jsonInput.files[0]);

  function tryProcess() {
    if (!xmlData || !jsonData) return;

    // build code→teeth map
    let codeToTeethMap = {};
    try {
      const parsedJSON = JSON.parse(jsonData);
      for (const entry of parsedJSON) {
        let teethSet;
        switch ((entry.affiliated_teeth || "").toLowerCase()) {
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
            teethSet = new Set();
        }
        for (const rawCode of entry.codes || []) {
          const trimmed = rawCode.toString().trim();
          codeToTeethMap[trimmed] = teethSet;
        }
      }
    } catch (err) {
      console.error("Error parsing JSON:", err);
      resultsDiv.innerHTML = "<p>Invalid JSON file.</p>";
      return;
    }

    // parse XML & validate
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlData, "text/xml");
    const claims = xmlDoc.getElementsByTagName("Claim");
    let rows = [];

    for (let claim of claims) {
      const claimId = claim.querySelector("ID")?.textContent || "(no claim ID)";
      for (let activity of claim.getElementsByTagName("Activity")) {
        const obsList = activity.getElementsByTagName("Observation");
        if (obsList.length === 0) continue;

        const activityId = activity.querySelector("ID")?.textContent || "";
        const code = activity.querySelector("Code")?.textContent.trim() || "";
        const net = activity.querySelector("Net")?.textContent || "";

        let isValid = true;
        let remarks = [];
        const codeMeta = codeToTeethMap[code];
        const allowedTeeth = codeMeta?.teethSet || new Set();
        const description = codeMeta?.description || "(no description)";


        const observationDetails = Array.from(obsList).map(obs => {
          const type = obs.querySelector("Type")?.textContent || "";
          const obsCode = obs.querySelector("Code")?.textContent.trim() || "";
          if (/^\d+$/.test(obsCode)) {
            if (!allowedTeeth.has(obsCode)) {
              isValid = false;
              remarks.push(`Tooth ${obsCode} not valid for code ${code}`);
            }
          }
          return `${type}: ${obsCode}`;
        }).join("<br>");

        const rowClass = isValid ? "valid" : "invalid";
        const remarkText = remarks.length ? remarks.join("<br>") : "All valid";

        rows.push(`
          <tr class="${rowClass}">
            <td>${claimId}</td>
            <td>${activityId}</td>
            <td>${code}</td>
            <td>${description}</td>
            <td>${net}</td>
            <td>${observationDetails}</td>
            <td>${remarkText}</td>
          </tr>
        `);
      }
    }

    resultsDiv.innerHTML = rows.length
      ? `<table border="1">
           <thead>
             <tr>
               <th>Claim ID</th>
               <th>Activity ID</th>
               <th>Code</th>
               <th>Description</th>
               <th>Net Amount</th>
               <th>Observations</th>
               <th>Remarks</th>
             </tr>
           </thead>
           <tbody>
             ${rows.join("")}
           </tbody>
         </table>`
      : "<p>No activities with observations found.</p>";
  }
}
