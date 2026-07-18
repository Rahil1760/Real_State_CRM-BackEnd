import { Response } from 'express';
import { TenantRequest } from '../middleware/tenant';
import Visit from '../models/Visit';
import Lead from '../models/Lead';
import Property from '../models/Property';
import BaseRepository from '../repositories/BaseRepository';
import { scoreLeadPostVisit } from '../services/ai/aiService';
import { getIO } from '../services/socket/socketService';
import { sendWhatsAppText } from '../services/whatsapp/whatsappService';
import { sendEmail, sendSMS } from '../services/notificationService';

const visitRepository = new BaseRepository(Visit);
const leadRepository = new BaseRepository(Lead);
const propertyRepository = new BaseRepository(Property);

export const getVisits = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const visits = await Visit.find({ tenantId })
      .populate('leadId', 'name mobile email status score')
      .populate('propertyId', 'title location price type')
      .sort({ scheduledAt: -1 });

    return res.status(200).json(visits);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const createVisit = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { leadId, propertyId, scheduledAt } = req.body;

    if (!leadId || !propertyId || !scheduledAt) {
      return res.status(400).json({ message: 'LeadId, propertyId, and scheduledAt are required' });
    }

    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      return res.status(400).json({ message: 'Invalid date format' });
    }

    // Double-booking check scoped by tenant
    const hourStart = new Date(scheduledDate);
    hourStart.setMinutes(0, 0, 0);
    const hourEnd = new Date(scheduledDate);
    hourEnd.setMinutes(59, 59, 999);

    const existingVisit = await Visit.findOne({
      tenantId,
      propertyId,
      scheduledAt: { $gte: hourStart, $lte: hourEnd },
      status: 'Scheduled',
    });

    if (existingVisit) {
      return res.status(400).json({ message: 'Slot already booked. Choose another time slot.' });
    }

    const lead = await leadRepository.findOne(tenantId, { _id: leadId });
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const property = await propertyRepository.findOne(tenantId, { _id: propertyId });
    if (!property) return res.status(404).json({ message: 'Property not found' });

    const visit = await visitRepository.create(tenantId, {
      leadId,
      propertyId,
      scheduledAt: scheduledDate,
      status: 'Scheduled',
    });

    lead.status = 'Visit Scheduled';
    lead.timeline.push({
      event: 'Visit Scheduled',
      timestamp: new Date(),
      actor: 'AI',
      details: `Scheduled visit for ${property.title} on ${scheduledDate.toLocaleString()}`,
    });
    await lead.save();

    // Trigger alerts
    const msg = `Visit Confirmed: Lead ${lead.name} has scheduled a site visit for property ${property.title} on ${scheduledDate.toLocaleString()}.`;
    await sendWhatsAppText(lead._id.toString(), lead.mobile, `Your visit is confirmed for ${property.title} on ${scheduledDate.toLocaleString()}`);
    await sendEmail(lead._id.toString(), 'sales-admin@realtycloudai.com', 'Site Visit Scheduled', msg);
    await sendSMS(lead._id.toString(), '+15550199', msg);

    const io = getIO();
    if (io) {
      io.to('/crm').emit('lead:updated', lead);
      io.to('/crm').emit('visit:scheduled', visit);
    }

    return res.status(201).json(visit);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const updateVisit = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { status, feedback } = req.body;
    const visitId = req.params.id;

    const visit = await visitRepository.findOne(tenantId, { _id: visitId });
    if (!visit) {
      return res.status(404).json({ message: 'Visit not found' });
    }

    const lead = await leadRepository.findOne(tenantId, { _id: visit.leadId });
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    if (status) {
      visit.status = status;
      
      if (status === 'Completed') {
        lead.status = 'Visit Done';
        lead.timeline.push({
          event: 'Site Visit Completed',
          timestamp: new Date(),
          actor: 'Sales Executive',
          details: 'Executive marked site visit as done. Requesting feedback...',
        });
        
        const feedbackMsg = `Hi ${lead.name}, how was your site visit? Please reply with your feedback.`;
        await sendWhatsAppText(lead._id.toString(), lead.mobile, feedbackMsg);
      } else if (status === 'No-Show') {
        lead.timeline.push({
          event: 'Site Visit No-Show',
          timestamp: new Date(),
          actor: 'System',
          details: 'Lead did not attend the scheduled visit.',
        });

        const noShowCount = lead.timeline.filter(e => e.event === 'Site Visit No-Show').length;
        if (noShowCount >= 2) {
          lead.status = 'Cold';
          lead.score = 'Cold';
          lead.timeline.push({
            event: 'Lead Marked Cold',
            timestamp: new Date(),
            actor: 'System',
            details: 'Marked Cold after 2nd No-Show.',
          });
          await sendWhatsAppText(lead._id.toString(), lead.mobile, `Hi ${lead.name}, since we missed you twice, we have paused scheduling support.`);
        } else {
          const rescheduleMsg = `Hi ${lead.name}, we missed you today! Would you like to reschedule your site visit? Reply with a new date.`;
          await sendWhatsAppText(lead._id.toString(), lead.mobile, rescheduleMsg);
        }
      }
      
      await lead.save();
    }

    if (feedback) {
      visit.feedback = feedback;
      const score = await scoreLeadPostVisit(visit.leadId.toString(), feedback);
      visit.scoreAfterVisit = score as any;
    }

    await visit.save();

    const io = getIO();
    if (io) {
      io.to('/crm').emit('lead:updated', lead);
    }

    return res.status(200).json(visit);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
