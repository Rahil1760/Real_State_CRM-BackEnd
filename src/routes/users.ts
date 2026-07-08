import { Router } from 'express';
import { getUsers, createUser, updateUser, deleteUser } from '../controllers/userController';
import { authenticateToken, requireRole } from '../middleware/auth';
import { checkUserLimit } from '../middleware/planGuard';

const router = Router();

router.use(authenticateToken as any);
router.use(requireRole(['Admin']) as any);

router.get('/', getUsers as any);
router.post('/', checkUserLimit as any, createUser as any);
router.put('/:id', updateUser as any);
router.delete('/:id', deleteUser as any);

export default router;
