import { Request, Response } from 'express';
import Tenant from '../models/Tenant';
import Lead from '../models/Lead';
import User from '../models/User';
import Invoice from '../models/Invoice';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_12345';

export const getTenants = async (req: Request, res: Response) => {
    try {
        const tenants = await Tenant.find().sort({ createdAt: -1 });
        const formattedTenants = [];

        for (const tenant of tenants) {
            const leadsCount = await Lead.countDocuments({ tenantId: tenant._id });
            const usersCount = await User.countDocuments({ tenantId: tenant._id });

            // Calculate MRR contribution from paid invoices in the last 30 days
            const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const invoices = await Invoice.find({
                tenantId: tenant._id,
                status: 'paid',
                createdAt: { $gte: lastMonth },
            });
            const mrr = invoices.reduce((sum, inv) => sum + inv.amount, 0);

            formattedTenants.push({
                id: tenant._id,
                name: tenant.name,
                slug: tenant.slug,
                plan: tenant.plan,
                status: tenant.subscriptionStatus,
                trialEndsAt: tenant.trialEndsAt,
                leadsCount,
                usersCount,
                mrr,
            });
        }

        return res.status(200).json(formattedTenants);
    } catch (error: any) {
        return res.status(500).json({ message: error.message || 'Internal server error' });
    }
};

export const getTenantDetail = async (req: Request, res: Response) => {
    try {
        const tenantId = req.params.id;
        const tenant = await Tenant.findById(tenantId);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const leadsCount = await Lead.countDocuments({ tenantId });
        const usersCount = await User.countDocuments({ tenantId });
        const invoices = await Invoice.find({ tenantId }).sort({ createdAt: -1 });

        return res.status(200).json({
            tenant,
            stats: {
                leadsCount,
                usersCount,
            },
            invoices,
        });
    } catch (error: any) {
        return res.status(500).json({ message: error.message || 'Internal server error' });
    }
};

export const planOverride = async (req: Request, res: Response) => {
    try {
        const { plan, subscriptionStatus, trialEndsAt } = req.body;
        const tenant = await Tenant.findById(req.params.id);

        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        if (plan) {
            tenant.plan = plan;
            const limits = {
                free: { maxLeads: 50, maxUsers: 2, maxProperties: 5 },
                starter: { maxLeads: 500, maxUsers: 5, maxProperties: 20 },
                pro: { maxLeads: 5000, maxUsers: 15, maxProperties: 100 },
                enterprise: { maxLeads: 999999, maxUsers: 999999, maxProperties: 999999 },
            }[plan as 'free' | 'starter' | 'pro' | 'enterprise'] || PLAN_LIMITS_FALLBACK();

            tenant.maxLeads = limits.maxLeads;
            tenant.maxUsers = limits.maxUsers;
            tenant.maxProperties = limits.maxProperties;
        }

        if (subscriptionStatus) {
            tenant.subscriptionStatus = subscriptionStatus;
        }

        if (trialEndsAt) {
            tenant.trialEndsAt = new Date(trialEndsAt);
        }

        await tenant.save();

        return res.status(200).json({ message: 'Plan limits overridden successfully', tenant });
    } catch (error: any) {
        return res.status(500).json({ message: error.message || 'Internal server error' });
    }
};

const PLAN_LIMITS_FALLBACK = () => ({ maxLeads: 50, maxUsers: 2, maxProperties: 5 });

export const impersonateTenant = async (req: Request, res: Response) => {
    try {
        const tenant = await Tenant.findById(req.params.id);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        // Generate short-lived impersonation JWT (15 mins)
        const payload = {
            id: (req as any).user?.id,
            email: (req as any).user?.email,
            role: 'Admin', // Elevate to Admin inside that tenant's dashboard scope!
            tenantId: tenant._id,
            impersonatorId: (req as any).user?.id,
        };

        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });

        return res.status(200).json({
            message: `Impersonation token generated for ${tenant.name}`,
            token,
            tenantSlug: tenant.slug,
        });
    } catch (error: any) {
        return res.status(500).json({ message: error.message || 'Internal server error' });
    }
};

export const getSuperAdminStats = async (req: Request, res: Response) => {
    try {
        const totalTenants = await Tenant.countDocuments();
        const activeTenants = await Tenant.countDocuments({ subscriptionStatus: 'active' });
        const trialTenants = await Tenant.countDocuments({ subscriptionStatus: 'trial' });

        // Computed MRR
        const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const invoices = await Invoice.find({ status: 'paid', createdAt: { $gte: lastMonth } });
        const totalMRR = invoices.reduce((sum, inv) => sum + inv.amount, 0);

        // Churn calculation: cancelled count vs active count
        const cancelledCount = await Tenant.countDocuments({ subscriptionStatus: 'cancelled' });
        const churnRate = totalTenants > 0 ? (cancelledCount / totalTenants) * 100 : 0;

        return res.status(200).json({
            summary: {
                totalTenants,
                activeTenants,
                trialTenants,
                mrr: totalMRR,
                churnRate: Number(churnRate.toFixed(2)),
            },
        });
    } catch (error: any) {
        return res.status(500).json({ message: error.message || 'Internal server error' });
    }
};
