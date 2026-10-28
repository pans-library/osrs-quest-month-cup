// Theme switch shared by every page: Light, Dark, or System (follow the device).
// Loaded in <head> without defer so the saved theme applies before the first paint.
(function () {
  const KEY = 'cup-theme';
  const CHOICES = ['light', 'dark', 'system'];
  const root = document.documentElement;

  let theme = 'system';
  try { const t = localStorage.getItem(KEY); if (CHOICES.includes(t)) theme = t; } catch {}

  function apply() {
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    for (const b of document.querySelectorAll('[data-theme-choice]')) {
      b.setAttribute('aria-pressed', String(b.dataset.themeChoice === theme));
    }
  }
  apply();

  document.addEventListener('DOMContentLoaded', () => {
    for (const b of document.querySelectorAll('[data-theme-choice]')) {
      b.addEventListener('click', () => {
        theme = b.dataset.themeChoice;
        try { if (theme === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, theme); } catch {}
        apply();
      });
    }
    apply();
  });
})();
