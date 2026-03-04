const express = require('express');
const router = express.Router();

let tasks = [];

router.get('/tasks', (req, res) => {
  res.json(tasks);
});

router.post('/tasks/clear', (req, res) => {
  const { status } = req.body || {};
  const allowed = new Set(['completed', 'failed', 'in_progress']);

  if (!allowed.has(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  tasks = tasks.filter((t) => t.status !== status);
  return res.json({ ok: true });
});

module.exports = router;