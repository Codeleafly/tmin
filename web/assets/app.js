/* tmin web UI — shared helpers (vanilla JS, no build step, no framework). */
"use strict";

window.Tm = (function () {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  async function req(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw { code: "NETWORK", message: "Cannot reach the server. Check your connection.", status: 0 };
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw { code: err.code || "REQUEST_FAILED", message: err.message || ("HTTP " + res.status), status: res.status };
    }
    return data;
  }

  const api = {
    get: (p) => req("GET", p),
    post: (p, b) => req("POST", p, b === undefined ? {} : b),
    patch: (p, b) => req("PATCH", p, b),
    del: (p) => req("DELETE", p),
  };

  function fmtBytes(n) {
    if (n == null) return "—";
    if (n < 0) return "unlimited";
    if (n < 1024) return n + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + " " + units[i];
  }

  function fmtDate(ms) {
    if (!ms) return "—";
    try { return new Date(ms).toLocaleString(); } catch (_) { return String(ms); }
  }

  function fmtAgo(ms) {
    if (!ms) return "never";
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 48) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function fmtUptime(sec) {
    if (sec == null) return "—";
    if (sec < 60) return sec + "s";
    const m = Math.floor(sec / 60);
    if (m < 60) return m + "m " + (sec % 60) + "s";
    const h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }

  function toast(message, kind) {
    let wrap = document.querySelector(".toast-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "toast-wrap";
      document.body.appendChild(wrap);
    }
    const el = document.createElement("div");
    el.className = "toast " + (kind === "ok" ? "ok" : kind === "err" ? "err" : "");
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 2600);
    setTimeout(() => el.remove(), 3000);
  }

  async function me() {
    try {
      const r = await api.get("/api/v1/me");
      return r.user;
    } catch (_) {
      return null;
    }
  }

  async function requireAuth(nextPath) {
    const user = await me();
    if (!user) {
      const next = nextPath || (location.pathname + location.search);
      location.href = "/login?next=" + encodeURIComponent(next);
      return null;
    }
    return user;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard", "ok");
      return true;
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_e) { ok = false; }
      ta.remove();
      toast(ok ? "Copied to clipboard" : "Copy failed — select manually", ok ? "ok" : "err");
      return ok;
    }
  }

  function bindNav() {
    const btn = document.getElementById("navBtn");
    const menu = document.getElementById("navMenu");
    if (!btn || !menu) return;
    btn.addEventListener("click", () => menu.classList.toggle("hidden"));
  }

  function bindCopy() {
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-copy]");
      if (!el) return;
      const target = el.getAttribute("data-copy");
      const node = target ? document.querySelector(target) : null;
      const text = node ? (node.textContent || node.value || "") : el.getAttribute("data-copy-text") || "";
      if (text) copy(text);
    });
  }

  document.addEventListener("DOMContentLoaded", () => { bindNav(); bindCopy(); });

  return { esc, qs, api, fmtBytes, fmtDate, fmtAgo, fmtUptime, toast, me, requireAuth, copy };
})();
