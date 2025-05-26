const pages = [
  { label: "Clinician", file: "checkers/checker_clinician.html" },
  { label: "Approvals", file: "checkers/checker_procedure_approval.html" },
  { label: "Timings", file: "checkers/checker_timings.html" },
  { label: "Tooths", file: "checkers/checker_tooths.html" }
];

const navbar = document.getElementById("navbar");
const iframe = document.getElementById("mainIframe");

function setActiveButton(activeIndex) {
  Array.from(navbar.children).forEach((btn, i) => {
    btn.classList.toggle("active", i === activeIndex);
  });
}

function loadPage(file, index) {
  iframe.src = file;
  setActiveButton(index);
}

function buildNavbar() {
  navbar.innerHTML = "";
  pages.forEach((page, i) => {
    const btn = document.createElement("button");
    btn.textContent = page.label;
    btn.onclick = () => loadPage(page.file, i);
    navbar.appendChild(btn);
  });
  loadPage(pages[0].file, 0);
}

buildNavbar();
