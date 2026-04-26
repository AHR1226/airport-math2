window.selectionsApi = (() => {
  function chipSelectionValue(chip) {
    if (!chip) return '';
    const explicit = chip.getAttribute('data-selection');
    if (explicit) return explicit.trim();
    const label = chip.querySelector('.styleChipLabel');
    if (label) return label.textContent.trim();
    return chip.textContent.trim();
  }

  function syncInitialSelectionState() {
    document.querySelectorAll('.chipGroup').forEach(group => {
      const groupName = group.getAttribute('data-group');
      const activeChip = group.querySelector('.chip.active');
      if (window.stateApi && groupName && activeChip) {
        window.stateApi.setSelection(groupName, chipSelectionValue(activeChip));
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
            window.stateApi.setSelection(groupName, chipSelectionValue(chip));
          }
          if (groupName === 'style' && window.syncSettingsTravelStyleUI) {
            window.syncSettingsTravelStyleUI();
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
    return chipSelectionValue(group?.querySelector('.chip.active')) || '';
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
