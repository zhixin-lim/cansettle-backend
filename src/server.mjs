import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as store from './store/index.mjs';
import { computeSessionSettlement } from './settlementService.mjs';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

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

  app.post('/sessions/:sessionId/bills', async (req, res, next) => {
    try {
      const { source, payerId, serviceChargeCents, gstCents, totalCents, items } = req.body ?? {};
      if (!source || !payerId || totalCents == null || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'source, payerId, totalCents and at least one item are required' });
      }
      const bill = await store.addBill(req.params.sessionId, {
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
      const { participantIds } = req.body ?? {};
      if (!Array.isArray(participantIds) || participantIds.length === 0) {
        return res.status(400).json({ error: 'participantIds must be a non-empty array' });
      }
      const item = await store.setItemAllocation(req.params.sessionId, req.params.itemId, participantIds);
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
}
