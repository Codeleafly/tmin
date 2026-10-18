/* Dashboard page logic: account, tunnels, usage, routes, tokens, sessions. */
"use strict";

(function () {
  const esc = Tm.esc;

  function logout() {
    Tm.api.post("/api/v1/auth/logout").catch(() => {}).finally(() => location.replace("/login"));
  }
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("logoutBtnMobile").addEventListener("click", logout);

  function statusBadge(status) {
    if (status === "online") return '<span class="badge ok"><span class="dot on"></span>online</span>';
    if (status === "stale") return '<span class="badge warn">stale</span>';
    return '<span class="badge muted"><span class="dot off"></span>offline</span>';
  }

  function bar(used, limit, label) {
    if (limit == null || limit < 0) {
      return '<div class="flex items-center justify-between text-sm"><span class="text-slate-400">' + label + '</span><span class="font-medium text-brand-300">' + Tm.fmtBytes(used) + ' / unlimited</span></div>';
    }
    const pct = limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
    const cls = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";
    return (
      '<div>' +
      '<div class="flex items-center justify-between text-sm"><span class="text-slate-400">' + label + '</span>' +
      '<span class="font-medium text-slate-200">' + Tm.fmtBytes(used) + ' <span class="text-slate-500">/ ' + Tm.fmtBytes(limit) + '</span></span></div>' +
      '<div class="bar mt-2 ' + cls + '"><span style="width:' + pct + '%"></span></div>' +
      '<div class="mt-1 text-right text-xs text-slate-500">' + pct + '%</div>' +
      '</div>'
    );
  }

  async function load() {
    const user = await Tm.requireAuth("/dashboard");
    if (!user) return;

    document.getElementById("navUser").textContent = user.username + (user.role === "admin" ? " · admin" : "");
    document.getElementById("navUserMobile").textContent = "Signed in as " + user.username + (user.role === "admin" ? " (admin)" : "");
    document.getElementById("headerBase").textContent = user.baseUrl;

    const [tunnels, usageRes, routes, tokens, sessions] = await Promise.all([
      Tm.api.get("/api/v1/me/tunnels"),
      Tm.api.get("/api/v1/me/usage"),
      Tm.api.get("/api/v1/me/routes"),
      Tm.api.get("/api/v1/tokens"),
      Tm.api.get("/api/v1/sessions"),
    ]);

    const liveCount = tunnels.tunnels.filter((t) => t.status === "online").length;
    const maxT = user.maxTunnels < 0 ? "∞" : user.maxTunnels;
    document.getElementById("kpis").innerHTML =
      '<div class="card p-5"><div class="text-2xl font-bold text-white">' + liveCount + ' <span class="text-base font-normal text-slate-500">/ ' + maxT + '</span></div><div class="mt-1 text-xs text-slate-500">live tunnels</div></div>' +
      '<div class="card p-5"><div class="text-2xl font-bold text-white">' + routes.routes.length + ' <span class="text-base font-normal text-slate-500">/ 3</span></div><div class="mt-1 text-xs text-slate-500">route slots allocated</div></div>' +
      '<div class="card p-5"><div class="text-2xl font-bold text-white">' + Tm.fmtBytes(usageRes.usage.uploadUsed) + '</div><div class="mt-1 text-xs text-slate-500">uploaded today</div></div>' +
      '<div class="card p-5"><div class="text-2xl font-bold text-white">' + tokens.tokens.length + '</div><div class="mt-1 text-xs text-slate-500">active API tokens</div></div>';

    const rows = tunnels.tunnels.slice(0, 20);
    document.getElementById("tunnelRows").innerHTML = rows.length
      ? rows.map((t) =>
          "<tr>" +
          '<td><span class="code">' + esc(t.routePath) + "</span></td>" +
          '<td class="text-slate-400">' + esc(t.label || "—") + (t.anonymous ? ' <span class="badge muted">anon</span>' : "") + "</td>" +
          "<td>" + statusBadge(t.status) + "</td>" +
          '<td class="text-slate-400">' + (t.uptimeSeconds != null ? Tm.fmtUptime(t.uptimeSeconds) : "—") + "</td>" +
          '<td class="text-xs text-slate-400">↑ ' + Tm.fmtBytes(t.upBytes) + " · ↓ " + Tm.fmtBytes(t.downBytes) + "</td>" +
          '<td class="text-right">' + (t.status === "online" ? '<button class="btn-danger" data-stop="' + esc(t.id) + '">Stop</button>' : "") + "</td>" +
          "</tr>"
        ).join("")
      : '<tr><td colspan="6" class="py-6 text-center text-slate-500">No tunnels yet. Run <span class="code">tmin http 3000</span> on your machine.</td></tr>';

    document.getElementById("usageBox").innerHTML =
      bar(usageRes.usage.uploadUsed, usageRes.usage.uploadLimit, "Upload (public → local)") +
      bar(usageRes.usage.downloadUsed, usageRes.usage.downloadLimit, "Download (local → public)") +
      '<div class="border-t border-white/10 pt-3 text-xs text-slate-500">Quota period resets at ' + esc(usageRes.usage.periodEnd) + " UTC · warnings at " + (usageRes.warnPercent || 80) + "%</div>";

    const routeHtml = routes.routes.map((r) =>
      '<div class="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3">' +
      '<div class="min-w-0"><div class="truncate"><span class="code">' + esc(r.path) + "</span></div>" +
      '<div class="mt-1 text-xs text-slate-500">slot ' + r.slot + " · " + (r.online ? '<span class="text-brand-300">online</span>' : "offline") + "</div></div>" +
      '<div class="flex shrink-0 gap-2">' +
      (r.online ? "" : '<button class="btn-danger" data-release="' + esc(r.id) + '">Release</button>') +
      '<button class="btn-ghost btn-sm" data-copy-text="' + esc(r.publicUrl) + '">Copy URL</button>' +
      "</div></div>"
    ).join("");
    document.getElementById("routeBox").innerHTML =
      (routeHtml || '<p class="text-sm text-slate-500">No route slots allocated yet.</p>') +
      '<div class="border-t border-white/10 pt-3 text-xs text-slate-500">' +
      "Free slots: " + (routes.availableSlots.length ? routes.availableSlots.map((s) => "slot " + s).join(", ") : "none") +
      " — allocate with <span class='code'>tmin http 3000 --slot 2</span></div>";

    document.getElementById("tokenRows").innerHTML = tokens.tokens.length
      ? tokens.tokens.map((t) =>
          "<tr>" +
          '<td class="text-slate-200">' + esc(t.name) + "</td>" +
          '<td><span class="code">' + esc(t.prefix) + "…</span></td>" +
          '<td class="text-xs text-slate-400">' + esc(Tm.fmtDate(t.createdAt)) + "</td>" +
          '<td class="text-xs text-slate-400">' + esc(t.lastUsedAt ? Tm.fmtAgo(t.lastUsedAt) : "never") + "</td>" +
          '<td class="text-xs text-slate-400">' + (t.expiresAt ? esc(Tm.fmtDate(t.expiresAt)) : '<span class="badge muted">never</span>') + "</td>" +
          '<td class="text-right"><button class="btn-danger" data-revoke="' + esc(t.id) + '">Revoke</button></td>' +
          "</tr>"
        ).join("")
      : '<tr><td colspan="6" class="py-6 text-center text-slate-500">No tokens yet.</td></tr>';

    document.getElementById("sessionRows").innerHTML = sessions.sessions.map((s) =>
      "<tr>" +
      '<td><span class="code">' + esc(s.ip) + "</span></td>" +
      '<td class="max-w-[260px] truncate text-xs text-slate-400">' + esc(s.ua || "—") + "</td>" +
      '<td class="text-xs text-slate-400">' + esc(Tm.fmtDate(s.expiresAt)) + "</td>" +
      '<td class="text-right"><button class="btn-danger" data-revoke-session="' + esc(s.id) + '">Revoke</button></td>' +
      "</tr>"
    ).join("");

    bindRowActions();
  }

  function bindRowActions() {
    document.querySelectorAll("[data-stop]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await Tm.api.del("/api/v1/tunnels/" + b.getAttribute("data-stop")); Tm.toast("Tunnel stopped", "ok"); load(); }
        catch (e) { Tm.toast(e.message, "err"); }
      })
    );
    document.querySelectorAll("[data-release]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Release this route slot? The path frees up for re-allocation.")) return;
        try { await Tm.api.del("/api/v1/routes/" + b.getAttribute("data-release")); Tm.toast("Route released", "ok"); load(); }
        catch (e) { Tm.toast(e.message, "err"); }
      })
    );
    document.querySelectorAll("[data-revoke]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Revoke this token? Apps using it lose access immediately.")) return;
        try { await Tm.api.del("/api/v1/tokens/" + b.getAttribute("data-revoke")); Tm.toast("Token revoked", "ok"); load(); }
        catch (e) { Tm.toast(e.message, "err"); }
      })
    );
    document.querySelectorAll("[data-revoke-session]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await Tm.api.del("/api/v1/sessions/" + b.getAttribute("data-revoke-session")); Tm.toast("Session revoked", "ok"); load(); }
        catch (e) { Tm.toast(e.message, "err"); }
      })
    );
  }

  // Token creation
  const tokenForm = document.getElementById("tokenForm");
  tokenForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("tokenName").value.trim() || "web-token";
    const days = document.getElementById("tokenDays").value;
    const btn = document.getElementById("tokenCreateBtn");
    btn.disabled = true;
    btn.textContent = "Generating…";
    try {
      const body = { name };
      if (days) body.expiresInDays = Number(days);
      const r = await Tm.api.post("/api/v1/tokens", body);
      document.getElementById("tokenName").value = "";
      document.getElementById("tokenSecret").value = r.secret;
      document.getElementById("tokenSecretWrap").classList.remove("hidden");
      document.getElementById("modalSecret").value = r.secret;
      document.getElementById("secretModal").classList.remove("hidden");
      load();
    } catch (err) {
      Tm.toast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate token";
    }
  });

  const hideModal = () => {
    document.getElementById("secretModal").classList.add("hidden");
    document.getElementById("tokenSecretWrap").classList.add("hidden");
  };
  document.getElementById("modalClose").addEventListener("click", hideModal);
  document.getElementById("modalDone").addEventListener("click", hideModal);
  document.getElementById("tokenSecretClose").addEventListener("click", () => {
    document.getElementById("tokenSecretWrap").classList.add("hidden");
  });
  document.getElementById("secretModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) hideModal();
  });

  // Password change
  document.getElementById("pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("pwBtn");
    btn.disabled = true;
    try {
      await Tm.api.post("/api/v1/auth/change-password", {
        currentPassword: document.getElementById("currentPw").value,
        newPassword: document.getElementById("newPw").value,
      });
      Tm.toast("Password changed", "ok");
      document.getElementById("currentPw").value = "";
      document.getElementById("newPw").value = "";
    } catch (err) {
      Tm.toast(err.message, "err");
    } finally {
      btn.disabled = false;
    }
  });

  load();
})();
