import { Router } from 'express';
import { getAggregatedStats, exportLeadsCSV } from '../controllers/analyticsController';
import { authenticateToken, requireRole } from '../middleware/auth';

const router = Router();

router.use(authenticateToken as any);
router.use(requireRole(['Admin', 'Sales Manager']) as any);

router.get('/', getAggregatedStats as any);
router.get('/export', exportLeadsCSV as any);

export default router;
