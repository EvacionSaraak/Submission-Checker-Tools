function parseXML() {
  console.log("🔍 Starting parseXML function");

  const fileInput = document.getElementById("xmlFile");
  const resultsDiv = document.getElementById("results");

  if (!fileInput) {
    console.error("❌ File input element not found (id='xmlFile')");
    return;
  }

  if (!fileInput.files.length) {
    console.warn("⚠️ No file uploaded.");
    resultsDiv.innerHTML = "<p>Please upload an XML file.</p>";
    return;
  }

  console.log("📄 File found:", fileInput.files[0].name);

  const reader = new FileReader();
  reader.onload = function () {
    console.log("📥 File read successfully");

    const parser = new DOMParser();
    const xml = parser.parseFromString(reader.result, "text/xml");
    console.log("🧩 XML parsed");

    const claims = xml.getElementsByTagName("Claim");
    console.log(`📦 Found ${claims.length} <Claim> elements`);

    let rows = [];

    for (let claim of claims) {
      const claimId = claim.getElementsByTagName("ID")[0]?.textContent || "(no claim ID)";
      const activities = claim.getElementsByTagName("Activity");
      console.log(`📝 Claim ${claimId} has ${activities.length} activities`);

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

          console.log(`✅ Found observation in activity ${activityId}`);
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
      console.log("🔎 No activities with observations found.");
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
      console.log("✅ Table rendered with", rows.length, "rows");
    }
  };

  reader.onerror = function (e) {
    console.error("❌ FileReader error:", e);
  };

  reader.readAsText(fileInput.files[0]);
}
