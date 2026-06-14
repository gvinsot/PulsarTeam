import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { createMcpHttpHandler } from './mcpHttpHandler.js';
import {
  getAllAgentSkills,
  searchAgentSkills,
  getAgentSkillById,
  saveAgentSkill,
  deleteAgentSkillFromDb,
} from './database.js';

export function createAutoLearnMcpServer() {
  const server = new McpServer({ name: 'Auto Learn', version: '1.0.0' });

  server.tool(
    'list_skills',
    'List all learned skills in the shared skill library.',
    {},
    async () => {
      const skills = await getAllAgentSkills();
      if (!skills.length) {
        return { content: [{ type: 'text', text: 'No skills in the library yet. Use create_skill to add one.' }] };
      }
      const summary = skills.map((s: any) =>
        `- **${s.name}** (${s.id}) [${s.category || 'general'}] — ${s.description || 'No description'}`
      ).join('\n');
      return { content: [{ type: 'text', text: `${skills.length} skill(s) in the library:\n\n${summary}` }] };
    }
  );

  server.tool(
    'search_skills',
    'Search the skill library by keyword. Use this to find existing skills before creating new ones.',
    {
      query: z.string().describe('Search query — matches against skill name, description, category, and instructions'),
    },
    async ({ query }) => {
      const skills = await searchAgentSkills(query);
      if (!skills.length) {
        return { content: [{ type: 'text', text: `No skills found matching "${query}".` }] };
      }
      const summary = skills.map((s: any) =>
        `- **${s.name}** (${s.id}) [${s.category || 'general'}] — ${s.description || 'No description'}`
      ).join('\n');
      return { content: [{ type: 'text', text: `Found ${skills.length} skill(s) matching "${query}":\n\n${summary}` }] };
    }
  );

  server.tool(
    'get_skill',
    'Get the full details of a skill by its ID, including the complete instructions.',
    {
      skill_id: z.string().describe('The ID of the skill to retrieve'),
    },
    async ({ skill_id }) => {
      const skill = await getAgentSkillById(skill_id);
      if (!skill) {
        return { content: [{ type: 'text', text: `Skill "${skill_id}" not found.` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(skill, null, 2) }] };
    }
  );

  server.tool(
    'create_skill',
    'Create a new skill in the shared library. A skill captures reusable knowledge: step-by-step procedures, best practices, debugging playbooks, code patterns, or any instructions an agent might need again.',
    {
      name: z.string().min(1).max(200).describe('Short, descriptive name for the skill (e.g. "Deploy to Staging", "Fix CORS Issues")'),
      description: z.string().max(2000).optional().describe('Brief description of when and why to use this skill'),
      category: z.enum(['coding', 'devops', 'writing', 'security', 'analysis', 'general']).optional().describe('Skill category (default: general)'),
      instructions: z.string().min(1).max(100000).describe('The full instructions, knowledge, or procedure that makes up this skill. Be detailed and include examples.'),
    },
    async ({ name, description, category, instructions }, extra) => {
      const existing = await searchAgentSkills(name);
      const duplicate = existing.find((s: any) => s.name.toLowerCase() === name.toLowerCase());
      if (duplicate) {
        return {
          content: [{
            type: 'text',
            text: `A skill named "${duplicate.name}" already exists (${duplicate.id}). Use update_skill to modify it instead.`,
          }],
        };
      }

      const agentId = (extra as any)?.agentId || null;
      const now = new Date().toISOString();
      const skill = {
        id: `agent-skill-${uuidv4()}`,
        name,
        description: description || '',
        category: category || 'general',
        instructions,
        mcpServerIds: [],
        createdBy: agentId ? `agent:${agentId}` : 'system',
        createdByAgentId: agentId,
        useCount: 0,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      await saveAgentSkill(skill);
      return {
        content: [{
          type: 'text',
          text: `Skill "${name}" created successfully.\nID: ${skill.id}\nCategory: ${skill.category}\n\nOther agents can now find and use this skill via search_skills.`,
        }],
      };
    }
  );

  server.tool(
    'update_skill',
    'Update an existing skill in the library. Use this to improve instructions, fix errors, or add new knowledge to a skill.',
    {
      skill_id: z.string().describe('The ID of the skill to update'),
      name: z.string().min(1).max(200).optional().describe('New name (optional)'),
      description: z.string().max(2000).optional().describe('New description (optional)'),
      category: z.enum(['coding', 'devops', 'writing', 'security', 'analysis', 'general']).optional().describe('New category (optional)'),
      instructions: z.string().min(1).max(100000).optional().describe('New instructions (optional — replaces the existing instructions entirely)'),
    },
    async ({ skill_id, name, description, category, instructions }, extra) => {
      const existing = await getAgentSkillById(skill_id);
      if (!existing) {
        return { content: [{ type: 'text', text: `Skill "${skill_id}" not found. Use list_skills or search_skills to find the correct ID.` }] };
      }

      if (name !== undefined) existing.name = name;
      if (description !== undefined) existing.description = description;
      if (category !== undefined) existing.category = category;
      if (instructions !== undefined) existing.instructions = instructions;
      existing.updatedAt = new Date().toISOString();
      const agentId = (extra as any)?.agentId || null;
      if (agentId) existing.lastUpdatedBy = `agent:${agentId}`;

      await saveAgentSkill(existing);
      return {
        content: [{
          type: 'text',
          text: `Skill "${existing.name}" (${existing.id}) updated successfully.`,
        }],
      };
    }
  );

  server.tool(
    'delete_skill',
    'Delete a skill from the library. Use with caution — this cannot be undone.',
    {
      skill_id: z.string().describe('The ID of the skill to delete'),
    },
    async ({ skill_id }) => {
      const existing = await getAgentSkillById(skill_id);
      if (!existing) {
        return { content: [{ type: 'text', text: `Skill "${skill_id}" not found.` }] };
      }
      await deleteAgentSkillFromDb(skill_id);
      return {
        content: [{ type: 'text', text: `Skill "${existing.name}" (${skill_id}) has been deleted.` }],
      };
    }
  );

  return server;
}

export function createAutoLearnMcpHandler() {
  return createMcpHttpHandler('Auto Learn', () => createAutoLearnMcpServer());
}
