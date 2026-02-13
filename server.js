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

const INDEX_HTML = `<!doctype html>
<html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Mission Control MVP</title>
<style>body{font-family:Inter,system-ui,Arial;margin:0;background:#0b1020;color:#e9eefc}.wrap{padding:20px;max-width:1200px;margin:0 auto}.row{display:grid;grid-template-columns:1fr 2fr;gap:16px}.card{background:#131a33;border:1px solid #283056;border-radius:12px;padding:14px}h1,h2,h3{margin:0 0 10px}.agents li{margin:8px 0;padding:8px;border-radius:8px;background:#0f1530}.columns{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.col{background:#101733;border-radius:10px;padding:10px;min-height:280px}.task{background:#1a2347;border:1px solid #2c3769;border-radius:8px;padding:8px;margin-bottom:8px}input,select,textarea,button{width:100%;margin-top:6px;padding:8px;border-radius:8px;border:1px solid #334073;background:#0f1530;color:#fff}button{cursor:pointer;background:#2856ff;border:none}small{color:#9fb2ff}</style></head>
<body><div class="wrap"><h1>🛰️ Mission Control MVP</h1><small>Live agents, queue, in-progress tasks, and orchestrated dispatch.</small><div class="row" style="margin-top:14px;"><div class="card"><h3>Create Task</h3><label>Title</label><input id="title" placeholder="Build user auth flow" /><label>Assign to Agent</label><select id="agentId"></select><label>Details</label><textarea id="details" rows="4" placeholder="Constraints, deliverables, deadline..."></textarea><button onclick="createTask()">Create Task</button></div><div class="card"><h3>Agents</h3><ul id="agents" class="agents"></ul></div></div><div class="card" style="margin-top:16px;"><h3>Mission Queue</h3><div class="columns"><div class="col"><strong>Queued</strong><div id="queued"></div></div><div class="col"><strong>In Progress</strong><div id="in_progress"></div></div><div class="col"><strong>Done</strong><div id="done"></div></div><div class="col"><strong>Failed</strong><div id="failed"></div></div></div></div></div><script>let state={agents:[],tasks:[],sessionsByAgent:{}};async function refresh(){const res=await fetch('/api/overview');state=await res.json();render()}function render(){const sel=document.getElementById('agentId');sel.innerHTML=state.agents.map(a=>`<option value="${a.id}">${a.id} (${a.model})</option>`).join('');document.getElementById('agents').innerHTML=state.agents.map(a=>{const active=(state.sessionsByAgent[a.id]||[]).length;return `<li><strong>${a.id}</strong><br/><small>${a.model}</small><br/><small>sessions: ${active}</small></li>`}).join('');['queued','in_progress','done','failed'].forEach(k=>{document.getElementById(k).innerHTML=state.tasks.filter(t=>t.status===k).map(t=>`<div class="task"><strong>${t.title}</strong><br/><small>${t.agentId}</small><br/>${k==='queued'?`<button onclick="dispatchTask('${t.id}')">Dispatch</button>`:''}</div>`).join('')})}async function createTask(){const title=document.getElementById('title').value.trim();const agentId=document.getElementById('agentId').value;const details=document.getElementById('details').value.trim();if(!title)return alert('Title required');await fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title,agentId,details})});document.getElementById('title').value='';document.getElementById('details').value='';refresh()}async function dispatchTask(id){await fetch(`/api/tasks/${id}/dispatch`,{method:'POST'});refresh()}refresh();setInterval(refresh,5000);</script></body></html>`;

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
