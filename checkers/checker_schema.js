function validateXmlSchema() {
  const fileInput = document.getElementById('xmlFile');
  const file = fileInput.files[0];
  if (!file) return alert("Please upload an XML file.");

  const reader = new FileReader();
  reader.onload = function (e) {
    const xmlString = e.target.result;
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlString, "application/xml");

      const errors = xmlDoc.getElementsByTagName("parsererror");
      const tableBody = document.querySelector("#resultTable tbody");
      tableBody.innerHTML = "";

      if (errors.length > 0) {
        for (const error of errors) {
          const message = error.textContent;
          tableBody.innerHTML += `
            <tr>
              <td>Parsing Error</td>
              <td>N/A</td>
              <td>${message}</td>
            </tr>`;
        }
      } else {
        tableBody.innerHTML = `
          <tr>
            <td colspan="3">No XML parsing errors found (note: this does not validate against XSD).</td>
          </tr>`;
      }
    } catch (err) {
      console.error("Error during XML parse:", err);
    }
  };
  reader.readAsText(file);
}
