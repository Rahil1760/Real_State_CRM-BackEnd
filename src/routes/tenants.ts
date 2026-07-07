import { Router } from 'express';
import { registerTenant, getTenantProfile, updateTenantProfile } from '../controllers/tenantController';
import { authenticateToken } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';

const router = Router();

// Public register onboarding
router.post('/register', registerTenant);

// Scoped profile reading
router.get('/profile', authenticateToken as any, tenantMiddleware as any, getTenantProfile as any);

// Scoped profile update
router.put('/profile', authenticateToken as any, tenantMiddleware as any, updateTenantProfile as any);

export default router;
