const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '../data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const TASKS_FILE = path.join(DATA_DIR, 'todos.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

// Agent CRUD
function getAgents() {
  ensureDataDir();
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8')));
}

function getAgent(id) {
  ensureDataDir();
  const file = path.join(AGENTS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function getAgentByName(name) {
  const agents = getAgents();
  return agents.find(a => a.name.toLowerCase() === name.toLowerCase());
}

function createAgent(data) {
  ensureDataDir();
  const agent = {
    id: data.id || uuidv4(),
    name: data.name,
    role: data.role || 'worker',
    status: 'idle',
    provider: data.provider || 'anthropic',
    model: data.model || 'claude-sonnet-4-20250514',
    apiKey: data.apiKey || '',
    project: data.project || null,
    currentTask: null,
    tasks: [],
    completedTasks: 0,
    errors: 0,
    lastActivity: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  const file = path.join(AGENTS_DIR, `${agent.id}.json`);
  fs.writeFileSync(file, JSON.stringify(agent, null, 2));
  return agent;
}

function updateAgent(id, data) {
  const agent = getAgent(id);
  if (!agent) return null;
  const updated = { ...agent, ...data, lastActivity: new Date().toISOString() };
  const file = path.join(AGENTS_DIR, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(updated, null, 2));
  return updated;
}

function deleteAgent(id) {
  const file = path.join(AGENTS_DIR, `${id}.json`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

// Agent Tasks
function getAgentTasks(agentId) {
  const agent = getAgent(agentId);
  return agent?.tasks || [];
}

function addAgentTask(agentId, text, taskId) {
  const agent = getAgent(agentId);
  if (!agent) return null;
  if (!agent.tasks) agent.tasks = [];
  const task = {
    id: taskId || uuidv4(),
    text,
    status: 'backlog',
    createdAt: new Date().toISOString()
  };
  agent.tasks.push(task);
  const updateData = { status: 'busy', currentTask: task.text };
  updateData.tasks = agent.tasks;
  // Also set currentTask to the latest assigned task text
  updateData.currentTask = task.text;
  return updateAgent(agentId, updateData);
}

function updateAgentTask(agentId, taskId, data) {
  const agent = getAgent(agentId);
  if (!agent || !agent.tasks) return null;
  const taskIndex = agent.tasks.findIndex(t => t.id === taskId);
  if (taskIndex === -1) return null;
  agent.tasks[taskIndex] = { ...agent.tasks[taskIndex], ...data };

  // If task is done, update agent status
  const updateData = { tasks: agent.tasks };
  if (data.status === 'done') {
    const activeTasks = agent.tasks.filter(t => t.status !== 'done');
    if (activeTasks.length === 0) {
      updateData.status = 'idle';
      updateData.currentTask = null;
    } else {
      updateData.currentTask = activeTasks[activeTasks.length - 1].text;
    }
    updateData.completedTasks = (agent.completedTasks || 0) + 1;
  }
  if (data.status === 'error') {
    updateData.errors = (agent.errors || 0) + 1;
  }

  return updateAgent(agentId, updateData);
}

function deleteAgentTask(agentId, taskId) {
  const agent = getAgent(agentId);
  if (!agent || !agent.tasks) return null;
  agent.tasks = agent.tasks.filter(t => t.id !== taskId);

  const activeTasks = agent.tasks.filter(t => t.status !== 'done');
  const updateData = {
    tasks: agent.tasks,
    currentTask: activeTasks.length > 0 ? activeTasks[activeTasks.length - 1].text : null,
    status: activeTasks.length > 0 ? 'busy' : 'idle'
  };

  return updateAgent(agentId, updateData);
}

// Global Tasks
function getGlobalTasks() {
  ensureDataDir();
  if (!fs.existsSync(TASKS_FILE)) return [];
  return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
}

function addGlobalTask(text, project, source) {
  const tasks = getGlobalTasks();
  const task = {
    id: uuidv4(),
    text,
    status: 'backlog',
    project: project || null,
    source: source || null,
    createdAt: new Date().toISOString()
  };
  tasks.push(task);
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  return task;
}

function updateGlobalTask(id, data) {
  const tasks = getGlobalTasks();
  const index = tasks.findIndex(t => t.id === id);
  if (index === -1) return null;
  tasks[index] = { ...tasks[index], ...data };
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  return tasks[index];
}

function deleteGlobalTask(id) {
  let tasks = getGlobalTasks();
  tasks = tasks.filter(t => t.id !== id);
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
  return true;
}

// Projects
function getProjects() {
  const agents = getAgents();
  const projects = new Set();
  agents.forEach(a => {
    if (a.project) projects.add(a.project);
  });
  return [...projects];
}

module.exports = {
  getAgents,
  getAgent,
  getAgentByName,
  createAgent,
  updateAgent,
  deleteAgent,
  getAgentTasks,
  addAgentTask,
  updateAgentTask,
  deleteAgentTask,
  getGlobalTasks,
  addGlobalTask,
  updateGlobalTask,
  deleteGlobalTask,
  getProjects
};