/* Shared usability helpers: field errors with focus, saved drafts, phone bar. */
(function () {
  var CV = window.CV = {};

  /* ---- errors under each field, a summary line, focus on the first problem ---- */
  CV.clear = function (form, summary) {
    Array.prototype.slice.call(form.querySelectorAll('.ferr')).forEach(function (n) { n.parentNode.removeChild(n); });
    Array.prototype.slice.call(form.querySelectorAll('[aria-invalid]')).forEach(function (n) { n.removeAttribute('aria-invalid'); n.removeAttribute('aria-describedby'); });
    if (summary) { summary.className = ''; summary.textContent = ''; }
  };
  /* bad: list of [element, message]. element may be an input or a group container. */
  CV.show = function (form, bad, summary) {
    CV.clear(form);
    bad.forEach(function (b, i) {
      var el = b[0], p = document.createElement('p');
      p.className = 'ferr'; p.id = 'err-' + (el.id || 'f' + i); p.textContent = b[1];
      el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', p.id);
      el.parentNode.insertBefore(p, el.nextSibling);
      var clearOne = function () {
        el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby');
        if (p.parentNode) p.parentNode.removeChild(p);
        el.removeEventListener('input', clearOne); el.removeEventListener('change', clearOne);
      };
      el.addEventListener('input', clearOne); el.addEventListener('change', clearOne);
    });
    if (summary) {
      summary.className = 'err';
      summary.textContent = bad.length === 1 ? 'Please fix 1 thing below.' : 'Please fix ' + bad.length + ' things below.';
    }
    var first = bad[0][0];
    var f = first.matches && first.matches('input,select,textarea,button') ? first : first.querySelector('input,button,select,textarea');
    if (f) f.focus();
    try { first.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } catch (e) {}
  };

  /* ---- drafts: keep what was typed if the visitor leaves and comes back ---- */
  function key(form) { return 'cv-draft:' + location.pathname + ':' + (form.id || 'form'); }
  function fields(form) {
    return Array.prototype.slice.call(form.elements).filter(function (el) {
      return el.type !== 'file' && el.type !== 'password' && el.type !== 'submit' && el.type !== 'button' && el.name !== 'website' && el.id !== 'hp' && (el.id || el.name);
    });
  }
  CV.saveDraft = function (form) {
    try {
      var d = {};
      fields(form).forEach(function (el) {
        var k = el.id || el.name;
        if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) d[(el.type === 'radio' ? 'r:' + el.name : 'c:' + (el.id || el.name + '=' + el.value))] = el.value; }
        else if (el.value) d['v:' + k] = el.value;
      });
      var empty = Object.keys(d).length === 0;
      if (empty) localStorage.removeItem(key(form)); else localStorage.setItem(key(form), JSON.stringify(d));
    } catch (e) {}
  };
  CV.clearDraft = function (form) { try { localStorage.removeItem(key(form)); } catch (e) {} };
  CV.restoreDraft = function (form) {
    var d; try { d = JSON.parse(localStorage.getItem(key(form)) || 'null'); } catch (e) { d = null; }
    if (!d) return;
    fields(form).forEach(function (el) {
      var k = el.id || el.name, hit = false;
      if (el.type === 'radio') { if (d['r:' + el.name] === el.value) { el.checked = true; hit = true; } }
      else if (el.type === 'checkbox') { if (d['c:' + (el.id || el.name + '=' + el.value)] === el.value) { el.checked = true; hit = true; } }
      else if (d['v:' + k] != null && el.type !== 'date') { el.value = d['v:' + k]; hit = true; }
      else if (d['v:' + k] != null) { el.value = d['v:' + k]; hit = true; }
      if (hit) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  };
  function watch(form) {
    var t;
    var go = function () { clearTimeout(t); t = setTimeout(function () { CV.saveDraft(form); }, 400); };
    form.addEventListener('input', go); form.addEventListener('change', go);
    CV.restoreDraft(form);
  }

  document.addEventListener('DOMContentLoaded', function () {
    Array.prototype.slice.call(document.querySelectorAll('form[data-draft],#quoteForm,#form')).forEach(watch);
    /* phone bar */
    if (/^\/admin|^\/paid/.test(location.pathname)) return;
    var target = document.getElementById('quote') ? '#quote' : (document.getElementById('send') ? '#send' : '/#quote');
    var bar = document.createElement('nav');
    bar.className = 'cvbar'; bar.setAttribute('aria-label', 'Call, text or get a quote');
    bar.innerHTML = '<a class="btn ghost" href="tel:+19082482374">Call</a><a class="btn ghost" href="sms:+19082482374">Text</a><a class="btn" href="' + target + '">Get a Free Quote</a>';
    document.body.appendChild(bar);
  });
})();
