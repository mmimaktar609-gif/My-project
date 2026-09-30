const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const BOTS = path.join(DATA, "bots");

fs.mkdirSync(BOTS, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

const processes = new Map();

function safeName(name) {
  return String(name || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}

function botDir(name) {
  return path.join(BOTS, safeName(name));
}

function botMeta(name) {
  return path.join(botDir(name), "bot.json");
}

function readBots() {
  const result = [];
  for (const name of fs.readdirSync(BOTS)) {
    const dir = botDir(name);
    if (!fs.statSync(dir).isDirectory()) continue;
    let meta = { name, command: "node index.js" };
    try { meta = { ...meta, ...JSON.parse(fs.readFileSync(botMeta(name), "utf8")) }; } catch {}
    result.push({
      name,
      command: meta.command,
      status: processes.has(name) ? "running" : "stopped",
      pid: processes.get(name)?.pid || null
    });
  }
  return result;
}

function appendLog(name, text) {
  const dir = botDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "console.log"), text);
}

function startBot(name) {
  name = safeName(name);
  const dir = botDir(name);
  if (!name || !fs.existsSync(dir)) throw new Error("Bot not found");
  if (processes.has(name)) return;

  let meta = { command: "node index.js" };
  try { meta = { ...meta, ...JSON.parse(fs.readFileSync(botMeta(name), "utf8")) }; } catch {}

  const parts = String(meta.command).match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const command = (parts.shift() || "node").replace(/^"|"$/g, "");
  const args = parts.map(x => x.replace(/^"|"$/g, ""));

  appendLog(name, `\n[${new Date().toISOString()}] START ${meta.command}\n`);

  const child = spawn(command, args, {
    cwd: dir,
    env: { ...process.env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  processes.set(name, child);

  child.stdout.on("data", d => appendLog(name, d.toString()));
  child.stderr.on("data", d => appendLog(name, `[ERR] ${d.toString()}`));
  child.on("close", code => {
    appendLog(name, `[${new Date().toISOString()}] EXIT code=${code}\n`);
    processes.delete(name);
  });
  child.on("error", err => {
    appendLog(name, `[SPAWN ERROR] ${err.message}\n`);
    processes.delete(name);
  });
}

function stopBot(name) {
  name = safeName(name);
  const child = processes.get(name);
  if (!child) return false;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (processes.get(name) === child) child.kill("SIGKILL");
  }, 5000);
  return true;
}

app.get("/api/bots", (req, res) => res.json(readBots()));

app.post("/api/bots", (req, res) => {
  const name = safeName(req.body.name);
  const command = String(req.body.command || "node index.js").trim();
  if (!name) return res.status(400).json({ error: "Valid bot name required" });
  if (!/^[\w./ -]+$/.test(command) || command.includes("&&") || command.includes(";") || command.includes("|"))
    return res.status(400).json({ error: "Unsafe command format" });

  const dir = botDir(name);
  if (fs.existsSync(dir)) return res.status(409).json({ error: "Bot already exists" });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(botMeta(name), JSON.stringify({ name, command }, null, 2));
  fs.writeFileSync(path.join(dir, "index.js"),
`console.log("Bot ${name} started");\nsetInterval(() => console.log("${name}: running"), 30000);\n`);
  res.json({ ok: true, name });
});

app.post("/api/bots/:name/start", (req, res) => {
  try { startBot(req.params.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/bots/:name/stop", (req, res) => {
  res.json({ ok: stopBot(req.params.name) });
});

app.post("/api/bots/:name/restart", (req, res) => {
  try {
    stopBot(req.params.name);
    setTimeout(() => { try { startBot(req.params.name); } catch {} }, 800);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/bots/:name", (req, res) => {
  const name = safeName(req.params.name);
  if (processes.has(name)) stopBot(name);
  const dir = botDir(name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: "Bot not found" });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

app.get("/api/bots/:name/logs", (req, res) => {
  const name = safeName(req.params.name);
  const file = path.join(botDir(name), "console.log");
  if (!fs.existsSync(file)) return res.json({ logs: "" });
  let logs = fs.readFileSync(file, "utf8");
  if (logs.length > 20000) logs = logs.slice(-20000);
  res.json({ logs });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`HRIDOY BOT PANEL V2 running on port ${PORT}`);
});
