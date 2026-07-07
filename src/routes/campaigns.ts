import { Router } from 'express';
import { getCampaigns, createCampaign, triggerCampaignManual } from '../controllers/campaignController';
import { authenticateToken, requireRole } from '../middleware/auth';

const router = Router();

router.use(authenticateToken as any);
router.use(requireRole(['Admin', 'Sales Manager']) as any);

router.get('/', getCampaigns as any);
router.post('/', createCampaign as any);
router.post('/trigger', triggerCampaignManual as any);

export default router;
