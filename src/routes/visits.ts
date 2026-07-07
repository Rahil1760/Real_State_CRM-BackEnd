import { Router } from 'express';
import { getVisits, createVisit, updateVisit } from '../controllers/visitController';
import { authenticateToken } from '../middleware/auth';

const router = Router();

router.use(authenticateToken as any);

router.get('/', getVisits as any);
router.post('/', createVisit as any);
router.put('/:id', updateVisit as any);

export default router;
