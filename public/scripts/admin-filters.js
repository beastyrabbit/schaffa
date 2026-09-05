(function adminFiltersClient() {
  const filters = document.querySelector("[data-admin-filters]");
  const user = filters?.querySelector("[name=user]");
  const uploader = filters?.querySelector("[name=uploader]");
  if (!(user instanceof HTMLSelectElement) || !(uploader instanceof HTMLSelectElement)) return;
  const syncUploaders = () => {
    for (const option of Array.from(uploader.options).slice(1)) {
      const available = !user.value || option.dataset.user === user.value;
      option.disabled = !available;
      option.hidden = !available;
    }
    if (uploader.selectedOptions[0]?.disabled) uploader.value = "";
  };
  user.addEventListener("change", syncUploaders);
  syncUploaders();
})();
