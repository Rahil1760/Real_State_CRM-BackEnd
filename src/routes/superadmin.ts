import { Router } from 'express';
import { getTenants, getTenantDetail, planOverride, impersonateTenant, getSuperAdminStats } from '../controllers/superadminController';
import { authenticateToken } from '../middleware/auth';
import { requireSuperAdmin } from '../middleware/superadmin';

const router = Router();

router.use(authenticateToken as any);
router.use(requireSuperAdmin as any);

router.get('/tenants', getTenants as any);
router.get('/tenants/:id', getTenantDetail as any);
router.post('/tenants/:id/override', planOverride as any);
router.post('/tenants/:id/impersonate', impersonateTenant as any);
router.get('/stats', getSuperAdminStats as any);

export default router;
