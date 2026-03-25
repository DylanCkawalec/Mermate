'use strict';

(function () {
  var btn = document.getElementById('btn-landing-start');
  var landing = document.getElementById('landing');
  if (!btn || !landing) return;

  btn.addEventListener('click', function () {
    landing.classList.add('fade-out');
    landing.addEventListener('transitionend', function () {
      landing.style.display = 'none';
      landing.classList.remove('fade-out');
    }, { once: true });
  });

  var logo = document.querySelector('.sidebar-logo');
  if (logo) {
    logo.style.cursor = 'pointer';
    logo.addEventListener('click', function () {
      landing.style.display = '';
      // hide result section when returning to landing
      var result = document.getElementById('result-section');
      if (result) result.hidden = true;
    });
  }
})();
