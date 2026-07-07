import { Router } from 'express';
import { getBookings, createBookingRequest, approveBooking, paymentWebhook } from '../controllers/bookingController';
import { authenticateToken, requireRole } from '../middleware/auth';

const router = Router();

// Public webhook route (Razorpay callback)
router.post('/payment-webhook', paymentWebhook as any);

// Protected routes
router.get('/', authenticateToken as any, getBookings as any);
router.post('/', authenticateToken as any, createBookingRequest as any);
router.put('/:id/approve', authenticateToken as any, requireRole(['Admin', 'Sales Manager']) as any, approveBooking as any);

export default router;
