import { Router } from 'express';
import { unifiedLeadWebhook, verifyWhatsApp, receiveWhatsApp } from '../controllers/webhookController';

const router = Router();

// Ad Portal webhooks
router.post('/lead', unifiedLeadWebhook as any);

// Meta WhatsApp Cloud API webhooks
router.get('/whatsapp', verifyWhatsApp as any);
router.post('/whatsapp', receiveWhatsApp as any);



export default router;
