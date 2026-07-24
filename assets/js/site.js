// FMC corporate site — the only script on the site.
// 1) Mobile menu toggle (real <button aria-expanded aria-controls>).
// 2) Team bio dialogs on About: bubble card -> full-bio popup (<dialog>).
// 3) Contact form: progressive enhancement over a plain POST — AJAX submit to
//    the fmc-forms Worker, status announced via an aria-live region, button
//    re-enabled on BOTH success and error paths.
(function () {
  var toggle = document.querySelector('.nav-toggle');
  var menu = document.getElementById('mobile-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', function () {
      var open = menu.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  var bioButtons = document.querySelectorAll('[data-bio]');
  for (var i = 0; i < bioButtons.length; i++) {
    (function (btn) {
      var dialog = document.getElementById(btn.getAttribute('data-bio'));
      if (!dialog) return;
      btn.addEventListener('click', function () {
        if (dialog.showModal) dialog.showModal();
        else dialog.setAttribute('open', '');
      });
    })(bioButtons[i]);
  }
  var bioCloses = document.querySelectorAll('[data-bio-close]');
  for (var j = 0; j < bioCloses.length; j++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var d = btn.closest ? btn.closest('dialog') : null;
        if (!d) return;
        if (d.close) d.close();
        else d.removeAttribute('open');
      });
    })(bioCloses[j]);
  }
  var bioDialogs = document.querySelectorAll('dialog.bio-dialog');
  for (var k = 0; k < bioDialogs.length; k++) {
    (function (d) {
      d.addEventListener('click', function (e) {
        if (e.target === d && d.close) d.close();
      });
    })(bioDialogs[k]);
  }

  var form = document.querySelector('form[data-fmc-form]');
  if (!form || !window.fetch || !window.FormData) return;

  var status = form.querySelector('.form-status');
  var button = form.querySelector('button[type="submit"]');
  var defaultLabel = button ? button.textContent : '';

  function announce(state, msg) {
    if (!status) return;
    status.setAttribute('data-state', state);
    status.textContent = msg;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!form.reportValidity()) return;
    if (button) { button.disabled = true; button.textContent = 'Sending…'; }
    announce('', '');

    fetch(form.action, { method: 'POST', body: new FormData(form) })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.ok) {
            form.reset();
            announce('ok', "Thanks — we've received your message and will get back to you.");
          } else {
            announce('error', data.error || "We couldn't send your message. Please try again, or call (410) 268-6608.");
          }
        });
      })
      .catch(function () {
        announce('error', "We couldn't send your message. Please try again, or call (410) 268-6608.");
      })
      .then(function () {
        if (button) { button.disabled = false; button.textContent = defaultLabel; }
        if (window.turnstile) window.turnstile.reset();
      });
  });
})();
