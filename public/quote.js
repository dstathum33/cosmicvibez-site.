/* Quote form for the service and landing pages. Same three-call flow as the homepage:
   create the request, upload files one at a time, then finish. */
(function () {
  var form = document.getElementById('quoteForm');
  if (!form) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s) { return document.querySelector(s); };
  var NEED = form.getAttribute('data-need') || 'Laser Engraving';
  var files = [], MAXF = 10 * 1024 * 1024, MAXN = 6;
  var OK = /\.(png|jpe?g|gif|webp|heic|pdf|stl|obj|3mf)$/i;
  var sending = false;

  function say(cls, t) { var m = $('#formMsg'); m.className = cls; m.textContent = t; }

  function renderFiles() {
    var ul = $('#fileList'); ul.innerHTML = '';
    files.forEach(function (f, i) {
      var li = document.createElement('li'), s = document.createElement('span'), b = document.createElement('button');
      s.textContent = f.name + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' KB)';
      b.type = 'button'; b.textContent = 'Remove';
      b.addEventListener('click', function () { files.splice(i, 1); renderFiles(); });
      li.appendChild(s); li.appendChild(b); ul.appendChild(li);
    });
  }

  $('#qFiles').addEventListener('change', function (e) {
    say('', '');
    Array.prototype.slice.call(e.target.files).forEach(function (f) {
      if (!OK.test(f.name) && f.type.indexOf('image/') !== 0) { say('err', f.name + ' is not a supported file type.'); return; }
      if (f.size > MAXF) { say('err', f.name + ' is over 10 MB.'); return; }
      if (files.length >= MAXN) { say('err', 'Up to 6 files per request.'); return; }
      files.push(f);
    });
    e.target.value = ''; renderFiles();
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (sending) return;
    var name = $('#qName').value.trim(), email = $('#qEmail').value.trim(), msg = $('#qMsg').value.trim();
    if (!name) { say('err', 'Please add your name.'); $('#qName').focus(); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { say('err', 'Please enter a valid email.'); $('#qEmail').focus(); return; }
    var svcBoxes = Array.prototype.slice.call(document.querySelectorAll('input[name=svc]'));
    var svc = svcBoxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    if (svcBoxes.length && !svc.length) { say('err', 'Please pick at least one service.'); return; }
    if (!msg) { say('err', 'Tell us a little about what you want.'); $('#qMsg').focus(); return; }
    var aud = $('input[name=audience]:checked');
    var item = $('#qItem').value.trim();
    if (svc.length) item = (svc.join(', ') + (item ? ': ' + item : '')).slice(0, 150);
    var payload = {
      name: name, phone: $('#qPhone').value.trim(), email: email, need: [NEED], audience: aud ? aud.value : '',
      quantity: $('#qQty').value.trim(), needed_by: $('#qDate').value, item: item, message: msg,
      heard: '', website: form.elements['website'].value, file_count: files.length
    };
    var btn = form.querySelector('button[type=submit]');
    sending = true; btn.disabled = true; say('ok', 'Sending...');
    try {
      var r = await fetch('/api/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j.id) throw new Error(j.error || 'Something went wrong. Please text 908-248-2374.');
      var failed = [];
      for (var i = 0; i < files.length; i++) {
        say('ok', 'Uploading file ' + (i + 1) + ' of ' + files.length + '...');
        try {
          var fr = await fetch('/api/quote/' + j.id + '/files?token=' + encodeURIComponent(j.token) + '&name=' + encodeURIComponent(files[i].name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: files[i] });
          if (!fr.ok) failed.push(files[i].name);
        } catch (x) { failed.push(files[i].name); }
      }
      var dr = await fetch('/api/quote/' + j.id + '/done?token=' + encodeURIComponent(j.token), { method: 'POST' });
      if (!dr.ok) throw new Error('We saved your request but could not finish sending it. Please text 908-248-2374 so we know it came through.');
      form.reset(); files = []; renderFiles();
      var first = name.split(/\s+/)[0];
      say('ok', 'Request sent. Thanks, ' + first + '! Check your email for a confirmation. We will reply with your free quote.' + (failed.length ? ' These files did not upload: ' + failed.join(', ') + '. Please text or email them to us.' : ''));
      $('#formMsg').scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    } catch (err) {
      say('err', err.message || 'Something went wrong. Please text 908-248-2374.');
    } finally {
      sending = false; btn.disabled = false;
    }
  });
})();
