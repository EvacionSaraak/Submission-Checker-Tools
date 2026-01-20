document.addEventListener('click', e => {
  // Find the closest TD element (works even if clicking on child elements)
  const cell = e.target.closest('td');

  // Must be a TD, and not inside or containing a button/input
  if (
    cell &&
    !cell.closest('button') &&
    !cell.querySelector('button') &&
    !cell.closest('input') &&
    !cell.querySelector('input')
  ) {
    const text = cell.innerText.trim();
    if (text) {
      console.log('[CLIPBOARD] Copying:', text);
      navigator.clipboard.writeText(text).then(() => {
        // Remove previous permanent highlight
        document.querySelectorAll('td.last-copied').forEach(td => td.classList.remove('last-copied'));

        // Add permanent highlight to this cell
        cell.classList.add('last-copied');

        // Add temporary copied flash effect
        cell.classList.add('copied');
        setTimeout(() => cell.classList.remove('copied'), 800);
      }).catch(err => {
        console.error('Clipboard copy failed:', err);
      });
    }
  }
});
