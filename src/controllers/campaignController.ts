import { Response } from 'express';
import { TenantRequest } from '../middleware/tenant';
import Campaign from '../models/Campaign';
import Lead from '../models/Lead';
import BaseRepository from '../repositories/BaseRepository';
import { sendWhatsAppText } from '../services/whatsapp/whatsappService';

const campaignRepository = new BaseRepository(Campaign);
const leadRepository = new BaseRepository(Lead);

export const getCampaigns = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const campaigns = await campaignRepository.find(tenantId);
    return res.status(200).json(campaigns);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const createCampaign = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { name, trigger, steps } = req.body;

    if (!name || !trigger || !steps) {
      return res.status(400).json({ message: 'Name, trigger, and steps are required' });
    }

    const campaign = await campaignRepository.create(tenantId, { name, trigger, steps });
    return res.status(201).json(campaign);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const triggerCampaignManual = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { triggerType, messageText } = req.body;

    if (!triggerType || !messageText) {
      return res.status(400).json({ message: 'TriggerType and messageText are required' });
    }

    const bookedLeads = await leadRepository.find(tenantId, { status: 'Booked' });

    for (const lead of bookedLeads) {
      await sendWhatsAppText(lead._id.toString(), lead.mobile, `[${triggerType}] ${messageText}`);
      
      lead.timeline.push({
        event: `${triggerType} Campaign Dispatched`,
        timestamp: new Date(),
        actor: 'Admin',
        details: `Message: "${messageText}"`,
      });
      await lead.save();
    }

    return res.status(200).json({
      message: `Campaign manual trigger dispatched to ${bookedLeads.length} leads successfully.`,
      recipientCount: bookedLeads.length,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
