/* Admin page logic: users, tunnels, anon sessions, quotas, audit, maintenance. */
"use strict";

(function () {
  const esc = Tm.esc;

  function logout() {
    Tm.api.post("/api/v1/auth/logout").catch(() => {}).finally(() => location.replace("/login"));
  }
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("logoutBtnMobile").addEventListener("click", logout);

  const userState = { page: 1, limit: 20, search: "", total: 0 };
  const auditState = { page: 1, limit: 20, search: "", total: 0 };
  let me = null;

  function badge(status) {
    return status === "active"
      ? '<span class="badge ok">active</span>'
      : status === "suspended"
        ? '<span class="badge err">suspended</span>'
        : '<span class="badge muted">' + esc(status) + "</span>";
  }

  function limitsText(u) {
    const f = (n) => (n < 0 ? "∞" : String(n));
    return '<span class="text-xs text-slate-500">tunnels ' + f(u.maxTunnels) + " · ↑ " + Tm.fmtBytes(u.uploadLimit) + " · ↓ " + Tm.fmtBytes(u.downloadLimit) + "</span>";
  }

  async function loadUsers() {
    const q = new URLSearchParams({ page: String(userState.page), limit: String(userState.limit) });
    if (userState.search) q.set("search", userState.search);
    const r = await Tm.api.get("/api/v1/admin/users?" + q.toString());
    userState.total = r.total;
    document.getElementById("userRows").innerHTML = r.data.length
      ? r.data.map((u) => {
          const isSelf = me && u.id === me.id;
          return "<tr>" +
            '<td><span class="code">' + esc(u.username) + "</span>" + (isSelf ? ' <span class="badge muted">you</span>' : "") + "</td>" +
            '<td class="text-xs text-slate-400">' + esc(u.email) + "</td>" +
            '<td><span class="badge ' + (u.role === "admin" ? "warn" : "muted") + '">' + esc(u.role) + "</span></td>" +
            "<td>" + badge(u.status) + "</td>" +
            "<td>" + limitsText(u) + "</td>" +
            '<td class="text-xs text-slate-400">' + esc(Tm.fmtDate(u.createdAt)) + "</td>" +
            '<td class="text-right whitespace-nowrap">' +
            '<button class="btn-ghost btn-sm" data-ustatus="' + esc(u.id) + '" data-next="' + (u.status === "active" ? "suspended" : "active") + '">' + (u.status === "active" ? "Suspend" : "Activate") + "</button> " +
            '<button class="btn-ghost btn-sm" data-urole="' + esc(u.id) + '" data-next="' + (u.role === "admin" ? "user" : "admin") + '">' + (u.role === "admin" ? "Demote" : "Promote") + "</button> " +
            '<button class="btn-ghost btn-sm" data-ulimits="' + esc(u.id) + '">Limits</button> ' +
            '<button class="btn-ghost btn-sm" data-urename="' + esc(u.id) + '">Rename</button> ' +
            '<button class="btn-ghost btn-sm" data-ureset="' + esc(u.id) + '">Reset PW</button> ' +
            '<button class="btn-danger" data-urevoke="' + esc(u.id) + '">Revoke</button>' +
            "</td></tr>";
        }).join("")
      : '<tr><td colspan="7" class="py-6 text-center text-slate-500">No users found.</td></tr>';
    document.getElementById("userPageInfo").textContent = "Page " + r.page + " · " + r.total + " total";
    bindUserActions();
  }

  function bindUserActions() {
    const patch = async (id, sub, body, okMsg) => {
      try {
        await Tm.api.patch("/api/v1/admin/users/" + id + "/" + sub, body);
        Tm.toast(okMsg, "ok");
        loadUsers();
      } catch (e) {
        Tm.toast(e.message, "err");
      }
    };
    document.querySelectorAll("[data-ustatus]").forEach((b) =>
      b.addEventListener("click", () => patch(b.getAttribute("data-ustatus"), "status", { status: b.getAttribute("data-next") }, "Status updated"))
    );
    document.querySelectorAll("[data-urole]").forEach((b) =>
      b.addEventListener("click", () => patch(b.getAttribute("data-urole"), "role", { role: b.getAttribute("data-next") }, "Role updated"))
    );
    document.querySelectorAll("[data-ulimits]").forEach((b) =>
      b.addEventListener("click", () => {
        const up = prompt("Upload limit bytes/day (-1 = unlimited, 0 = plan default):", "0");
        if (up === null) return;
        const down = prompt("Download limit bytes/day (-1 = unlimited, 0 = plan default):", "0");
        if (down === null) return;
        const mt = prompt("Max concurrent tunnels (-1 = unlimited, 0 = plan default):", "0");
        if (mt === null) return;
        patch(b.getAttribute("data-ulimits"), "limits", { uploadLimit: Number(up), downloadLimit: Number(down), maxTunnels: Number(mt) }, "Limits updated");
      })
    );
    document.querySelectorAll("[data-urename]").forEach((b) =>
      b.addEventListener("click", () => {
        const username = prompt("New username (routes follow; requires no live tunnels):");
        if (!username) return;
        patch(b.getAttribute("data-urename"), "username", { username }, "Username updated");
      })
    );
    document.querySelectorAll("[data-ureset]").forEach((b) =>
      b.addEventListener("click", () => {
        const pw = prompt("New password (revokes their sessions):");
        if (!pw) return;
        patch(b.getAttribute("data-ureset"), "reset-password", { newPassword: pw }, "Password reset");
      })
    );
    document.querySelectorAll("[data-urevoke]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Revoke all sessions AND tokens for this user?")) return;
        try {
          await Tm.api.post("/api/v1/admin/users/" + b.getAttribute("data-urevoke") + "/revoke-sessions", {});
          Tm.toast("Sessions revoked", "ok");
          loadUsers();
        } catch (e) {
          Tm.toast(e.message, "err");
        }
      })
    );
  }

  async function loadTunnels() {
    const r = await Tm.api.get("/api/v1/admin/tunnels");
    document.getElementById("tunnelRows").innerHTML = r.live.length
      ? r.live.map((t) =>
          "<tr>" +
          '<td><span class="code">' + esc(t.routePath) + "</span></td>" +
          "<td>" + esc(t.owner) + (t.anonymous ? ' <span class="badge muted">anon</span>' : "") + "</td>" +
          '<td class="text-slate-400">' + t.slot + "</td>" +
          '<td class="text-slate-400">' + esc(Tm.fmtUptime(Math.floor((Date.now() - t.connectedAt) / 1000))) + "</td>" +
          '<td class="text-xs text-slate-400">↑ ' + Tm.fmtBytes(t.upBytes) + " · ↓ " + Tm.fmtBytes(t.downBytes) + " · " + t.inFlight + " in flight</td>" +
          '<td class="text-right"><button class="btn-danger" data-kill="' + esc(t.id) + '">Kill</button></td>' +
          "</tr>"
        ).join("")
      : '<tr><td colspan="6" class="py-6 text-center text-slate-500">No live tunnels.</td></tr>';
    document.querySelectorAll("[data-kill]").forEach((b) =>
      b.addEventListener("click", async () => {
        try { await Tm.api.del("/api/v1/admin/tunnels/" + b.getAttribute("data-kill")); Tm.toast("Tunnel killed", "ok"); refreshLive(); }
        catch (e) { Tm.toast(e.message, "err"); }
      })
    );
  }

  async function loadAnon() {
    const r = await Tm.api.get("/api/v1/admin/anon");
    document.getElementById("anonRows").innerHTML = r.sessions.length
      ? r.sessions.slice(0, 20).map((s) =>
          "<tr>" +
          '<td><span class="code">' + esc(s.path) + "</span></td>" +
          "<td>" + (s.status === "active" ? '<span class="badge ok">active</span>' : '<span class="badge muted">' + esc(s.status) + "</span>") + "</td>" +
          '<td class="text-slate-400">' + s.secondsLeft + "s</td>" +
          '<td class="text-slate-400">' + (s.live ? '<span class="dot on"></span> live' : '<span class="dot off"></span> off') + "</td>" +
          '<td class="text-xs text-slate-400">' + esc(Tm.fmtAgo(s.createdAt)) + "</td>" +
          "</tr>"
        ).join("")
      : '<tr><td colspan="5" class="py-6 text-center text-slate-500">No anonymous sessions.</td></tr>';
  }

  async function loadHealth() {
    const r = await Tm.api.get("/api/v1/admin/health");
    const h = r.health;
    const m = await Tm.api.get("/api/v1/admin/metrics");
    const met = m.metrics;
    document.getElementById("kpis").innerHTML =
      '<div class="card p-5"><div class="text-2xl font-bold text-white">' + met.liveTunnels + '</div><div class="mt-1 text-xs text-slate-500">live tunnels</div></div>' +
      '<div class="card p-5"><div class="text-2xl font-bold text-white">' + h.db.users + '</div><div class="mt-1 text-xs text-slate-500">registered users</div></div>' +
      '<div class="card p-5"><div class="text-2xl font-bold text-white">' + met.activeAnon + '</div><div class="mt-1 text-xs text-slate-500">active anonymous sessions</div></div>' +
      '<div class="card p-5"><div class="text-2xl font-bold text-white">' + esc(Tm.fmtUptime(met.uptimeSeconds)) + '</div><div class="mt-1 text-xs text-slate-500">uptime · avg ' + met.avgLatencyMs + 'ms · err ' + (met.errorRate * 100).toFixed(2) + '%</div></div>';
    const maint = document.getElementById("maintState");
    maint.textContent = h.maintenanceMode ? "on" : "off";
    maint.className = "badge " + (h.maintenanceMode ? "warn" : "muted");
  }

  async function loadQuotas() {
    const r = await Tm.api.get("/api/v1/admin/config/quotas");
    document.getElementById("qTunnels").value = r.quotas.freeMaxConcurrentTunnels;
    document.getElementById("qUp").value = r.quotas.freeUploadLimitBytes;
    document.getElementById("qDown").value = r.quotas.freeDownloadLimitBytes;
    document.getElementById("qTtl").value = r.quotas.anonymousTtlSeconds;
    document.getElementById("qWarn").value = r.quotas.usageWarnPercent;
  }

  async function loadAudit() {
    const q = new URLSearchParams({ page: String(auditState.page), limit: String(auditState.limit) });
    if (auditState.search) q.set("search", auditState.search);
    const r = await Tm.api.get("/api/v1/admin/audit-logs?" + q.toString());
    auditState.total = r.total;
    document.getElementById("auditRows").innerHTML = r.data.length
      ? r.data.map((a) =>
          "<tr>" +
          '<td class="whitespace-nowrap text-xs text-slate-400">' + esc(Tm.fmtDate(a.at)) + "</td>" +
          '<td class="text-slate-300">' + esc(a.actor) + "</td>" +
          '<td><span class="code">' + esc(a.action) + "</span></td>" +
          '<td class="max-w-[260px] truncate text-xs text-slate-400">' + esc(a.target) + "</td>" +
          "<td>" + (a.result === "ok" ? '<span class="badge ok">ok</span>' : a.result === "denied" ? '<span class="badge err">denied</span>' : '<span class="badge muted">' + esc(a.result) + "</span>") + "</td>" +
          "</tr>"
        ).join("")
      : '<tr><td colspan="5" class="py-6 text-center text-slate-500">No audit entries.</td></tr>';
    document.getElementById("auditPageInfo").textContent = "Page " + r.page + " · " + r.total + " total";
  }

  function refreshLive() {
    loadTunnels().catch((e) => Tm.toast(e.message, "err"));
    loadAnon().catch(() => {});
    loadHealth().catch(() => {});
  }

  async function load() {
    me = await Tm.me();
    if (!me) {
      location.replace("/login?next=" + encodeURIComponent("/admin"));
      return;
    }
    document.getElementById("navUser").textContent = me.username + " · admin";
    try {
      await Tm.api.get("/api/v1/admin/health");
    } catch (e) {
      document.getElementById("denied").classList.remove("hidden");
      document.getElementById("deniedMsg").textContent = e.code === "NOT_AUTHENTICATED"
        ? "You are not logged in. Log in with an admin account first."
        : "This account does not have administrator rights.";
      return;
    }
    document.getElementById("panel").classList.remove("hidden");
    await Promise.all([loadUsers(), loadTunnels(), loadAnon(), loadHealth(), loadQuotas(), loadAudit()]);
    setInterval(refreshLive, 15000);
  }

  // Search & pagination
  document.getElementById("userSearchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    userState.search = document.getElementById("userSearch").value.trim();
    userState.page = 1;
    loadUsers().catch((err) => Tm.toast(err.message, "err"));
  });
  document.getElementById("userPrev").addEventListener("click", () => {
    if (userState.page > 1) { userState.page--; loadUsers().catch((err) => Tm.toast(err.message, "err")); }
  });
  document.getElementById("userNext").addEventListener("click", () => {
    if (userState.page * userState.limit < userState.total) { userState.page++; loadUsers().catch((err) => Tm.toast(err.message, "err")); }
  });
  document.getElementById("auditSearchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    auditState.search = document.getElementById("auditSearch").value.trim();
    auditState.page = 1;
    loadAudit().catch((err) => Tm.toast(err.message, "err"));
  });
  document.getElementById("auditPrev").addEventListener("click", () => {
    if (auditState.page > 1) { auditState.page--; loadAudit().catch((err) => Tm.toast(err.message, "err")); }
  });
  document.getElementById("auditNext").addEventListener("click", () => {
    if (auditState.page * auditState.limit < auditState.total) { auditState.page++; loadAudit().catch((err) => Tm.toast(err.message, "err")); }
  });

  // Quotas
  document.getElementById("quotaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await Tm.api.patch("/api/v1/admin/config/quotas", {
        freeMaxConcurrentTunnels: Number(document.getElementById("qTunnels").value),
        freeUploadLimitBytes: Number(document.getElementById("qUp").value),
        freeDownloadLimitBytes: Number(document.getElementById("qDown").value),
        anonymousTtlSeconds: Number(document.getElementById("qTtl").value),
        usageWarnPercent: Number(document.getElementById("qWarn").value),
      });
      Tm.toast("Quotas updated (runtime only)", "ok");
      loadQuotas();
    } catch (err) {
      Tm.toast(err.message, "err");
    }
  });

  // Maintenance
  document.getElementById("maintToggle").addEventListener("click", async () => {
    const on = document.getElementById("maintState").textContent !== "on";
    if (on && !confirm("Enable maintenance mode? Public tunnel traffic will return 503.")) return;
    try {
      await Tm.api.post("/api/v1/admin/maintenance", { enabled: on });
      Tm.toast(on ? "Maintenance mode enabled" : "Maintenance mode disabled", "ok");
      loadHealth();
    } catch (e) {
      Tm.toast(e.message, "err");
    }
  });

  load();
})();
