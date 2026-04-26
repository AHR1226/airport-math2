window.selectionsApi = (() => {
  function syncInitialSelectionState() {
    document.querySelectorAll('.chipGroup').forEach(group => {
      const groupName = group.getAttribute('data-group');
      const activeChip = group.querySelector('.chip.active');
      if (window.stateApi && groupName && activeChip) {
        window.stateApi.setSelection(groupName, activeChip.textContent.trim());
      }
    });
  }

  function bindChipInteractions() {
    document.querySelectorAll('.chipGroup').forEach(group => {
      const chips = group.querySelectorAll('.chip');
      const groupName = group.getAttribute('data-group');

      chips.forEach(chip => {
        chip.onclick = () => {
          chips.forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          if (window.stateApi && groupName) {
            window.stateApi.setSelection(groupName, chip.textContent.trim());
          }
        };
      });
    });
  }

  function getActive(groupName) {
    if (window.stateApi) {
      return window.stateApi.getSelection(groupName);
    }
    const group = document.querySelector(`[data-group="${groupName}"]`);
    return group?.querySelector('.chip.active')?.textContent.trim() || '';
  }

  function init() {
    syncInitialSelectionState();
    bindChipInteractions();
  }

  return {
    init,
    getActive
  };
})();
