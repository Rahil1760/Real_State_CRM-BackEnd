import { Request, Response } from 'express';
import { TenantRequest } from '../middleware/tenant';
import Tenant from '../models/Tenant';
import Invoice from '../models/Invoice';
import crypto from 'crypto';

// Mapping of subscription tiers to resources limit
const PLAN_LIMITS = {
  free: { maxLeads: 50, maxUsers: 1, maxProperties: 10 },
  starter: { maxLeads: 50, maxUsers: 1, maxProperties: 10 },
  pro: { maxLeads: 1500, maxUsers: 15, maxProperties: 100 },
  growth: { maxLeads: 1500, maxUsers: 15, maxProperties: 100 },
  enterprise: { maxLeads: 999999, maxUsers: 999999, maxProperties: 999999 }, // unlimited
};

export const getInvoices = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const invoices = await Invoice.find({ tenantId }).sort({ createdAt: -1 });
    return res.status(200).json(invoices);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

// Handle manual upgrade or simulation
export const upgradePlan = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { plan, billingCycle, paymentId, paymentMethod } = req.body;
    if (!plan || !['starter', 'pro', 'growth', 'enterprise'].includes(plan)) {
      return res.status(400).json({ message: 'Invalid plan selected' });
    }

    const tenant = await Tenant.findById(tenantId);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

    // Update plan details
    const limits = PLAN_LIMITS[plan as 'starter' | 'pro' | 'growth' | 'enterprise'];
    tenant.plan = plan as any;
    tenant.maxLeads = limits.maxLeads;
    tenant.maxUsers = limits.maxUsers;
    tenant.maxProperties = limits.maxProperties;
    tenant.subscriptionStatus = 'active';
    tenant.billingCycle = billingCycle || 'monthly';
    tenant.subscriptionId = `sub_mock_${Date.now()}`;
    await tenant.save();

    // Log simulated invoice
    let amount = 0;
    if (plan === 'starter') {
      amount = 0;
    } else if (plan === 'pro' || plan === 'growth') {
      amount = billingCycle === 'annual' ? 9999 * 12 : 11999;
    } else if (plan === 'enterprise') {
      amount = 25000;
    }

    const invoice = new Invoice({
      tenantId: tenant._id,
      amount,
      razorpayPaymentId: paymentId || `pay_mock_${Date.now()}`,
      plan,
      billingPeriodStart: new Date(),
      billingPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      status: 'paid',
    });
    await invoice.save();

    return res.status(200).json({
      message: `Plan upgraded to ${plan} successfully!`,
      tenant,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

// Razorpay webhook for platform billing subscriptions
export const razorpayWebhook = async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-razorpay-signature'] as string;
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // Verify signature if secret exists
    if (webhookSecret && signature) {
      const shasum = crypto.createHmac('sha256', webhookSecret);
      shasum.update(JSON.stringify(req.body));
      const digest = shasum.digest('hex');
      if (digest !== signature) {
        return res.status(400).json({ message: 'Invalid webhook signature verification' });
      }
    }

    const { event, payload } = req.body;
    console.log(`[SaaS Billing Webhook] Event: ${event}`);

    // If simulating webhook from sandbox directly, allow custom inputs
    const subId = payload?.subscription?.entity?.id || req.body.subscriptionId;
    const eventType = event || req.body.event;

    if (!subId) {
      return res.status(400).json({ message: 'Subscription ID missing in webhook body' });
    }

    const tenant = await Tenant.findOne({ subscriptionId: subId });
    if (!tenant) {
      // Create fallback check for test subscriptions
      console.log(`Tenant with subscription ID ${subId} not found.`);
      return res.status(200).json({ message: 'No matching tenant found for testing' });
    }

    if (eventType === 'subscription.activated') {
      tenant.subscriptionStatus = 'active';
      await tenant.save();
    } else if (eventType === 'subscription.charged') {
      tenant.subscriptionStatus = 'active';
      await tenant.save();

      // Log invoice payment
      const paymentEntity = payload?.payment?.entity;
      const amount = paymentEntity ? paymentEntity.amount / 100 : 999;
      const paymentId = paymentEntity ? paymentEntity.id : `pay_webhook_${Date.now()}`;

      const invoice = new Invoice({
        tenantId: tenant._id,
        amount,
        razorpayPaymentId: paymentId,
        plan: tenant.plan,
        billingPeriodStart: new Date(),
        billingPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        status: 'paid',
      });
      await invoice.save();
    } else if (eventType === 'subscription.halted') {
      tenant.subscriptionStatus = 'paused';
      await tenant.save();
    } else if (eventType === 'subscription.cancelled') {
      tenant.subscriptionStatus = 'cancelled';
      await tenant.save();
    }

    return res.status(200).json({ status: 'success' });
  } catch (error: any) {
    console.error('Error processing billing webhook:', error.message);
    return res.status(500).json({ message: 'Webhook processing failed' });
  }
};
