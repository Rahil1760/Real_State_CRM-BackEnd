import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import Tenant from '../models/Tenant';
import User from '../models/User';
import { sendEmail } from '../services/notificationService';
import Redis from 'ioredis';
import { getConnection } from '../services/queue/queueConfig';

let redisClient: Redis | null = null;
const getRedis = () => {
  if (!redisClient) {
    const opts = getConnection();
    redisClient = new Redis(opts);
  }
  return redisClient;
};

export const registerTenant = async (req: Request, res: Response) => {
  try {
    const { companyName, slug, name, email, phone, password } = req.body;

    if (!companyName || !slug || !name || !email || !phone || !password) {
      return res.status(400).json({ message: 'All registration fields are required' });
    }

    const cleanSlug = slug.replace(/\s+/g, '').toLowerCase();

    // Check if slug is unique
    const existingTenant = await Tenant.findOne({ slug: cleanSlug });
    if (existingTenant) {
      return res.status(400).json({ message: 'Subdomain / Slug is already in use.' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: 'User email already exists.' });
    }

    // 1. Create Tenant Profile (Trial setup)
    const tenant = new Tenant({
      name: companyName,
      slug: cleanSlug,
      ownerEmail: email.toLowerCase(),
      phone,
      plan: 'free',
      subscriptionStatus: 'trial',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days trial
      maxLeads: 50,
      maxUsers: 2,
      maxProperties: 5,
    });
    await tenant.save();

    // 2. Create Owner User
    const passwordHash = await bcrypt.hash(password, 10);
    const ownerUser = new User({
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: 'Admin',
      tenantId: tenant._id,
    });
    await ownerUser.save();

    // 3. Send welcome email (mocked or actual)
    await sendEmail(
      null,
      email,
      'Welcome to NextLead SaaS Platform!',
      `Dear ${name},\n\nThank you for choosing NextLead for your company: ${companyName}.\n\nYour subdomain slug is: ${cleanSlug}. You can log in using: ${email.toLowerCase()}.\n\nYour 14-day free trial is active with limits: 50 leads, 2 team users, and 5 properties.\n\nBest,\nThe NextLead team`
    );

    return res.status(201).json({
      message: 'Tenant onboarding completed successfully!',
      tenant: {
        id: tenant._id,
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan,
        trialEndsAt: tenant.trialEndsAt,
      },
      user: {
        id: ownerUser._id,
        name: ownerUser.name,
        email: ownerUser.email,
        role: ownerUser.role,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const getTenantProfile = async (req: any, res: Response) => {
  try {
    if (!req.tenant) {
      return res.status(404).json({ message: 'Tenant profile not loaded' });
    }
    return res.status(200).json(req.tenant);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const updateTenantProfile = async (req: any, res: Response) => {
  try {
    if (!req.tenant) {
      return res.status(404).json({ message: 'Tenant profile not loaded' });
    }

    const { whatsappPhoneId, whatsappToken, whatsappWelcomeTemplateName, senderDisplayName, marketingSpend, marketingSpendBreakdown } = req.body;

    const tenant = await Tenant.findById(req.tenant._id);
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    if (whatsappPhoneId !== undefined) {
      const trimmedPhoneId = whatsappPhoneId.trim();
      if (!trimmedPhoneId) {
        return res.status(400).json({ message: 'WhatsApp Phone ID is required and cannot be empty.' });
      }
      if (!/^\d{15,18}$/.test(trimmedPhoneId)) {
        return res.status(400).json({ message: 'Invalid WhatsApp Phone ID. It must be a 15 to 18-digit number.' });
      }
      tenant.whatsappPhoneId = trimmedPhoneId;
    }

    if (whatsappToken !== undefined) {
      const trimmedToken = whatsappToken.trim();
      if (!trimmedToken) {
        return res.status(400).json({ message: 'Access Token is required and cannot be empty.' });
      }
      if (!/^EA[a-zA-Z0-9_-]+$/.test(trimmedToken)) {
        return res.status(400).json({ message: 'Invalid Access Token. It must be a valid Meta Access Token starting with "EA".' });
      }
      tenant.whatsappToken = trimmedToken;
    }
    if (whatsappWelcomeTemplateName !== undefined) tenant.whatsappWelcomeTemplateName = whatsappWelcomeTemplateName;
    if (senderDisplayName !== undefined) tenant.senderDisplayName = senderDisplayName;
    if (marketingSpend !== undefined) tenant.marketingSpend = Number(marketingSpend) || 0;
    
    if (marketingSpendBreakdown) {
      tenant.marketingSpendBreakdown = {
        meta: Number(marketingSpendBreakdown.meta) || 0,
        google: Number(marketingSpendBreakdown.google) || 0,
        other: Number(marketingSpendBreakdown.other) || 0,
      };
      tenant.marketingSpend = tenant.marketingSpendBreakdown.meta + tenant.marketingSpendBreakdown.google + tenant.marketingSpendBreakdown.other;
    }

    await tenant.save();

    // Invalidate Redis cache
    try {
      const redis = getRedis();
      const tenantIdStr = tenant._id.toString();
      const slugStr = tenant.slug || '';
      await redis.del(`tenant:id:${tenantIdStr}`);
      if (slugStr) {
        await redis.del(`tenant:slug:${slugStr}`);
      }
    } catch (cacheErr) {
      console.error('Error clearing tenant cache:', cacheErr);
    }

    return res.status(200).json({
      message: 'Tenant profile updated successfully',
      tenant
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
