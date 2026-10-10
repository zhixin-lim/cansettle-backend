import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as store from './store/index.mjs';
import { computeSessionSettlement } from './settlementService.mjs';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Runs before any route that has :sessionId in its path.
  // Unknown session -> 404. Expired session -> 410 Gone (the frontend should
  // clear its saved session id and tell the user the settlement has expired).
  app.param('sessionId', async (req, res, next, sessionId) => {
    try {
      const meta = await store.getSessionMeta(sessionId);
      if (!meta) return res.status(404).json({ error: 'Session not found' });
      if (new Date(meta.expiresAt).getTime() <= Date.now()) {
        return res.status(410).json({ error: 'This settlement has expired', code: 'SESSION_EXPIRED' });
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/sessions', async (req, res, next) => {
    try {
      const session = await store.createSession({ label: req.body?.label });
      res.status(201).json(session);
    } catch (err) {
      next(err);
    }
  });

  app.get('/sessions/:sessionId', async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (err) {
      next(err);
    }
  });

  app.post('/sessions/:sessionId/participants', async (req, res, next) => {
    try {
      const { name, telegramUserId } = req.body ?? {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      const participant = await store.addParticipant(req.params.sessionId, { name, telegramUserId });
      res.status(201).json(participant);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/sessions/:sessionId/participants/:participantId', async (req, res, next) => {
    try {
      const { name } = req.body ?? {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      const participant = await store.renameParticipant(req.params.sessionId, req.params.participantId, name);
      res.json(participant);
    } catch (err) {
      next(err);
    }
  });

  app.delete('/sessions/:sessionId/participants/:participantId', async (req, res, next) => {
    try {
      await store.deleteParticipant(req.params.sessionId, req.params.participantId);
      res.status(204).end();
    } catch (err) {
      if (err.code === 'PARTICIPANT_IS_PAYER') {
        return res.status(409).json({ error: err.message, code: err.code });
      }
      next(err);
    }
  });

  app.delete('/sessions/:sessionId/bills/:billId', async (req, res, next) => {
    try {
      await store.deleteBill(req.params.sessionId, req.params.billId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.post('/sessions/:sessionId/bills', async (req, res, next) => {
    try {
      const { name, source, payerId, serviceChargeCents, gstCents, totalCents, items } = req.body ?? {};
      if (!source || !payerId || totalCents == null || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'source, payerId, totalCents and at least one item are required' });
      }
      const bill = await store.addBill(req.params.sessionId, {
        name: name ?? null,
        source,
        payerId,
        serviceChargeCents: serviceChargeCents ?? 0,
        gstCents: gstCents ?? 0,
        totalCents,
        items,
      });
      res.status(201).json(bill);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/sessions/:sessionId/items/:itemId/allocation', async (req, res, next) => {
    try {
      const { allocations } = req.body ?? {};
      if (!Array.isArray(allocations) || allocations.length === 0) {
        return res.status(400).json({ error: 'allocations must be a non-empty array of { participantId, quantity? }' });
      }
      for (const a of allocations) {
        if (!a.participantId) {
          return res.status(400).json({ error: 'each allocation needs a participantId' });
        }
      }
      const item = await store.setItemAllocation(req.params.sessionId, req.params.itemId, allocations);
      res.json(item);
    } catch (err) {
      next(err);
    }
  });

  app.get('/sessions/:sessionId/settlement', async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const settlement = computeSessionSettlement(session);
      res.json(settlement);
    } catch (err) {
      next(err);
    }
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  const port = process.env.PORT ?? 3000;
  app.listen(port, () => console.log(`CanSettle backend listening on :${port}`));

  // Delete expired sessions on startup and then every hour. (Expired sessions
  // are already refused with a 410 above, so this is about actually removing
  // the data, not just hiding it.)
  const sweep = async () => {
    try {
      const deleted = await store.deleteExpiredSessions();
      if (deleted > 0) console.log(`Expiry sweep removed ${deleted} session(s)`);
    } catch (err) {
      console.error('Expiry sweep failed:', err.message);
    }
  };
  sweep();
  setInterval(sweep, 60 * 60 * 1000);
}
