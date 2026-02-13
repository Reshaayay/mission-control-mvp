import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 4311;
const ROOT = path.resolve(".");
const DATA_DIR = path.join(ROOT, "data");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");
let memoryTasks = { tasks: [] };

app.use(express.json());
app.use(express.static(path.join(ROOT, "public")));

let INDEX_HTML = "<h1>Mission Control MVP</h1>";
try {
  INDEX_HTML = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
} catch {
  // fallback remains minimal
}

function ensureStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks: [] }, null, 2));
  } catch {
    // read-only/serverless filesystem; use in-memory fallback
  }
}

function readTasks() {
  try {
    ensureStore();
    if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
  } catch {
    // ignore
  }
  return memoryTasks;
}

function writeTasks(data) {
  memoryTasks = data;
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
  } catch {
    // ignore in read-only env
  }
}

async function runJson(command, args = []) {
  const { stdout } = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function demoOverview() {
  return {
    agents: [
      { id: "main", model: "openai-codex/gpt-5.3-codex" },
      { id: "codex", model: "openai-codex/gpt-5.3-codex" },
      { id: "research", model: "google-antigravity/claude-opus-4-5-thinking" },
    ],
    sessionsByAgent: { main: [], codex: [], research: [] },
  };
}

function sessionStoreFromAgentDir(agentDir) {
  return path.join(path.dirname(agentDir), "sessions", "sessions.json");
}

async function getAgents() {
  return runJson("openclaw", ["agents", "list", "--json"]);
}

async function getSessionsByAgent(agents) {
  const out = {};
  await Promise.all(
    agents.map(async (agent) => {
      try {
        const store = sessionStoreFromAgentDir(agent.agentDir);
        const sessions = await runJson("openclaw", ["sessions", "--json", "--store", store]);
        out[agent.id] = sessions.sessions || [];
      } catch {
        out[agent.id] = [];
      }
    })
  );
  return out;
}

app.get("/", (_req, res) => {
  res.type("html").send(INDEX_HTML);
});

app.get("/api/overview", async (_req, res) => {
  try {
    const tasksStore = readTasks();
    let agents;
    let sessionsByAgent;
    try {
      agents = await getAgents();
      sessionsByAgent = await getSessionsByAgent(agents);
    } catch {
      const demo = demoOverview();
      agents = demo.agents;
      sessionsByAgent = demo.sessionsByAgent;
    }

    res.json({
      agents,
      sessionsByAgent,
      tasks: tasksStore.tasks.sort((a, b) => b.createdAt - a.createdAt),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/tasks", (req, res) => {
  const { title, agentId, details } = req.body || {};
  if (!title || !agentId) return res.status(400).json({ error: "title and agentId are required" });

  const store = readTasks();
  const task = {
    id: `task_${Date.now()}`,
    title,
    details: details || "",
    agentId,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    logs: [{ at: Date.now(), text: `Task queued for ${agentId}` }],
  };
  store.tasks.push(task);
  writeTasks(store);
  res.json(task);
});

app.post("/api/tasks/:id/dispatch", async (req, res) => {
  const { id } = req.params;
  const store = readTasks();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return res.status(404).json({ error: "Task not found" });

  task.status = "in_progress";
  task.updatedAt = Date.now();
  task.logs.push({ at: Date.now(), text: "Dispatching to agent..." });
  writeTasks(store);

  try {
    const prompt = [
      `You are assigned task: ${task.title}`,
      task.details ? `Details: ${task.details}` : "",
      "Return: (1) brief plan, (2) execution result, (3) next steps.",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await runJson("openclaw", [
      "agent",
      "--agent",
      task.agentId,
      "--message",
      prompt,
      "--json",
      "--timeout",
      "300",
    ]);

    task.status = "done";
    task.updatedAt = Date.now();
    task.result = result;
    task.logs.push({ at: Date.now(), text: "Task completed" });
    writeTasks(store);
    res.json(task);
  } catch (err) {
    task.status = "failed";
    task.updatedAt = Date.now();
    task.error = String(err);
    task.logs.push({ at: Date.now(), text: `Task failed: ${String(err)}` });
    writeTasks(store);
    res.status(500).json({ error: String(err), task });
  }
});

app.post("/api/agent-message", async (req, res) => {
  const { fromAgent = "orchestrator", toAgent, message } = req.body || {};
  if (!toAgent || !message) return res.status(400).json({ error: "toAgent and message are required" });

  try {
    const composed = `[Agent message from ${fromAgent}]\n${message}`;
    const result = await runJson("openclaw", [
      "agent",
      "--agent",
      toAgent,
      "--message",
      composed,
      "--json",
      "--timeout",
      "180",
    ]);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

ensureStore();
export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Mission Control MVP running on http://localhost:${PORT}`);
  });
}
