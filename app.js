const $=id=>document.getElementById(id);
async function api(url,opt={}){const r=await fetch(url,{headers:{"Content-Type":"application/json"},...opt});if(r.status===401){showLogin();throw Error("login")}const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||"Request failed");return j}
async function login(){try{await api("/api/login",{method:"POST",body:JSON.stringify({username:$("user").value,password:$("pass").value})});showApp()}catch(e){$("loginmsg").textContent="❌ "+e.message}}
async function logout(){await api("/api/logout",{method:"POST"});showLogin()}
function showLogin(){$("login").classList.remove("hidden");$("app").classList.add("hidden")}
function showApp(){$("login").classList.add("hidden");$("app").classList.remove("hidden");refresh();loadFiles()}
async function refresh(){try{const s=await api("/api/stats");$("memory").textContent=s.memoryMB+" MB";$("files").textContent=s.files;$("starts").textContent=s.starts;$("crashes").textContent=s.crashes;$("node").textContent=s.node;$("uptime").textContent=fmt(s.serverUptime);$("botup").textContent=fmt(s.botUptime);$("status").textContent=s.running?"🟢 চালু":"🔴 বন্ধ"}catch(e){}}
function fmt(sec){let h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;return h?`${h}h ${m}m`:m?`${m}m ${s}s`:`${s}s`}
async function action(a){try{await api("/api/bot/"+a,{method:"POST"});refresh()}catch(e){alert(e.message)}}
async function loadFiles(){try{const j=await api("/api/files");$("filesbox").innerHTML=j.items.map(x=>`<div class="file"><span>${x.type==="dir"?"📁":"📄"} ${x.name}</span>${x.type==="file"?`<button onclick="edit('${encodeURIComponent(x.name)}')">Edit</button>`:""}</div>`).join("")}catch(e){}}
async function edit(name){const p=decodeURIComponent(name);try{const r=await api("/api/file?path="+encodeURIComponent(p));const c=prompt("Edit "+p,r);if(c!==null){await api("/api/file",{method:"PUT",body:JSON.stringify({path:p,content:c})});alert("Saved")}}catch(e){alert(e.message)}}
const socket=io();socket.on("logs",x=>{$("logs").textContent=x.join("\\n");$("logs").scrollTop=$("logs").scrollHeight});socket.on("log",x=>{$("logs").textContent+="\\n"+x;$("logs").scrollTop=$("logs").scrollHeight});socket.on("status",refresh);
setInterval(refresh,3000);
api("/api/me").then(x=>x.loggedIn?showApp():showLogin()).catch(showLogin);
