const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '../data');
const SWARM_CONFIG_FILE = path.join(DATA_DIR, 'swarm-config.json');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');

// Default swarm configuration
const DEFAULT_CONFIG = {
  enabled: false,
  leaderModel: 'claude-sonnet-4-20250514',
  workerModel: 'claude-sonnet-4-20250514',
  maxWorkers: 3,
  workflow: {
    steps: []
  }
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getSwarmConfig() {
  ensureDataDir();
  if (!fs.existsSync(SWARM_CONFIG_FILE)) {
    fs.writeFileSync(SWARM_CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return DEFAULT_CONFIG;
  }
  return JSON.parse(fs.readFileSync(SWARM_CONFIG_FILE, 'utf-8'));
}

function updateSwarmConfig(config) {
  ensureDataDir();
  fs.writeFileSync(SWARM_CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

function getAgents() {
  ensureDataDir();
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf-8')));
}

function getAgentByName(name) {
  const agents = getAgents();
  return agents.find(a => a.name.toLowerCase() === name.toLowerCase());
}

function assignTaskToAgent(agentName, task, todoId) {
  const agent = getAgentByName(agentName);
  if (!agent) {
    console.log(`⚠️ Agent "${agentName}" not found`);
    return null;
  }

  const agentFile = path.join(AGENTS_DIR, `${agent.id}.json`);
  const updateData = { status: 'busy', currentTask: task };

  // Add todo to agent's todo list
  if (!agent.todos) agent.todos = [];
  const newTodo = {
    id: todoId || uuidv4(),
    text: task,
    status: 'in_progress',
    assignedAt: new Date().toISOString()
  };
  agent.todos.push(newTodo);
  updateData.todos = agent.todos;

  const updated = { ...agent, ...updateData, lastActivity: new Date().toISOString() };
  fs.writeFileSync(agentFile, JSON.stringify(updated, null, 2));
  return updated;
}

// Execute workflow steps
async function executeWorkflow(broadcast) {
  const config = getSwarmConfig();
  if (!config.enabled || !config.workflow?.steps?.length) {
    return { success: false, message: 'Swarm not enabled or no workflow steps' };
  }

  const steps = config.workflow.steps;
  const agents = getAgents();
  const results = [];

  for (const step of steps) {
    const agent = agents.find(a => a.name.toLowerCase() === step.agentName.toLowerCase());
    if (!agent) {
      results.push({ step: step.agentName, status: 'skipped', reason: 'Agent not found' });
      continue;
    }

    // Check if agent already has a task
    if (agent.currentTask) {
      console.log(`⏭️ Agent ${agent.name} already has a task in progress, skipping`);
      results.push({ step: step.agentName, status: 'skipped', reason: 'Agent busy' });
      continue;
    }

    // Assign task
    const updated = assignTaskToAgent(step.agentName, step.task);
    if (updated && broadcast) {
      broadcast({ type: 'agent-updated', agent: updated });
    }
    results.push({ step: step.agentName, status: 'assigned', task: step.task });
  }

  return { success: true, results };
}

module.exports = {
  getSwarmConfig,
  updateSwarmConfig,
  getAgents,
  getAgentByName,
  assignTaskToAgent,
  executeWorkflow
};