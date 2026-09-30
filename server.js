const express = require("express");
const session = require("express-session");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me-now";
const BOT_DIR = path.join(__dirname, "bots");
const BOT_ENTRY = process.env.BOT_ENTRY || "index.js";

let bot = null;
let startedAt = null;
let starts = 0;
let crashes = 0;
let logs = [];

function addLog(line) {
  const item = `[${new Date().toLocaleString()}] ${line}`;
  logs.push(item);
  if (logs.length > 300) logs.shift();
  io.emit("log", item);
}

function isRunning() {
  return !!bot && !bot.killed;
}

function safePath(base, requested) {
  const resolved = path.resolve(base, requested || ".");
  return resolved === path.resolve(base) || resolved.startsWith(path.resolve(base) + path.sep)
    ? resolved : null;
}

function auth(req,res,next) {
  if (req.session?.user) return next();
  return res.status(401).json({error:"Unauthorized"});
}

app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));
app.use(session({
  secret: process.env.SESSION_SECRET || "deo-panel-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {httpOnly:true, sameSite:"lax", secure:false, maxAge: 86400000}
}));
app.use(express.static(path.join(__dirname,"public")));

app.post("/api/login",(req,res)=>{
  const {username,password}=req.body;
  if(username===ADMIN_USER && password===ADMIN_PASS){
    req.session.user=username;
    return res.json({ok:true});
  }
  res.status(401).json({ok:false,error:"Invalid login"});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",(req,res)=>res.json({loggedIn:!!req.session?.user}));

app.get("/api/stats",auth,(req,res)=>{
  const mem=process.memoryUsage();
  const uptime=startedAt ? Math.floor((Date.now()-startedAt)/1000) : 0;
  res.json({
    running:isRunning(),
    memoryMB:Math.round(mem.rss/1024/1024),
    serverUptime:Math.floor(process.uptime()),
    botUptime:uptime,
    starts, crashes,
    node:process.version,
    files:countFiles(BOT_DIR)
  });
});

function countFiles(dir){
  let n=0;
  if(!fs.existsSync(dir)) return 0;
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    if(e.name==="node_modules") continue;
    const p=path.join(dir,e.name);
    n += e.isDirectory()?countFiles(p):1;
  }
  return n;
}

app.get("/api/logs",auth,(req,res)=>res.json({logs}));

app.post("/api/bot/start",auth,(req,res)=>{
  if(isRunning()) return res.json({ok:true,message:"Bot already running"});
  const entry=safePath(BOT_DIR,BOT_ENTRY);
  if(!entry || !fs.existsSync(entry)) return res.status(400).json({ok:false,error:`Missing bots/${BOT_ENTRY}`});

  bot=spawn(process.execPath,[entry],{
    cwd:BOT_DIR,
    env:{...process.env,NODE_ENV:"production"},
    stdio:["ignore","pipe","pipe"]
  });
  starts++;
  startedAt=Date.now();
  addLog(`BOT STARTED (PID ${bot.pid})`);

  bot.stdout.on("data",d=>addLog(String(d).trim()));
  bot.stderr.on("data",d=>addLog("ERR: "+String(d).trim()));
  bot.on("exit",(code,signal)=>{
    addLog(`BOT EXITED code=${code} signal=${signal||"none"}`);
    if(code!==0) crashes++;
    bot=null; startedAt=null;
    io.emit("status");
  });
  io.emit("status");
  res.json({ok:true});
});

app.post("/api/bot/stop",auth,(req,res)=>{
  if(!isRunning()) return res.json({ok:true,message:"Bot is not running"});
  bot.kill("SIGTERM");
  addLog("STOP requested");
  res.json({ok:true});
});

app.post("/api/bot/restart",auth,(req,res)=>{
  if(isRunning()) bot.kill("SIGTERM");
  setTimeout(()=>{
    const entry=safePath(BOT_DIR,BOT_ENTRY);
    if(!entry || !fs.existsSync(entry)) return;
    bot=spawn(process.execPath,[entry],{cwd:BOT_DIR,env:{...process.env,NODE_ENV:"production"},stdio:["ignore","pipe","pipe"]});
    starts++; startedAt=Date.now(); addLog(`BOT RESTARTED (PID ${bot.pid})`);
    bot.stdout.on("data",d=>addLog(String(d).trim()));
    bot.stderr.on("data",d=>addLog("ERR: "+String(d).trim()));
    bot.on("exit",(code,signal)=>{addLog(`BOT EXITED code=${code} signal=${signal||"none"}`);if(code!==0)crashes++;bot=null;startedAt=null;io.emit("status");});
  },800);
  res.json({ok:true});
});

app.get("/api/files",auth,(req,res)=>{
  const dir=safePath(BOT_DIR,req.query.path||".");
  if(!dir || !fs.existsSync(dir)) return res.status(400).json({error:"Invalid path"});
  const items=fs.readdirSync(dir,{withFileTypes:true}).map(x=>({name:x.name,type:x.isDirectory()?"dir":"file"}));
  res.json({path:req.query.path||".",items});
});

app.get("/api/file",auth,(req,res)=>{
  const p=safePath(BOT_DIR,req.query.path);
  if(!p || !fs.existsSync(p) || !fs.statSync(p).isFile()) return res.status(404).json({error:"File not found"});
  if(fs.statSync(p).size>1024*1024) return res.status(413).json({error:"File too large"});
  res.type("text/plain").send(fs.readFileSync(p,"utf8"));
});

app.put("/api/file",auth,(req,res)=>{
  const p=safePath(BOT_DIR,req.body.path);
  if(!p) return res.status(400).json({error:"Invalid path"});
  fs.mkdirSync(path.dirname(p),{recursive:true});
  fs.writeFileSync(p,String(req.body.content||""));
  addLog(`FILE SAVED: ${req.body.path}`);
  res.json({ok:true});
});

io.on("connection",socket=>{
  socket.emit("status",{running:isRunning()});
  socket.emit("logs",logs);
});

app.get("*",(req,res)=>{
  if(req.path.startsWith("/api/")) return res.status(404).end();
  res.sendFile(path.join(__dirname,"public","index.html"));
});

server.listen(PORT,()=>console.log(`Deo Bot Panel running on port ${PORT}`));
