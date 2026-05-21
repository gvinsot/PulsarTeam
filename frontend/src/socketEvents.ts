// Centralized WebSocket event names — mirrors api/src/ws/events.ts

export const WsEvents = {
  // Agent lifecycle
  AGENTS_LIST: 'agents:list',
  AGENT_CREATED: 'agent:created',
  AGENT_UPDATED: 'agent:updated',
  AGENT_DELETED: 'agent:deleted',
  AGENT_STATUS: 'agent:status',
  AGENT_STOPPED: 'agent:stopped',

  // Streaming
  STREAM_START: 'agent:stream:start',
  STREAM_CHUNK: 'agent:stream:chunk',
  STREAM_END: 'agent:stream:end',
  STREAM_ERROR: 'agent:stream:error',
  STREAM_RESUME: 'agent:stream:resume',

  // Agent activity
  AGENT_THINKING: 'agent:thinking',
  AGENT_HANDOFF: 'agent:handoff',
  AGENT_ASK: 'agent:ask',
  AGENT_ERROR_REPORT: 'agent:error:report',

  // Tasks
  TASK_UPDATED: 'task:updated',
  TASK_DELETED: 'task:deleted',

  // Broadcast
  BROADCAST_START: 'broadcast:start',
  BROADCAST_COMPLETE: 'broadcast:complete',
  BROADCAST_ERROR: 'broadcast:error',

  // Voice
  VOICE_DELEGATE_RESULT: 'voice:delegate:result',
  VOICE_ASK_RESULT: 'voice:ask:result',
  VOICE_MANAGEMENT_RESULT: 'voice:management:result',

  // Request events (client → server)
  REQ_CHAT: 'agent:chat',
  REQ_BROADCAST: 'broadcast:message',
  REQ_HANDOFF: 'agent:handoff',
  REQ_REFRESH: 'agents:refresh',
  REQ_SWARM_STATUS: 'agents:swarm-status',
  REQ_STATUSES: 'agents:statuses',
  REQ_AGENT_STATUS: 'agent:status',
  REQ_BY_PROJECT: 'agents:by-project',
  REQ_PROJECT_SUMMARY: 'agents:project-summary',
  REQ_STOP: 'agent:stop',
  REQ_TASK_EXECUTE: 'agent:task:execute',
  REQ_TASK_EXECUTE_ALL: 'agent:task:executeAll',
  REQ_VOICE_DELEGATE: 'voice:delegate',
  REQ_VOICE_ASK: 'voice:ask',
  REQ_VOICE_MANAGEMENT: 'voice:management',
  REQ_STREAM_STATE: 'agent:stream:state:request',

  ERROR: 'error',
  HANDOFF_COMPLETE: 'agent:handoff:complete',
  HANDOFF_ERROR: 'agent:handoff:error',
} as const;
