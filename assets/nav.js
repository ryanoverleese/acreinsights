// Mobile menu for pages outside the home page (same markup and classes as index.html).
(function () {
  const button = document.getElementById('menuBtn');
  const links = document.getElementById('navLinks');
  if (!button || !links) return;
  function close() {
    links.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Open navigation');
  }
  button.addEventListener('click', function () {
    const open = links.classList.toggle('open');
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && links.classList.contains('open')) { close(); button.focus(); }
  });
})();
