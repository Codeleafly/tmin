/** Server-rendered UI: landing, auth, dashboard, admin, docs. No build step, no CDN. */

function layout(title: string, body: string, extra = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · tmin</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:#111;background:#fafafa}
nav{background:#111;color:#fff;padding:10px 18px;display:flex;gap:16px;align-items:center}nav a{color:#fff;text-decoration:none;font-size:14px}nav a.b{font-weight:700;font-size:16px}
main{max-width:960px;margin:24px auto;padding:0 18px}.card{background:#fff;border:1px solid #e3e3e3;border-radius:10px;padding:16px;margin:12px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid #eee}
code{background:#f1f1f1;padding:2px 6px;border-radius:4px;font-size:13px}pre{background:#111;color:#d6f5d6;padding:12px;border-radius:8px;overflow:auto;font-size:13px}
button,.btn{background:#111;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:14px;text-decoration:none;display:inline-block}
input,select{padding:8px;border:1px solid #ccc;border-radius:8px;font-size:14px;width:100%;margin:4px 0 10px}
label{font-size:13px;color:#444}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.kpi{font-size:22px;font-weight:700}.muted{color:#666;font-size:13px}.err{color:#a00}.ok{color:#0a6}
@media(prefers-color-scheme:dark){body{background:#0d0d0d;color:#eee}.card{background:#161616;border-color:#333}code{background:#222}input,select{background:#222;color:#eee;border-color:#444}}
</style></head><body><nav><a class="b" href="/">tmin</a><a href="/dashboard">Dashboard</a><a href="/admin">Admin</a><a href="/docs">Docs</a><a href="/openapi.json">OpenAPI</a></nav><main>${body}</main><script>${extra}</script></body></html>`;
}

export function landingPage(baseUrl: string, anonTtlSeconds = 1800): string {
  const ttlMin = Math.max(1, Math.round(anonTtlSeconds / 60));
  return layout("Self-hosted tunnels", `
<h1>Expose localhost to the internet — on your own server.</h1>
<p>tmin is a complete self-hosted tunneling platform: permanent <code>/username</code> URLs, 3 tunnel slots, anonymous short-lived links, quotas, dashboards and a documented REST API.</p>
<div class="card"><h3>Quick start</h3><pre>tmin http 3000 --anonymous
# → https://YOUR-SERVER/a-xxxxxx  (expires in ${ttlMin} min)

tmin login
tmin http 3000
# → ${baseUrl}/&lt;you&gt;  (permanent)</pre></div>
<div class="grid">
<div class="card"><div class="kpi">${anonTtlSeconds}s</div><div class="muted">anonymous session TTL (server-enforced)</div></div>
<div class="card"><div class="kpi">3 slots</div><div class="muted">/you · /you/2 · /you/3</div></div>
<div class="card"><div class="kpi">1 GB/day</div><div class="muted">default free bandwidth quota</div></div>
</div>
<p><a class="btn" href="/register">Create account</a> <a class="btn" href="/docs">Read docs</a></p>`);
}

export function loginPage(): string {
  return layout("Login", `
<h1>Login</h1><div class="card"><label>Username or email<input id="l" autocomplete="username"></label>
<label>Password<input id="p" type="password" autocomplete="current-password"></label>
<button onclick="go()">Login</button> <span id="e" class="err"></span>
<p class="muted">No account? <a href="/register">Register</a> · <a href="/docs#auth">Password reset</a></p></div>`,
`async function go(){const r=await fetch('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:l.value,password:p.value})});if(r.ok)location.href='/dashboard';else e.textContent=(await r.json()).error.message}`);
}

export function registerPage(): string {
  return layout("Register", `
<h1>Create account</h1><div class="card"><label>Username (3–32 chars, a–z 0–9 - _)<input id="u"></label>
<label>Email<input id="e2" type="email"></label><label>Password (min 8)<input id="p" type="password"></label>
<button onclick="go()">Register</button> <span id="e" class="err"></span></div>`,
`async function go(){const r=await fetch('/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u.value,email:e2.value,password:p.value})});const j=await r.json();if(r.ok){const l=await fetch('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:u.value,password:p.value})});if(l.ok)location.href='/dashboard';}else e.textContent=j.error.message}`);
}

export function dashboardPage(): string {
  return layout("Dashboard", `
<h1>Dashboard</h1><div id="me" class="card">Loading…</div>
<h2>Tunnels</h2><div id="t" class="card">Loading…</div>
<h2>Usage (today)</h2><div id="u" class="card">Loading…</div>
<h2>Routes</h2><div id="r" class="card">Loading…</div>
<h2>API tokens</h2><div class="card"><input id="tn" placeholder="token name (e.g. laptop-cli)"><button onclick="mk()">Create token</button><pre id="ts"></pre><div id="tl"></div></div>
<h2>Sessions</h2><div id="s" class="card">Loading…</div>
<h2>Account</h2><div class="card"><label>Current password<input id="cp" type="password"></label><label>New password<input id="np" type="password"></label><button onclick="ch()">Change password</button> <span id="ce"></span><br><br><button onclick="logout()">Logout</button></div>`,
`const J=r=>r.json();
async function load(){let m=await fetch('/api/v1/me');if(!m.ok){location.href='/login';return}
let me=(await m.json()).user;document.getElementById('me').innerHTML='<b>'+me.username+'</b> · '+me.role+' · <code>'+me.baseUrl+'</code><br><span class=muted>max '+me.maxTunnels+' tunnels</span>';
let t=await(await fetch('/api/v1/me/tunnels')).json();
document.getElementById('t').innerHTML=t.tunnels.length?t.tunnels.map(x=>'<div><code>'+x.routePath+'</code> → '+x.label+' · <b class='+(x.status==='online'?'ok':'err')+'>'+x.status+'</b> · up '+(x.uptimeSeconds??'-')+'s · ↓'+x.downBytes+'B ↑'+x.upBytes+'B '+(x.status==='online'? '<button onclick="stopT(\\''+x.id+'\\')">Stop</button>':'')+'</div>').join(''):'<span class=muted>No tunnels yet. Run <code>tmin http 3000</code></span>';
let u=await(await fetch('/api/v1/me/usage')).json();
document.getElementById('u').innerHTML='↑ '+u.usage.uploadUsed+' / '+lim(u.usage.uploadLimit)+' B &nbsp; ↓ '+u.usage.downloadUsed+' / '+lim(u.usage.downloadLimit)+' B<br><span class=muted>resets '+u.usage.periodEnd+'</span>';
let r=await(await fetch('/api/v1/me/routes')).json();
document.getElementById('r').innerHTML=r.routes.map(x=>'<div><code>'+x.path+'</code> '+(x.online?'<b class=ok>online</b>':'<span class=muted>offline</span>')+' <button onclick="rel(\\''+x.id+'\\')">Release</button></div>').join('')+'<div class=muted>Free slots: '+(r.availableSlots.join(', ')||'none')+'</div>';
let tl=await(await fetch('/api/v1/tokens')).json();
document.getElementById('tl').innerHTML=tl.tokens.map(x=>'<div><code>'+x.prefix+'…</code> '+x.name+' <button onclick="rev(\\''+x.id+'\\')">Revoke</button></div>').join('')||'<span class=muted>No tokens</span>';
let s=await(await fetch('/api/v1/sessions')).json();
document.getElementById('s').innerHTML=s.sessions.map(x=>'<div><code>'+x.id+'</code> '+x.ip+' <button onclick="revs(\\''+x.id+'\\')">Revoke</button></div>').join('');}
function lim(v){return v<0?'∞':v}
async function stopT(id){await fetch('/api/v1/tunnels/'+id,{method:'DELETE'});load()}
async function rel(id){if(!confirm('Release this route?'))return;let r=await fetch('/api/v1/routes/'+id,{method:'DELETE'});if(!r.ok)alert((await r.json()).error.message);load()}
async function mk(){let r=await fetch('/api/v1/tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:tn.value})});let j=await r.json();ts.textContent=r.ok?'SECRET (copy now): '+j.secret:'ERR '+j.error.message;if(r.ok)load()}
async function rev(id){await fetch('/api/v1/tokens/'+id,{method:'DELETE'});load()}
async function revs(id){await fetch('/api/v1/sessions/'+id,{method:'DELETE'});load()}
async function ch(){let r=await fetch('/api/v1/auth/change-password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({currentPassword:cp.value,newPassword:np.value})});ce.textContent=r.ok?'Changed':(await r.json()).error.message}
async function logout(){await fetch('/api/v1/auth/logout',{method:'POST'});location.href='/'}
load()`);
}

export function adminPage(): string {
  return layout("Admin", `
<h1>Administration</h1><div id="h" class="card">Loading…</div>
<h2>Users</h2><div class="card"><input id="q" placeholder="search…"><button onclick="lu()">Search</button><div id="u"></div></div>
<h2>Live tunnels</h2><div id="t" class="card">Loading…</div>
<h2>Anonymous sessions</h2><div id="a" class="card">Loading…</div>
<h2>Global quotas</h2><div class="card"><label>Max tunnels<input id="qt" type="number"></label><label>Upload bytes/day<input id="qu" type="number"></label><label>Download bytes/day<input id="qd" type="number"></label><button onclick="sq()">Save</button> <span id="qe"></span></div>
<h2>Audit log</h2><div class="card"><input id="aq" placeholder="search…"><button onclick="la()">Search</button><div id="al"></div></div>
<h2>Maintenance</h2><div class="card"><button onclick="mm(true)">Enable</button> <button onclick="mm(false)">Disable</button> <span id="me2"></span></div>`,
`async function lu(){let r=await fetch('/api/v1/admin/users?search='+encodeURIComponent(q.value));if(!r.ok){document.getElementById('u').textContent='Forbidden (admin only)';return}let j=await r.json();document.getElementById('u').innerHTML=j.data.map(x=>'<div><code>'+x.username+'</code> '+x.role+' '+x.status+' <button onclick="sus(\\''+x.id+'\\','+(x.status==='active'?'\\'suspended\\'':'\\'active\\'')+')">'+(x.status==='active'?'Suspend':'Activate')+'</button></div>').join('')}
async function sus(id,st){await fetch('/api/v1/admin/users/'+id+'/status',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({status:st})});lu()}
async function load(){let h=await fetch('/api/v1/admin/health');if(!h.ok){document.getElementById('h').textContent='Admin only — login as admin first.';return}
let j=await h.json();document.getElementById('h').innerHTML='live tunnels '+j.health.liveTunnels+' · users '+j.health.db.users+' · uptime '+j.health.uptimeSeconds+'s';
let t=await(await fetch('/api/v1/admin/tunnels')).json();document.getElementById('t').innerHTML=(t.live||[]).map(x=>'<div><code>'+x.routePath+'</code> '+x.owner+' <button onclick="kt(\\''+x.id+'\\')">Kill</button></div>').join('')||'none';
let a=await(await fetch('/api/v1/admin/anon')).json();document.getElementById('a').innerHTML=(a.sessions||[]).slice(0,20).map(x=>'<div><code>'+x.path+'</code> '+x.status+' '+x.secondsLeft+'s left '+(x.live?'live':'')+'</div>').join('');
let qq=await(await fetch('/api/v1/admin/config/quotas')).json();qt.value=qq.quotas.freeMaxConcurrentTunnels;qu.value=qq.quotas.freeUploadLimitBytes;qd.value=qq.quotas.freeDownloadLimitBytes;la()}
async function kt(id){await fetch('/api/v1/admin/tunnels/'+id,{method:'DELETE'});load()}
async function sq(){let r=await fetch('/api/v1/admin/config/quotas',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({freeMaxConcurrentTunnels:+qt.value,freeUploadLimitBytes:+qu.value,freeDownloadLimitBytes:+qd.value})});qe.textContent=r.ok?'Saved':(await r.json()).error.message}
async function la(){let r=await fetch('/api/v1/admin/audit-logs?search='+encodeURIComponent(aq.value)+'&limit=20');let j=await r.json();document.getElementById('al').innerHTML=(j.data||[]).map(x=>'<div class=muted>'+new Date(x.at).toISOString()+' '+x.actor+' '+x.action+' '+x.target+' → '+x.result+'</div>').join('')}
async function mm(on){let r=await fetch('/api/v1/admin/maintenance',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:on})});me2.textContent=r.ok?'OK':'ERR'}
lu();load()`);
}
