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

/* =========================
   HELPERS
========================= */

function safeName(name) {
  return String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40);
}

function botDir(name) {
  return path.join(BOTS, safeName(name));
}

function botMeta(name) {
  return path.join(botDir(name), "bot.json");
}

function readMeta(name) {
  const file = botMeta(name);

  let meta = {
    name: safeName(name),
    command: "node index.js"
  };

  try {
    if (fs.existsSync(file)) {
      meta = {
        ...meta,
        ...JSON.parse(fs.readFileSync(file, "utf8"))
      };
    }
  } catch (e) {}

  return meta;
}

function appendLog(name, text) {
  const dir = botDir(name);

  fs.mkdirSync(dir, { recursive: true });

  fs.appendFileSync(
    path.join(dir, "console.log"),
    String(text)
  );
}

function parseCommand(command) {
  const parts =
    String(command)
      .match(/(?:[^\s"]+|"[^"]*")+/g) || [];

  const executable =
    (parts.shift() || "node")
      .replace(/^"|"$/g, "");

  const args = parts.map(x =>
    x.replace(/^"|"$/g, "")
  );

  return {
    executable,
    args
  };
}

/* =========================
   BOT LIST
========================= */

function readBots() {
  const result = [];

  for (const name of fs.readdirSync(BOTS)) {
    const dir = botDir(name);

    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const meta = readMeta(name);
    const processInfo = processes.get(name);

    result.push({
      name: safeName(name),
      command: meta.command,
      status: processInfo ? "running" : "stopped",
      pid: processInfo?.pid || null
    });
  }

  return result;
}

/* =========================
   START BOT
========================= */

function startBot(name) {
  name = safeName(name);

  if (!name) {
    throw new Error("Invalid bot name");
  }

  const dir = botDir(name);

  if (!fs.existsSync(dir)) {
    throw new Error("Bot not found");
  }

  if (processes.has(name)) {
    return false;
  }

  const meta = readMeta(name);
  const parsed = parseCommand(meta.command);

  appendLog(
    name,
    `\n\n========== START ==========\n`
  );

  appendLog(
    name,
    `[${new Date().toISOString()}] ${meta.command}\n`
  );

  const child = spawn(
    parsed.executable,
    parsed.args,
    {
      cwd: dir,
      env: {
        ...process.env
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  processes.set(name, child);

  appendLog(
    name,
    `[PID] ${child.pid}\n`
  );

  child.stdout.on("data", data => {
    appendLog(name, data.toString());
  });

  child.stderr.on("data", data => {
    appendLog(
      name,
      `[ERROR] ${data.toString()}`
    );
  });

  child.on("error", error => {
    appendLog(
      name,
      `\n[SPAWN ERROR] ${error.message}\n`
    );

    processes.delete(name);
  });

  child.on("close", code => {
    appendLog(
      name,
      `\n[${new Date().toISOString()}] EXIT code=${code}\n`
    );

    processes.delete(name);
  });

  return true;
}

/* =========================
   STOP BOT
========================= */

function stopBot(name) {
  name = safeName(name);

  const child = processes.get(name);

  if (!child) {
    return false;
  }

  appendLog(
    name,
    `\n[${new Date().toISOString()}] STOP requested\n`
  );

  try {
    child.kill("SIGTERM");
  } catch {}

  setTimeout(() => {
    if (processes.get(name) === child) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }, 5000);

  return true;
}

/* =========================
   WAIT UNTIL STOPPED
========================= */

function waitUntilStopped(name, timeout = 7000) {
  return new Promise(resolve => {
    const start = Date.now();

    const check = () => {
      if (!processes.has(name)) {
        resolve();
        return;
      }

      if (Date.now() - start >= timeout) {
        resolve();
        return;
      }

      setTimeout(check, 200);
    };

    check();
  });
}

/* =========================
   API - BOT LIST
========================= */

app.get("/api/bots", (req, res) => {
  res.json(readBots());
});

/* =========================
   API - CREATE BOT
========================= */

app.post("/api/bots", (req, res) => {
  try {
    const name = safeName(req.body.name);

    const command = String(
      req.body.command || "node index.js"
    ).trim();

    if (!name) {
      return res.status(400).json({
        error: "Valid bot name required"
      });
    }

    if (!/^[\w./ -]+$/.test(command)) {
      return res.status(400).json({
        error: "Invalid command"
      });
    }

    if (
      command.includes("&&") ||
      command.includes(";") ||
      command.includes("|") ||
      command.includes(">") ||
      command.includes("<")
    ) {
      return res.status(400).json({
        error: "Unsafe command format"
      });
    }

    const dir = botDir(name);

    if (fs.existsSync(dir)) {
      return res.status(409).json({
        error: "Bot already exists"
      });
    }

    fs.mkdirSync(dir, {
      recursive: true
    });

    fs.writeFileSync(
      botMeta(name),
      JSON.stringify(
        {
          name,
          command,
          createdAt: new Date().toISOString()
        },
        null,
        2
      )
    );

    /*
      Dummy index.js only for testing the panel.
      Replace this with your actual bot files.
    */

    fs.writeFileSync(
      path.join(dir, "index.js"),
      `
console.log("🤖 ${name} started");

setInterval(() => {
  console.log("${name}: running");
}, 30000);
`
    );

    appendLog(
      name,
      `[${new Date().toISOString()}] Bot created\n`
    );

    res.json({
      ok: true,
      name
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   API - START
========================= */

app.post("/api/bots/:name/start", (req, res) => {
  try {
    const name = safeName(req.params.name);

    startBot(name);

    res.json({
      ok: true,
      status: "running"
    });

  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

/* =========================
   API - STOP
========================= */

app.post("/api/bots/:name/stop", (req, res) => {
  try {
    const name = safeName(req.params.name);

    const stopped = stopBot(name);

    res.json({
      ok: stopped,
      status: stopped ? "stopping" : "stopped"
    });

  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

/* =========================
   API - RESTART
========================= */

app.post("/api/bots/:name/restart", async (req, res) => {
  try {
    const name = safeName(req.params.name);

    if (!fs.existsSync(botDir(name))) {
      return res.status(404).json({
        error: "Bot not found"
      });
    }

    if (processes.has(name)) {
      stopBot(name);
      await waitUntilStopped(name);
    }

    startBot(name);

    res.json({
      ok: true,
      status: "running"
    });

  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

/* =========================
   API - DELETE
========================= */

app.delete("/api/bots/:name", async (req, res) => {
  try {
    const name = safeName(req.params.name);

    if (!name) {
      return res.status(400).json({
        error: "Invalid bot name"
      });
    }

    if (processes.has(name)) {
      stopBot(name);
      await waitUntilStopped(name);
    }

    const dir = botDir(name);

    if (!fs.existsSync(dir)) {
      return res.status(404).json({
        error: "Bot not found"
      });
    }

    fs.rmSync(dir, {
      recursive: true,
      force: true
    });

    res.json({
      ok: true
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   API - LOGS
========================= */

app.get("/api/bots/:name/logs", (req, res) => {
  try {
    const name = safeName(req.params.name);

    const file = path.join(
      botDir(name),
      "console.log"
    );

    if (!fs.existsSync(file)) {
      return res.json({
        logs: ""
      });
    }

    let logs = fs.readFileSync(
      file,
      "utf8"
    );

    // Last 50KB only
    if (logs.length > 50000) {
      logs = logs.slice(-50000);
    }

    res.json({
      logs
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    panel: "HRIDOY BOT PANEL V2",
    bots: readBots().length,
    running: processes.size,
    time: new Date().toISOString()
  });
});

/* =========================
   FRONTEND
========================= */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      ROOT,
      "public",
      "index.html"
    )
  );
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log("");
  console.log("================================");
  console.log("💠 HRIDOY BOT PANEL V2");
  console.log("🚀 Server started");
  console.log(`🌐 Port: ${PORT}`);
  console.log("================================");
  console.log("");
});

/* =========================
   CLEAN SHUTDOWN
========================= */

function shutdown() {
  console.log("\n🛑 Shutting down...");

  for (const [name, child] of processes) {
    appendLog(
      name,
      `\n[${new Date().toISOString()}] PANEL SHUTDOWN\n`
    );

    try {
      child.kill("SIGTERM");
    } catch {}
  }

  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
