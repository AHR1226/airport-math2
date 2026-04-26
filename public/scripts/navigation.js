window.navigationApi = (() => {
  const screens = () => [...document.querySelectorAll('.screen')];

  function show(id) {
    if (window.stateApi) {
      window.stateApi.setScreen(id);
    }

    screens().forEach(s => {
      s.classList.toggle('active', s.id === id);
    });

    const hideNav = ['splash', 'loading'].includes(id);

    document.body.classList.toggle('hideBottomNav', hideNav);

    document.querySelectorAll('.navTap').forEach(b => {
      b.style.display = hideNav ? 'none' : 'block';
    });

    document.querySelectorAll('.bottomNav button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.to === id);
    });

    if (id === 'settings' && window.syncSettingsTravelStyleUI) {
      window.syncSettingsTravelStyleUI();
    }
  }

  function bindBottomNav() {
    document.querySelectorAll('.bottomNav button').forEach(btn => {
      btn.addEventListener('click', () => {
        show(btn.getAttribute('data-to'));
      });
    });
  }

  function init() {
    show('splash');
    bindBottomNav();
  }

  return {
    init,
    show
  };
})();

window.show = window.navigationApi.show;
