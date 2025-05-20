function parseXML() {
  const fileInput = document.getElementById("xmlFile");
  const codeFilter = document.getElementById("codeFilter").value.trim();
  const output = document.getElementById("output");

  if (!fileInput.files.length) {
    output.textContent = "Please upload an XML file.";
    return;
  }

  const reader = new FileReader();
  reader.onload = function () {
    const parser = new DOMParser();
    const xml = parser.parseFromString(reader.result, "text/xml");
    const activities = xml.getElementsByTagName("activity");

    let results = [];
    for (let activity of activities) {
      const codeNode = activity.querySelector("code");
      const observationNode = activity.querySelector("observation");

      const code = codeNode ? codeNode.textContent.trim() : "(no code)";
      const hasObservation = !!observationNode;

      if (!codeFilter || code === codeFilter) {
        results.push(`Code: ${code} | Observation: ${hasObservation ? "Yes" : "No"}`);
      }
    }

    output.textContent = results.length
      ? results.join("\n")
      : "No matching activities found.";
  };

  reader.readAsText(fileInput.files[0]);
}
