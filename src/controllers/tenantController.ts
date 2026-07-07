import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import Tenant from '../models/Tenant';
import User from '../models/User';
import { sendEmail } from '../services/notificationService';

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
      'Welcome to AuraHome SaaS Platform!',
      `Dear ${name},\n\nThank you for choosing AuraHome for your company: ${companyName}.\n\nYour subdomain slug is: ${cleanSlug}. You can log in using: admin@example.com / ${email}.\n\nYour 14-day free trial is active with limits: 50 leads, 2 team users, and 5 properties.\n\nBest,\nThe AuraHome team`
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

    const { whatsappPhoneId, whatsappToken, whatsappWelcomeTemplateName, senderDisplayName } = req.body;

    const tenant = await Tenant.findById(req.tenant._id);
    if (!tenant) {
      return res.status(404).json({ message: 'Tenant not found' });
    }

    if (whatsappPhoneId !== undefined) tenant.whatsappPhoneId = whatsappPhoneId;
    if (whatsappToken !== undefined) tenant.whatsappToken = whatsappToken;
    if (whatsappWelcomeTemplateName !== undefined) tenant.whatsappWelcomeTemplateName = whatsappWelcomeTemplateName;
    if (senderDisplayName !== undefined) tenant.senderDisplayName = senderDisplayName;

    await tenant.save();

    return res.status(200).json({
      message: 'Tenant profile updated successfully',
      tenant
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
