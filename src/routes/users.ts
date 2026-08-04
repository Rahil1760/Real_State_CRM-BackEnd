import { Router } from 'express';
import { getUsers, createUser, updateUser, deleteUser } from '../controllers/userController';
import { authenticateToken, requireRole } from '../middleware/auth';
import { checkUserLimit } from '../middleware/planGuard';

const router = Router();

router.use(authenticateToken as any);

router.get('/', getUsers as any);
router.post('/', requireRole(['Admin', 'Sales Manager']) as any, checkUserLimit as any, createUser as any);
router.put('/:id', requireRole(['Admin', 'Sales Manager']) as any, updateUser as any);
router.delete('/:id', requireRole(['Admin']) as any, deleteUser as any);

export default router;
