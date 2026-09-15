import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { validateBody } from '../lib/validate.js';
import { contactSubmitSchema } from '../schemas/contact.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { readSecret } from '../secrets.js';
import { authorizeScopedApiKey } from '../middleware/apiKeyAuth.js';
import { createBoardTask } from '../services/mcp/taskInsertion.js';

/**
 * Public contact form (login page).
 *
 * The visitor is anonymous, so the SERVER holds the credential: an `insert`
 * API key, minted from Settings → API keys against the board that should
 * receive the requests, and provided as the Docker secret HOME_FORM_KEY
 * (/run/secrets/HOME_FORM_KEY). The key is checked by the very function that
 * guards POST /api/insert/tasks, so the target board, the owner's live edit
 * access and revocation all behave as they do for any other integration.
 */
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

  router.post(
    '/',
    contactLimiter,
    validateBody(contactSubmitSchema),
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const { email, phone, name, company, message, type } = req.body as any;

        // Phone digit-count check kept here — schema only enforces length bounds
        // because international phone formats vary.
        const phoneDigits = phone.replace(/\D/g, '');
        if (phoneDigits.length < 6) {
          res.status(400).json({ error: 'Invalid phone number.' });
          return;
        }

        // The visitor never learns why the key was refused: that is the
        // operator's problem, and the reason goes to the logs.
        const contactKey = readSecret('HOME_FORM_KEY');
        if (!contactKey) {
          console.error('[Contact] HOME_FORM_KEY is not configured — submission dropped');
          res.status(503).json({ error: 'The contact form is temporarily unavailable.' });
          return;
        }
        const auth = await authorizeScopedApiKey(contactKey, 'insert');
        if (!auth.ok) {
          console.error(`[Contact] HOME_FORM_KEY refused: ${auth.error}`);
          res.status(503).json({ error: 'The contact form is temporarily unavailable.' });
          return;
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

        // Land in the key board's "Tickets" column when it has one, else in
        // the board's first column.
        const board = auth.board!;
        const ticketsColumn = (board.workflow?.columns || []).find(
          (c: any) => c.label && c.label.toLowerCase() === 'tickets'
        );

        const created = await createBoardTask(
          agentManager,
          auth.user!,
          board,
          {
            task: taskText,
            task_type: type === 'contact' ? 'feature' : 'bug',
            ...(ticketsColumn ? { status: ticketsColumn.id } : {}),
          },
          { type: 'website', scope: 'insert', apiKeyId: auth.apiKey!.id, name: sName },
          { allowedColumns: auth.apiKey!.allowedColumns }
        );

        if (!created.ok) {
          console.error(`[Contact] Task creation failed: ${created.error}`);
          res.status(500).json({ error: 'Failed to create the request.' });
          return;
        }

        res.json({ success: true, message: 'Your request has been submitted successfully.' });
      } catch (err: any) {
        console.error('[Contact] Error:', err.message);
        res.status(500).json({ error: 'Internal server error.' });
      }
    })
  );

  return router;
}
