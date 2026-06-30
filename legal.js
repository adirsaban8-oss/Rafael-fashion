/* Rafael · Legal pages shared behaviour
   - HE (default, RTL) / EN (LTR) toggle, persisted in localStorage
   - cancel-order form: client-side validation + success message (no backend) */
(function () {
  var KEY = 'rafael_lang';
  function applyLang(lang) {
    lang = (lang === 'en') ? 'en' : 'he';
    document.body.dataset.lang = lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = (lang === 'he') ? 'rtl' : 'ltr';
    var btn = document.getElementById('langToggle');
    if (btn) {
      // button shows the language you can switch TO
      btn.textContent = (lang === 'he') ? 'EN' : 'עברית';
      btn.setAttribute('aria-label', lang === 'he' ? 'Switch to English' : 'מעבר לעברית');
    }
    try { localStorage.setItem(KEY, lang); } catch (e) {}
  }
  function initLang() {
    var saved = 'he';
    try { saved = localStorage.getItem(KEY) || 'he'; } catch (e) {}
    applyLang(saved);
    var btn = document.getElementById('langToggle');
    if (btn) btn.addEventListener('click', function () {
      applyLang(document.body.dataset.lang === 'he' ? 'en' : 'he');
    });
  }

  function initCancelForm() {
    var form = document.getElementById('cancelForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.reportValidity()) return;
      // No backend yet — structure ready for a future POST to an API endpoint.
      // e.g. fetch('/api/cancel-request', { method:'POST', body: new FormData(form) })
      var success = document.getElementById('cancelSuccess');
      form.style.display = 'none';
      if (success) {
        success.classList.add('show');
        success.setAttribute('tabindex', '-1');
        success.focus();
        success.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initLang(); initCancelForm(); });
  } else { initLang(); initCancelForm(); }
})();
