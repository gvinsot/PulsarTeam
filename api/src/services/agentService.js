const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '../data');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const TODOS_FILE = path.join(DATA_DIR, 'todos.json');

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
    todos: [],
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

// Agent Todos
function getAgentTodos(agentId) {
  const agent = getAgent(agentId);
  return agent?.todos || [];
}

function addAgentTodo(agentId, text, todoId) {
  const agent = getAgent(agentId);
  if (!agent) return null;
  if (!agent.todos) agent.todos = [];
  const todo = {
    id: todoId || uuidv4(),
    text,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  agent.todos.push(todo);
  const updateData = { status: 'busy', currentTask: todo.text };
  updateData.todos = agent.todos;
  // Also set currentTask to the latest assigned task text
  updateData.currentTask = todo.text;
  return updateAgent(agentId, updateData);
}

function updateAgentTodo(agentId, todoId, data) {
  const agent = getAgent(agentId);
  if (!agent || !agent.todos) return null;
  const todoIndex = agent.todos.findIndex(t => t.id === todoId);
  if (todoIndex === -1) return null;
  agent.todos[todoIndex] = { ...agent.todos[todoIndex], ...data };

  // If todo is done, update agent status
  const updateData = { todos: agent.todos };
  if (data.status === 'done') {
    const activeTodos = agent.todos.filter(t => t.status !== 'done');
    if (activeTodos.length === 0) {
      updateData.status = 'idle';
      updateData.currentTask = null;
    } else {
      updateData.currentTask = activeTodos[activeTodos.length - 1].text;
    }
    updateData.completedTasks = (agent.completedTasks || 0) + 1;
  }
  if (data.status === 'error') {
    updateData.errors = (agent.errors || 0) + 1;
  }

  return updateAgent(agentId, updateData);
}

function deleteAgentTodo(agentId, todoId) {
  const agent = getAgent(agentId);
  if (!agent || !agent.todos) return null;
  agent.todos = agent.todos.filter(t => t.id !== todoId);

  const activeTodos = agent.todos.filter(t => t.status !== 'done');
  const updateData = {
    todos: agent.todos,
    currentTask: activeTodos.length > 0 ? activeTodos[activeTodos.length - 1].text : null,
    status: activeTodos.length > 0 ? 'busy' : 'idle'
  };

  return updateAgent(agentId, updateData);
}

// Global Todos
function getGlobalTodos() {
  ensureDataDir();
  if (!fs.existsSync(TODOS_FILE)) return [];
  return JSON.parse(fs.readFileSync(TODOS_FILE, 'utf-8'));
}

function addGlobalTodo(text, project, source) {
  const todos = getGlobalTodos();
  const todo = {
    id: uuidv4(),
    text,
    status: 'pending',
    project: project || null,
    source: source || null,
    createdAt: new Date().toISOString()
  };
  todos.push(todo);
  fs.writeFileSync(TODOS_FILE, JSON.stringify(todos, null, 2));
  return todo;
}

function updateGlobalTodo(id, data) {
  const todos = getGlobalTodos();
  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return null;
  todos[index] = { ...todos[index], ...data };
  fs.writeFileSync(TODOS_FILE, JSON.stringify(todos, null, 2));
  return todos[index];
}

function deleteGlobalTodo(id) {
  let todos = getGlobalTodos();
  todos = todos.filter(t => t.id !== id);
  fs.writeFileSync(TODOS_FILE, JSON.stringify(todos, null, 2));
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
  getAgentTodos,
  addAgentTodo,
  updateAgentTodo,
  deleteAgentTodo,
  getGlobalTodos,
  addGlobalTodo,
  updateGlobalTodo,
  deleteGlobalTodo,
  getProjects
};