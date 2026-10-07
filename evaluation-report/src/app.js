(() => {
  'use strict';
  const report = window.EvaluationReportData;
  const pages = ['flow', 'architecture', 'rules', 'prompts', 'experiments'];
  const $ = id => document.getElementById(id);
  function activatePage(value, updateHash = true, animate = true) {
    const page = pages.includes(value) ? value : 'flow';
    document.querySelectorAll('.page').forEach(element => { element.hidden = element.id !== `page-${page}`; });
    document.querySelectorAll('[data-page]').forEach(button => {
      if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (updateHash) history.replaceState(null, '', `#${page}`);
    window.scrollTo(0, 0);
    if (animate) window.ReportMotion.reveal($(`page-${page}`), { distance: 3, duration: 140 });
    window.dispatchEvent(new Event('report-page-change'));
  }
  window.ReportFlow.render($('flowBody'), report);
  window.ReportArchitecture.render($('architectureBody'), report);
  window.ReportExperiments.render($('experimentsBody'), window.EvaluationExperimentData);
  window.ReportRules.render($('rulesBody'), report);
  window.ReportPrompts.render($('promptsBody'));
  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => activatePage(button.dataset.page)));
  document.querySelector('.skip').addEventListener('click', event => { event.preventDefault(); $('main').focus(); });
  addEventListener('hashchange', () => activatePage(location.hash.slice(1), false));
  activatePage(location.hash.slice(1), false, false);
})();
