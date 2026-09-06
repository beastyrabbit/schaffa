(function accountClient() {
  const shell = document.querySelector("[data-account-login]");
  const shoo = window.Shoo;
  if (!shell || !shoo) return;
  const error = document.getElementById("auth-error");
  /** @param {string} message */
  const showError = (message) => {
    if (!error) return;
    error.hidden = false;
    error.textContent = message;
  };
  if (shell.hasAttribute("data-signed-out")) {
    shoo.clearIdentity();
    history.replaceState({}, "", "/account");
    return;
  }
  const establishSession = async () => {
    const identity = shoo.getIdentity();
    if (!identity?.token) return false;
    const response = await fetch("/auth/shoo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: identity.token }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.message || "Anmeldung fehlgeschlagen.");
    }
    location.replace("/account");
    return true;
  };
  const link = document.getElementById("shoo-sign-in");
  link?.addEventListener("click", (event) => {
    event.preventDefault();
    shoo.startSignIn({ returnTo: "/account", requestPii: true });
  });
  establishSession().catch((cause) =>
    showError(cause instanceof Error ? cause.message : "Anmeldung fehlgeschlagen."),
  );
})();
