/* Registration page logic. */
"use strict";

(function () {
  const form = document.getElementById("regForm");
  const errBox = document.getElementById("error");
  const btn = document.getElementById("submitBtn");

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.classList.add("hidden");
    const username = document.getElementById("username").value.trim();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const confirm = document.getElementById("confirm").value;

    if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
      showError("Username must be 3–32 characters: lowercase a–z, 0–9, - or _.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      showError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      showError("Passwords do not match.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Creating account…";
    try {
      await Tm.api.post("/api/v1/auth/register", { username, email, password });
      await Tm.api.post("/api/v1/auth/login", { login: username, password });
      location.replace("/dashboard");
    } catch (err) {
      showError(err.message || "Registration failed.");
      btn.disabled = false;
      btn.textContent = "Create account";
    }
  });
})();
