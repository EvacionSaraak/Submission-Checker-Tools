function parseXML() {
  const fileInput = document.getElementById("xmlFile");
  const resultsDiv = document.getElementById("results");

  if (!fileInput.files.length) {
    resultsDiv.innerHTML = "<p>Please upload an XML file.</p>";
    return;
  }

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
          const code = activity.getElementsByTagName("Code")[0]?.textContent || "";
          const net = activity.getElementsByTagName("Net")[0]?.textContent || "";
          const observationDetails = Array.from(observations).map(obs => {
            const type = obs.getElementsByTagName("Type")[0]?.textContent || "";
            const obsCode = obs.getElementsByTagName("Code")[0]?.textContent || "";
            return `${type}: ${obsCode}`;
          }).join("<br>");

          rows.push(`<tr>
            <td>${claimId}</td>
            <td>${activityId}</td>
            <td>${code}</td>
            <td>${net}</td>
            <td>${observationDetails}</td>
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
