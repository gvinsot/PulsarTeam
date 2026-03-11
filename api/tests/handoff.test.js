const fs = require('fs').promises';
const path = require('path');
const { AgentManager } = require('../src/services/agentManager');
const { v4: uuidv4 } = require('uuid');

// Mock dependencies
jest.mock('fs').promises;
jest.mock('../src/services/database');
jest.mock('../src/services/llmProviders');
jest.mock('../src/services/agentTools');
jest.mock('../src/services/githubProjects');

describe('AgentManager - Handoff with File System Transfer', () => {
  let agentManager;
  let mockIo;
  let mockSkillManager;
  let mockSandboxManager;
  let mockMcpManager;

  beforeEach(() => {
    mockIo = { emit: jest.fn() };
    mockSkillManager = {};
    mockSandboxManager = {};
    mockMcpManager = {};

    agentManager = new AgentManager(mockIo, mockSkillManager, mockSandboxManager, mockMcpManager);

    // Mock agents
    agentManager.agents.set('agent1', {
      id: 'agent1',
      name: 'Agent One',
      project: 'test-project',
      conversationHistory: []
    });

    agentManager.agents.set('agent2', {
      id: 'agent2',
      name: 'Agent Two',
      project: 'test-project',
      conversationHistory: []
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('transferUserFiles', () => {
    const fromId = 'agent1';
    const toId = 'agent2';
    const tempDir = path.join('/tmp', `handoff-${uuidv4()}`);
    const fromHomeDir = `/home/${fromId}`;
    const toHomeDir = `/home/${toId}`;

    beforeEach(() => {
      // Mock fs operations
      fs.mkdir.mockResolvedValue();
      fs.cp.mockResolvedValue();
      fs.chmod.mockResolvedValue();
      fs.chownr.mockResolvedValue();
      fs.rename.mockResolvedValue();
      fs.rm.mockResolvedValue();
    });

    it('should successfully transfer files and change ownership', async () => {
      const result = await agentManager.transferUserFiles(fromId, toId);

      expect(result.success).toBe(true);
      expect(fs.mkdir).toHaveBeenCalledWith(tempDir, { recursive: true });
      expect(fs.cp).toHaveBeenCalledWith(fromHomeDir, tempDir, { recursive: true });
      expect(fs.chmod).toHaveBeenCalledWith(tempDir, 0o755);
      expect(fs.chownr).toHaveBeenCalledWith(tempDir, toId, toId);
      expect(fs.rename).toHaveBeenCalledWith(tempDir, toHomeDir);
    });

    it('should handle file transfer errors', async () => {
      const errorMessage = 'Copy failed';
      fs.cp.mockRejectedValue(new Error(errorMessage));

      const result = await agentManager.transferUserFiles(fromId, toId);

      expect(result.success).toBe(false);
      expect(result.message).toBe(errorMessage);
      expect(fs.rm).toHaveBeenCalledWith(tempDir, { recursive: true, force: true });
    });

    it('should clean up temporary directory on error', async () => {
      fs.mkdir.mockRejectedValue(new Error('Permission denied'));

      const result = await agentManager.transferUserFiles(fromId, toId);

      expect(result.success).toBe(false);
      expect(fs.rm).toHaveBeenCalledWith(tempDir, { recursive: true, force: true });
    });

    it('should handle missing source directory', async () => {
      fs.cp.mockRejectedValue(new Error('Source directory does not exist'));

      const result = await agentManager.transferUserFiles(fromId, toId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Source directory does not exist');
    });

    it('should handle permission errors during ownership change', async () => {
      fs.chownr.mockRejectedValue(new Error('Permission denied'));

      const result = await agentManager.transferUserFiles(fromId, toId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Permission denied');
    });
  });

  describe('handoff', () => {
    const fromId = 'agent1';
    const toId = 'agent2';
    const context = 'Test handoff context';
    const streamCallback = jest.fn();

    beforeEach(() => {
      // Mock transferUserFiles
      agentManager.transferUserFiles = jest.fn().mockResolvedValue({
        success: true,
        message: 'File system handoff completed successfully'
      });

      // Mock sendMessage
      agentManager.sendMessage = jest.fn().mockResolvedValue('Handoff message sent');
    });

    it('should perform handoff with file transfer', async () => {
      const result = await agentManager.handoff(fromId, toId, context, streamCallback);

      expect(agentManager.transferUserFiles).toHaveBeenCalledWith(fromId, toId);
      expect(agentManager.sendMessage).toHaveBeenCalled();
      expect(result.fileTransfer.success).toBe(true);
      expect(mockIo.emit).toHaveBeenCalledWith('agent:handoff', {
        fromId,
        toId,
        context,
        timestamp: expect.any(String)
      });
    });

    it('should handle file transfer failure during handoff', async () => {
      agentManager.transferUserFiles.mockResolvedValue({
        success: false,
        message: 'Transfer failed'
      });

      const result = await agentManager.handoff(fromId, toId, context, streamCallback);

      expect(result.fileTransfer.success).toBe(false);
      expect(result.fileTransfer.message).toBe('Transfer failed');
    });

    it('should emit handoff event with correct data', async () => {
      await agentManager.handoff(fromId, toId, context, streamCallback);

      expect(mockIo.emit).toHaveBeenCalledWith('agent:handoff', {
        fromId,
        toId,
        context,
        timestamp: expect.any(String)
      });
    });

    it('should include file transfer status in response', async () => {
      const result = await agentManager.handoff(fromId, toId, context, streamCallback);

      expect(result.fileTransfer).toBeDefined();
      expect(result.fileTransfer.success).toBe(true);
    });
  });
});