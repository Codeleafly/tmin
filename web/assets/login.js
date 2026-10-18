/* Login page logic. */
"use strict";

(function () {
  const form = document.getElementById("loginForm");
  const errBox = document.getElementById("error");
  const btn = document.getElementById("submitBtn");

  // Only allow same-site relative redirects: "/path" but not "//evil".
  const rawNext = Tm.qs("next") || "";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  const toggle = document.getElementById("togglePw");
  toggle.addEventListener("click", () => {
    const pw = document.getElementById("password");
    pw.type = pw.type === "password" ? "text" : "password";
  });

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
  }

  // Already logged in? Skip the form.
  Tm.me().then((user) => {
    if (user) location.replace(next);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.classList.add("hidden");
    const login = document.getElementById("login").value.trim();
    const password = document.getElementById("password").value;
    if (!login || !password) {
      showError("Enter your username/email and password.");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await Tm.api.post("/api/v1/auth/login", { login, password });
      location.replace(next);
    } catch (err) {
      showError(err.message || "Login failed.");
      btn.disabled = false;
      btn.textContent = "Log in";
    }
  });
})();
