(function tokenSetupClient() {
  const tokenReveal = document.querySelector("[data-token-reveal]");
  if (!tokenReveal) return;
  const token = tokenReveal.querySelector("[data-token-value]")?.textContent || "";
  const osSelect = tokenReveal.querySelector("select[data-token-os]");
  const targetSelect = tokenReveal.querySelector("select[data-token-target]");
  const command = tokenReveal.querySelector("[data-token-command]");
  const hint = tokenReveal.querySelector("[data-token-hint]");
  if (!(osSelect instanceof HTMLSelectElement) || !(targetSelect instanceof HTMLSelectElement))
    return;
  /** @type {Record<string, Array<[string, string, string]>>} */
  const targets = {
    macos: [
      ["zsh", "Zsh · ~/.zshrc", "Schreibt den Token dauerhaft in ~/.zshrc."],
      ["bash", "Bash · ~/.bash_profile", "Schreibt den Token dauerhaft in ~/.bash_profile."],
      ["fish", "Fish", "Speichert den Token dauerhaft als Fish-Universal-Variable."],
      ["env", "Projekt · .env", "Fügt den Token der .env-Datei im aktuellen Ordner hinzu."],
      ["session", "Nur diese Sitzung", "Setzt den Token nur im aktuellen Terminalfenster."],
    ],
    linux: [
      ["bash", "Bash · ~/.bashrc", "Schreibt den Token dauerhaft in ~/.bashrc."],
      ["zsh", "Zsh · ~/.zshrc", "Schreibt den Token dauerhaft in ~/.zshrc."],
      ["fish", "Fish", "Speichert den Token dauerhaft als Fish-Universal-Variable."],
      ["env", "Projekt · .env", "Fügt den Token der .env-Datei im aktuellen Ordner hinzu."],
      ["session", "Nur diese Sitzung", "Setzt den Token nur im aktuellen Terminalfenster."],
    ],
    windows: [
      [
        "powershell",
        "PowerShell · dauerhaft",
        "Speichert den Token für deinen Windows-Benutzer und setzt ihn in der aktuellen Sitzung.",
      ],
      [
        "powershell-session",
        "PowerShell · diese Sitzung",
        "Setzt den Token nur im aktuellen PowerShell-Fenster.",
      ],
      [
        "cmd",
        "Eingabeaufforderung (CMD)",
        "Speichert den Token für zukünftige CMD-Fenster und setzt ihn im aktuellen Fenster.",
      ],
      [
        "env",
        "PowerShell · Projekt .env",
        "Fügt den Token der .env-Datei im aktuellen Ordner hinzu.",
      ],
    ],
  };
  /** @param {string} os @param {string} target */
  const commandFor = (os, target) => {
    if (os === "windows") {
      if (target === "powershell")
        return (
          "[Environment]::SetEnvironmentVariable('SCHAFFA_TOKEN', '" +
          token +
          "', 'User'); $env:SCHAFFA_TOKEN = '" +
          token +
          "'"
        );
      if (target === "powershell-session") return `$env:SCHAFFA_TOKEN = '${token}'`;
      if (target === "cmd") return `setx SCHAFFA_TOKEN "${token}" && set "SCHAFFA_TOKEN=${token}"`;
      return `Add-Content -Path .env -Encoding utf8 -Value 'SCHAFFA_TOKEN=${token}'`;
    }
    if (target === "fish") return `set -Ux SCHAFFA_TOKEN '${token}'`;
    if (target === "env") return `printf '\nSCHAFFA_TOKEN=%s\n' '${token}' >> .env`;
    if (target === "session") return `export SCHAFFA_TOKEN='${token}'`;
    const profile =
      target === "zsh" ? "~/.zshrc" : os === "macos" ? "~/.bash_profile" : "~/.bashrc";
    return `printf '\nexport SCHAFFA_TOKEN=%s\n' '${token}' >> ${profile} && source ${profile}`;
  };
  const renderCommand = () => {
    if (!osSelect || !targetSelect || !command) return;
    const availableTargets = targets[osSelect.value] || [];
    const previousTarget = targetSelect.value;
    targetSelect.replaceChildren(
      ...availableTargets.map(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    if (availableTargets.some(([value]) => value === previousTarget))
      targetSelect.value = previousTarget;
    command.textContent = commandFor(osSelect.value, targetSelect.value);
    if (hint)
      hint.textContent =
        availableTargets.find(([value]) => value === targetSelect.value)?.[2] || "";
  };
  const updateCommand = () => {
    if (!osSelect || !targetSelect || !command) return;
    command.textContent = commandFor(osSelect.value, targetSelect.value);
    const availableTargets = targets[osSelect.value] || [];
    if (hint)
      hint.textContent =
        availableTargets.find(([value]) => value === targetSelect.value)?.[2] || "";
  };
  const platform = navigator.platform || navigator.platform || "";
  if (/win/i.test(platform)) osSelect.value = "windows";
  else if (/linux/i.test(platform)) osSelect.value = "linux";
  else osSelect.value = "macos";
  osSelect?.addEventListener("change", renderCommand);
  targetSelect?.addEventListener("change", updateCommand);
  renderCommand();
  tokenReveal.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const source = tokenReveal.querySelector(
        button.getAttribute("data-copy") || "[data-token-value]",
      );
      if (!source?.textContent) return;
      const originalLabel = button.textContent;
      try {
        await navigator.clipboard.writeText(source.textContent);
        button.textContent = "Kopiert";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        button.textContent = "Markiert";
      }
      window.setTimeout(() => {
        button.textContent = originalLabel;
      }, 1800);
    });
  });
})();
