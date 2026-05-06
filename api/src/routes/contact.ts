import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getAllBoards, getAgentsByBoard } from '../services/database.js';

export function contactRoutes(agentManager: any) {
  const router = Router();

  // Strict rate limit — 5 submissions per hour per IP
  const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many submissions. Please try again later.' },
  });

  router.post('/', contactLimiter, async (req: Request, res: Response) => {
    try {
      const { email, phone, name, company, message, type } = req.body;

      // Validate required fields
      if (!email || !phone) {
        return res.status(400).json({ error: 'Email and phone number are required.' });
      }
      if (!type || !['contact', 'support'].includes(type)) {
        return res.status(400).json({ error: 'Type must be "contact" or "support".' });
      }

      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email address.' });
      }

      // Basic phone validation (at least 6 digits)
      const phoneDigits = phone.replace(/\D/g, '');
      if (phoneDigits.length < 6) {
        return res.status(400).json({ error: 'Invalid phone number.' });
      }

      // Sanitize inputs (prevent injection in task text)
      const sanitize = (s: string) => (s || '').replace(/[<>]/g, '').trim().slice(0, 500);
      const sName = sanitize(name || 'Anonymous');
      const sCompany = sanitize(company || '');
      const sMessage = sanitize(message || '');
      const sEmail = sanitize(email);
      const sPhone = sanitize(phone);

      // Build task text
      const label = type === 'contact' ? 'Contact Request' : 'Support Request';
      let taskText = `[${label}] ${sName}`;
      if (sCompany) taskText += ` (${sCompany})`;
      taskText += `\n\nEmail: ${sEmail}\nPhone: ${sPhone}`;
      if (sMessage) taskText += `\n\nMessage:\n${sMessage}`;

      // Find the "Support" board
      const boards = await getAllBoards();
      let targetBoard: any = null;

      for (const board of boards) {
        if (board.name && board.name.toLowerCase() === 'support') {
          targetBoard = board;
          break;
        }
      }

      // Fallback: board containing "support", then default board
      if (!targetBoard) {
        targetBoard = boards.find((b: any) => b.name && b.name.toLowerCase().includes('support'));
      }
      if (!targetBoard) {
        targetBoard = boards.find((b: any) => b.is_default);
      }

      const targetBoardId = targetBoard?.id || null;

      // Resolve the "Tickets" column from the board's workflow
      let targetColumn = 'backlog';
      if (targetBoard?.workflow?.columns) {
        const ticketsCol = targetBoard.workflow.columns.find(
          (c: any) => c.label && c.label.toLowerCase() === 'tickets'
        );
        if (ticketsCol) targetColumn = ticketsCol.id;
      }

      // Find an agent assigned to the target board (or any agent)
      let targetAgentId: string | null = null;
      if (targetBoardId) {
        const agents = await getAgentsByBoard(targetBoardId);
        if (agents.length > 0) {
          targetAgentId = agents[0].id;
        }
      }

      // Fallback: use any available agent from memory
      if (!targetAgentId) {
        const allAgents = Array.from<any>(agentManager.agents.values());
        if (allAgents.length > 0) {
          targetAgentId = allAgents[0].id;
        }
      }

      if (!targetAgentId) {
        return res.status(503).json({ error: 'No agents available to receive the request.' });
      }

      const source = { type: 'website', name: sName };
      const task = agentManager.addTask(
        targetAgentId,
        taskText,
        source,
        targetColumn,
        { boardId: targetBoardId, skipAutoRefine: true, taskType: type === 'contact' ? 'feature' : 'bug' }
      );

      if (!task) {
        return res.status(500).json({ error: 'Failed to create the request.' });
      }

      res.json({ success: true, message: 'Your request has been submitted successfully.' });
    } catch (err: any) {
      console.error('[Contact] Error:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  return router;
}
