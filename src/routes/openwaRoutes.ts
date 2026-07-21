import { Router } from 'express';
import {
  handleCreateSession,
  handleGetQR,
  handleGetStatus,
  handleReconnect,
  handleLogout,
  handlePairingCode,
  handleOpenWAWebhook,
} from '../controllers/openwaController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// REST Endpoints as specified in requirements
router.post('/create-session', authenticateToken as any, handleCreateSession as any);
router.get('/qr/:tenantId', handleGetQR as any);
router.get('/status/:tenantId', handleGetStatus as any);
router.post('/reconnect/:tenantId', handleReconnect as any);
router.post('/pairing-code/:tenantId', handlePairingCode as any);
router.delete('/logout/:tenantId', handleLogout as any);
router.post('/webhook', handleOpenWAWebhook as any);

export default router;
