import { Router } from 'express';
import { getInvoices, upgradePlan, razorpayWebhook } from '../controllers/billingController';
import { authenticateToken } from '../middleware/auth';
import { tenantMiddleware } from '../middleware/tenant';

const router = Router();

// Public webhook route (Razorpay callback)
router.post('/razorpay-webhook', razorpayWebhook as any);

// Protected routes
router.get('/invoices', authenticateToken as any, tenantMiddleware as any, getInvoices as any);
router.post('/subscribe', authenticateToken as any, tenantMiddleware as any, upgradePlan as any);

export default router;
