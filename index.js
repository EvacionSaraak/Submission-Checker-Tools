const pages = [
  { label: "Clinician (WIP)", file: "checkers/checker_clinician.html" },
  { label: "Approvals (WIP)", file: "checkers/checker_procedure_approval.html" },
  { label: "Timings", file: "checkers/checker_timings.html" },
  { label: "Tooths", file: "checkers/checker_tooths.html" }
];

const navbar = document.getElementById("navbar");
const iframe = document.getElementById("mainIframe");

function setActiveButton(activeIndex) {
  Array.from(navbar.querySelector(".nav-left").children).forEach((btn, i) => {
    btn.classList.toggle("active", i === activeIndex);
  });
}

function loadPage(file, index) {
  iframe.src = file;
  setActiveButton(index);
}

function buildNavbar() {
  navbar.innerHTML = "";

  // Left container for nav buttons
  const leftContainer = document.createElement("div");
  leftContainer.className = "nav-left";

  pages.forEach((page, i) => {
    const btn = document.createElement("button");
    btn.textContent = page.label;
    btn.onclick = () => loadPage(page.file, i);
    leftContainer.appendChild(btn);
  });

  navbar.appendChild(leftContainer);

  // Right container for report issue link
  const rightContainer = document.createElement("div");
  rightContainer.className = "nav-right";
  rightContainer.innerHTML = `
    Found an issue? Please report it to the
    <a href="https://github.com/EvacionSaraak/Submission-Checker-Tools" target="_blank" rel="noopener">developer</a>.
  `;
  navbar.appendChild(rightContainer);

  loadPage(pages[0].file, 0);
}

buildNavbar();
