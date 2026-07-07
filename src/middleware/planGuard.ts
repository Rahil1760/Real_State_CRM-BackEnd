import { Response, NextFunction } from 'express';
import { TenantRequest } from './tenant';
import Lead from '../models/Lead';
import User from '../models/User';
import Property from '../models/Property';

export const checkLeadLimit = async (
  req: TenantRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.tenant) return next();

    const limit = req.tenant.maxLeads;
    const currentCount = await Lead.countDocuments({ tenantId: req.tenant._id });

    if (currentCount >= limit) {
      return res.status(429).json({
        message: `Plan Lead limit reached (${currentCount}/${limit}). Please upgrade your subscription tier to capture more leads.`,
        limitReached: true,
      });
    }

    next();
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Error enforcing lead limits' });
  }
};

export const checkUserLimit = async (
  req: TenantRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.tenant) return next();

    const limit = req.tenant.maxUsers;
    const currentCount = await User.countDocuments({ tenantId: req.tenant._id });

    if (currentCount >= limit) {
      return res.status(429).json({
        message: `Plan User limit reached (${currentCount}/${limit}). Upgrade your platform subscription to register more team members.`,
        limitReached: true,
      });
    }

    next();
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Error enforcing user limits' });
  }
};

export const checkPropertyLimit = async (
  req: TenantRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.tenant) return next();

    const limit = req.tenant.maxProperties;
    const currentCount = await Property.countDocuments({ tenantId: req.tenant._id });

    if (currentCount >= limit) {
      return res.status(429).json({
        message: `Plan Property limit reached (${currentCount}/${limit}). Upgrade your tier to upload additional property listings.`,
        limitReached: true,
      });
    }

    next();
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Error enforcing property limits' });
  }
};
