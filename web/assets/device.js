/* Device authorization page: approve/deny a `tmin login` request. */
"use strict";

(function () {
  const codeInput = document.getElementById("codeInput");
  const errBox = document.getElementById("error");
  const step1 = document.getElementById("step1");
  const step2 = document.getElementById("step2");
  const step3 = document.getElementById("step3");
  let userCode = "";

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.remove("hidden");
  }

  function normalize(value) {
    return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  codeInput.addEventListener("input", () => {
    const raw = normalize(codeInput.value).slice(0, 8);
    codeInput.value = raw.length > 4 ? raw.slice(0, 4) + "-" + raw.slice(4) : raw;
  });

  function finish(kind, title, msg) {
    step3.classList.remove("hidden");
    document.getElementById("step3Title").textContent = title;
    document.getElementById("step3Msg").textContent = msg;
    const icon = document.getElementById("step3Icon");
    if (kind === "ok") {
      icon.classList.add("bg-brand-400/15", "text-brand-300");
      icon.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 13l4 4L19 7"/></svg>';
    } else {
      icon.classList.add("bg-rose-500/15", "text-rose-300");
      icon.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    }
    step1.classList.add("hidden");
    step2.classList.add("hidden");
  }

  async function check() {
    errBox.classList.add("hidden");
    const code = codeInput.value.trim();
    if (normalize(code).length !== 8) {
      showError("Enter the 8-character code, for example K7PQ-3M2X.");
      return;
    }
    const btn = document.getElementById("checkBtn");
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const r = await Tm.api.post("/api/v1/auth/device/verify", { user_code: code, action: "check" });
      userCode = code;
      document.getElementById("clientName").textContent = r.clientName || "tmin CLI";
      document.getElementById("clientMeta").textContent = "Requested " + Tm.fmtAgo(r.createdAt) + " · expires in " + Math.max(0, Math.floor((r.expiresAt - Date.now()) / 1000)) + "s";
      step1.classList.add("hidden");
      step2.classList.remove("hidden");
    } catch (e) {
      showError(e.code === "NOT_AUTHENTICATED" ? "Please log in first." : e.message);
      if (e.code === "NOT_AUTHENTICATED") {
        location.href = "/login?next=" + encodeURIComponent("/device?code=" + normalize(codeInput.value));
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Continue";
    }
  }

  document.getElementById("checkBtn").addEventListener("click", check);
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") check();
  });

  async function decide(action) {
    const btns = [document.getElementById("approveBtn"), document.getElementById("denyBtn")];
    btns.forEach((b) => (b.disabled = true));
    try {
      await Tm.api.post("/api/v1/auth/device/verify", { user_code: userCode, action });
      if (action === "approve") finish("ok", "Device approved", "Return to your terminal — tmin is logged in and ready.");
      else finish("no", "Request denied", "The device was not given access.");
    } catch (e) {
      Tm.toast(e.message, "err");
      btns.forEach((b) => (b.disabled = false));
    }
  }
  document.getElementById("approveBtn").addEventListener("click", () => decide("approve"));
  document.getElementById("denyBtn").addEventListener("click", () => decide("deny"));

  // Auth guard + optional deep link (?code=XXXX-XXXX from verification_uri_complete).
  Tm.me().then((user) => {
    if (!user) {
      const next = "/device" + (Tm.qs("code") ? "?code=" + encodeURIComponent(Tm.qs("code")) : "");
      location.replace("/login?next=" + encodeURIComponent(next));
      return;
    }
    document.getElementById("deviceUser").textContent = user.username;
    const preset = Tm.qs("code");
    if (preset) {
      codeInput.value = preset.toUpperCase();
      check();
    }
  });
})();
