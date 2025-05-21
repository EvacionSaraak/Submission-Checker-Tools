// script.js
// -----------------------

function parseXML() {
  const xmlInput = document.getElementById("xmlFile");
  const jsonInput = document.getElementById("jsonFile");
  const resultsDiv = document.getElementById("results");

  // path to your repository JSON (adjust if in a subfolder)
  const repoJsonUrl = 'tooth validity.json';

  // region definitions
  const ANTERIOR_TEETH = new Set(['6','7','8','9','10','11','22','23','24','25','26','27']);
  const BICUSPID_TEETH = new Set(['4','5','12','13','20','21','28','29']);
  const POSTERIOR_TEETH = new Set(['1','2','3','14','15','16','17','18','19','30','31','32']);

  if (!xmlInput || !resultsDiv) {
    console.error("Missing required DOM elements.");
    return;
  }

  if (!xmlInput.files.length) {
    resultsDiv.innerHTML = "<p>Please upload an XML file.</p>";
    return;
  }

  let xmlData = null;
  let jsonData = null;

  const xmlReader = new FileReader();

  xmlReader.onload = () => {
    xmlData = xmlReader.result;
    tryProcess();
  };
  xmlReader.onerror = () => {
    console.error("Error reading XML file");
  };

  xmlReader.readAsText(xmlInput.files[0]);

  // if user uploaded JSON, read it; otherwise fetch from repo
  if (jsonInput && jsonInput.files.length) {
    const jsonReader = new FileReader();
    jsonReader.onload = () => {
      jsonData = jsonReader.result;
      tryProcess();
    };
    jsonReader.onerror = () => {
      console.error("Error reading uploaded JSON file");
    };
    jsonReader.readAsText(jsonInput.files[0]);
  } else {
    fetch(repoJsonUrl)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(text => {
        jsonData = text;
        tryProcess();
      })
      .catch(err => {
        console.error("Error fetching repository JSON:", err);
        resultsDiv.innerHTML = "<p>Could not load repository JSON.</p>";
      });
  }

  function tryProcess() {
    if (!xmlData || !jsonData) return;

    // build code→metadata map
    let codeToMeta = {};
    try {
      const parsedJSON = JSON.parse(jsonData);
      for (const entry of parsedJSON) {
        const teethSet = (() => {
          switch ((entry.affiliated_teeth || "").toLowerCase()) {
            case "all":
              return new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH, ...POSTERIOR_TEETH]);
            case "anteriors":
              return ANTERIOR_TEETH;
            case "posteriors":
              return POSTERIOR_TEETH;
            case "bicuspid":
              return BICUSPID_TEETH;
            case "anteriors/bicuspid":
              return new Set([...ANTERIOR_TEETH, ...BICUSPID_TEETH]);
            default:
              return new Set();
          }
        })();

        for (const rawCode of entry.codes || []) {
          const trimmed = rawCode.toString().trim();
          codeToMeta[trimmed] = {
            teethSet,
            description: entry.description || "(no description)"
          };
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

        const meta = codeToMeta[code] || {};
        const allowedTeeth = meta.teethSet || new Set();
        const description = meta.description || "(no description)";

        const observationDetails = Array.from(obsList).map(obs => {
          const type = obs.querySelector("Type")?.textContent || "";
          const obsCode = obs.querySelector("Code")?.textContent.trim() || "";
          if (/^\d+$/.test(obsCode) && !allowedTeeth.has(obsCode)) {
            isValid = false;
            remarks.push(`Tooth ${obsCode} not valid for code ${code}`);
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
            <td>${net}</td>
            <td>${observationDetails}</td>
            <td>${remarkText}</td>
            <td>${description}</td>
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
               <th>Net Amount</th>
               <th>Observations</th>
               <th>Remarks</th>
               <th>Description</th>
             </tr>
           </thead>
           <tbody>
             ${rows.join("")}
           </tbody>
         </table>`
      : "<p>No activities with observations found.</p>";
  }
}
