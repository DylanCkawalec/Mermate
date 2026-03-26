'use strict';

(function () {
  var btn = document.getElementById('btn-landing-start');
  var landing = document.getElementById('landing');
  if (!btn || !landing) return;

  // Only show landing on first visit this session
  if (sessionStorage.getItem('mermate-entered')) {
    landing.style.display = 'none';
  }

  btn.addEventListener('click', function () {
    sessionStorage.setItem('mermate-entered', '1');
    landing.classList.add('fade-out');
    landing.addEventListener('transitionend', function () {
      landing.style.display = 'none';
      landing.classList.remove('fade-out');
    }, { once: true });
  });

  // Clicking sidebar logo brings back the landing screen
  var logo = document.querySelector('.sidebar-logo');
  if (logo) {
    logo.style.cursor = 'pointer';
    logo.addEventListener('click', function () {
      landing.style.display = '';
      var result = document.getElementById('result-section');
      if (result) result.hidden = true;
    });
  }
})();
