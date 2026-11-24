// Synchronous zero-FOUC theme bootstrap served under strict `script-src 'self'` CSP.
(function () {
  try {
    if (localStorage.getItem("ac_desktop_theme") === "dark") {
      document.documentElement.classList.add("dark");
    }
  } catch {}
})();
