// Synchronous zero-FOUC theme bootstrap served under strict `script-src 'self'` CSP.
(function () {
  try {
    const isDark = localStorage.getItem("ac_desktop_theme") === "dark";
    if (isDark) {
      document.documentElement.classList.add("dark");
    }
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  } catch {}
})();
