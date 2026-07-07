import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import Tenant, { ITenant } from '../models/Tenant';
import { getConnection } from '../services/queue/queueConfig';

export interface TenantRequest extends Request {
  tenant?: ITenant;
}

let redisClient: Redis | null = null;

const getRedis = () => {
  if (!redisClient) {
    const opts = getConnection();
    redisClient = new Redis(opts);
  }
  return redisClient;
};

export const tenantMiddleware = async (
  req: TenantRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    let tenantId = req.headers['x-tenant-id'] as string;
    let tenantSlug = '';

    console.log('tenantId', tenantId, tenantSlug)

    // Step 1: Resolve from hostname subdomain (Option B)
    // E.g., rahilbuilders.yourapp.com -> rahilbuilders
    const host = req.hostname;
    const domainParts = host.split('.');
    if (domainParts.length > 2 && domainParts[0] !== 'www' && domainParts[0] !== 'localhost') {
      tenantSlug = domainParts[0].toLowerCase();
    }

    // Step 2: Resolve from URL path segment (Option A) or JWT token if already decoded
    // In our JWT decoder middleware, we decode and attach `req.user`. If req.user has tenantId, we prioritize it.
    const userTenantId = (req as any).user?.tenantId;
    if (userTenantId) {
      tenantId = String(userTenantId);
    }

    // Resolve by tenantId or tenantSlug
    if (!tenantId && !tenantSlug && !userTenantId) {
      // If we are hitting health checks or public landing registration routes, bypass
      if (req.path === '/health' || req.path.startsWith('/auth/register-tenant') || req.path.startsWith('/billing/razorpay-webhook')) {
        return next();
      }
      return res.status(400).json({ message: 'Tenant context missing. Provide x-tenant-id header or login context.' });
    }

    let tenant: ITenant | null = null;
    const redis = getRedis();

    // Cache lookup key
    const cacheKey = tenantId ? `tenant:id:${tenantId}` : `tenant:slug:${tenantSlug}`;
    const cachedTenant = await redis.get(cacheKey);

    if (cachedTenant) {
      tenant = JSON.parse(cachedTenant);
    } else {
      if (tenantId) {
        tenant = await Tenant.findById(tenantId);
      } else if (tenantSlug) {
        tenant = await Tenant.findOne({ slug: tenantSlug });
      }

      if (tenant) {
        // Cache in redis for 5 minutes (300 seconds)
        await redis.set(cacheKey, JSON.stringify(tenant), 'EX', 300);
      }
    }

    if (!tenant) {
      return res.status(404).json({ message: 'Tenant profile not found.' });
    }

    // Step 3: Subscription & Trial Checks
    const now = new Date();

    if (tenant.subscriptionStatus === 'trial' && tenant.trialEndsAt < now) {
      return res.status(402).json({
        message: 'Trial expired. Payment Required. Please upgrade your plan to unlock dashboards.',
        status: 'trial_expired',
      });
    }

    if (tenant.subscriptionStatus === 'cancelled') {
      return res.status(403).json({
        message: 'Subscription cancelled. Please activate payment plan in billing portals to continue.',
        status: 'cancelled',
      });
    }

    // Attach tenant profile to request object
    req.tenant = tenant;
    next();
  } catch (error: any) {
    console.error('[Tenant Middleware] Error:', error.message);
    return res.status(500).json({ message: 'Internal server error resolving tenant context.' });
  }
};
