import { createBoard, getAgentsByBoard, getBoardsByUser } from './database.js';
import { AGENT_TEMPLATES } from '../data/templates.js';
import { NEW_USER_BOARD_WORKFLOW, PERSONAL_BOARD_NAME } from './boardDefaults.js';

let _agentManager: any = null;

export function setAgentManager(am: any) {
  _agentManager = am;
}

export async function provisionNewUser(userId: string): Promise<void> {
  try {
    const existingBoards = (await getBoardsByUser(userId)).filter((b: any) =>
      !b.share_permission && String(b.user_id) === String(userId)
    );
    const board = existingBoards[0] || await createBoard(userId, PERSONAL_BOARD_NAME, NEW_USER_BOARD_WORKFLOW, {});
    if (existingBoards.length === 0) {
      console.log(`✅ Created initial board for user ${userId}: ${board.id}`);
    } else {
      console.log(`✅ Initial board already exists for user ${userId}: ${board.id}`);
    }

    if (_agentManager) {
      const devTemplate = AGENT_TEMPLATES.find(t => t.id === 'developer');
      if (devTemplate) {
        const existingBoardAgents = await getAgentsByBoard(board.id);
        const hasDeveloper = existingBoardAgents.some((agent: any) =>
          String(agent.ownerId || '') === String(userId) && agent.template === devTemplate.id
        );
        if (hasDeveloper) {
          console.log(`✅ Default developer agent already exists for user ${userId}`);
          return;
        }

        await _agentManager.create({
          name: devTemplate.name,
          role: devTemplate.role,
          description: devTemplate.description,
          instructions: devTemplate.instructions,
          icon: devTemplate.icon,
          color: devTemplate.color,
          temperature: devTemplate.temperature,
          maxTokens: devTemplate.maxTokens,
          template: devTemplate.id,
          ownerId: userId,
          boardId: board.id,
          runner: 'opencode',
          skills: ['skill-basic-tools', 'skill-web-browser'],
        });
        console.log(`✅ Created default developer agent for user ${userId} (runner=opencode, llmConfig=default, plugins=Basic Tools/Web Browser)`);
      }
    }
  } catch (err) {
    console.error(`Failed to provision new user ${userId}:`, err.message);
  }
}
