import { Request, Response } from 'express';
import Lead from '../models/Lead';
import Tenant from '../models/Tenant';
import { getIO } from '../services/socket/socketService';
import { getQueue } from '../services/queue/queueConfig';

// Unified Webhook for Lead Sources (Facebook, Google, Portals, Forms)
export const unifiedLeadWebhook = async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    // Normalize properties across common formats (Facebook Ads, Google Ads webhook, 99acres, MagicBricks, etc.)
    let name = payload.name || payload.fullName || payload.lead_name || 'Anonymous';
    let mobile = payload.mobile || payload.phone || payload.phoneNumber || payload.lead_phone;
    let email = payload.email || payload.emailId || payload.lead_email || '';
    let source = payload.source || payload.utm_source || 'Ad Campaign';
    let budget = Number(payload.budget || payload.priceRange || payload.max_budget) || 0;
    let location = payload.location || payload.city || payload.preferred_location || '';
    let propertyType = payload.propertyType || payload.type || 'Any';
    let purpose = payload.purpose || payload.intent || 'Any';

    if (!mobile) {
      return res.status(400).json({ message: 'Mobile number is required in webhook payload' });
    }

    // Clean phone number (remove white spaces, count prefixes)
    mobile = mobile.replace(/\s+/g, '').replace(/[-+]/g, '');

    // Resolve tenantId
    let tenantId = req.body.tenantId || req.query.tenantId || req.headers['x-tenant-id'];

    if (!tenantId) {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];
      if (token) {
        try {
          const secret = process.env.JWT_SECRET || 'super_secret_jwt_key_12345';
          const decoded: any = require('jsonwebtoken').verify(token, secret);
          if (decoded && decoded.tenantId) {
            tenantId = decoded.tenantId;
          }
        } catch (e) {
          // Ignore verification errors
        }
      }
    }

    if (!tenantId) {
      // Fallback: use first available tenant in DB for developer testing/simulations
      const defaultTenant = await Tenant.findOne({});
      if (defaultTenant) {
        tenantId = defaultTenant._id;
      }
    }

    if (!tenantId) {
      return res.status(400).json({ message: 'Tenant context is required to capture lead.' });
    }

    // Deduplicate (scoped by tenant)
    let lead = await Lead.findOne({ tenantId, mobile });

    if (lead) {
      lead.timeline.push({
        event: 'Lead Webhook Match',
        timestamp: new Date(),
        actor: 'System',
        details: `Updated info via webhook from source: ${source}. Previous budget: ${lead.budget}, updated to: ${budget || lead.budget}`,
      });
      lead.budget = budget || lead.budget;
      lead.location = location || lead.location;
      lead.propertyType = propertyType || lead.propertyType;
      lead.purpose = purpose || lead.purpose;
      await lead.save();

      const io = getIO();
      if (io) {
        io.to('/crm').emit('lead:updated', lead);
      }
      return res.status(200).json({ status: 'success', message: 'Deduplicated existing lead', leadId: lead._id });
    } else {
      lead = new Lead({
        tenantId,
        name,
        mobile,
        email,
        source,
        budget,
        location,
        propertyType,
        purpose,
        status: 'New',
        timeline: [
          {
            event: 'Lead Captured via Webhook',
            timestamp: new Date(),
            actor: 'System',
            details: `Source: ${source}, UTM Campaign data detected.`,
          },
        ],
      });
      await lead.save();

      // Trigger AI qualification queue job
      const qualifyQueue = getQueue('qualify-lead');
      if (qualifyQueue) {
        await qualifyQueue.add('qualify', { leadId: lead._id });
      }

      const io = getIO();
      if (io) {
        io.to('/crm').emit('lead:new', lead);
      }

      return res.status(201).json({ status: 'success', message: 'Lead captured', leadId: lead._id });
    }
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

// Meta WhatsApp Webhook Verification
export const verifyWhatsApp = (req: Request, res: Response) => {
  console.log("Verify")
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'aura_verify_token_xyz';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WhatsApp webhook verified successfully!');
    return res.status(200).send(challenge);
  } else {
    return res.status(403).send('Forbidden verification token mismatch');
  }
};

// Meta WhatsApp Message Webhook Receiver
export const receiveWhatsApp = async (req: Request, res: Response) => {
  console.log("===== WHATSAPP WEBHOOK HIT =====");
  console.log(JSON.stringify(req.body, null, 2));
  try {
    const { entry } = req.body;
    if (!entry || entry.length === 0) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const changes = entry[0].changes;
    if (!changes || changes.length === 0) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const value = changes[0].value;
    const messages = value.messages;
    if (!messages || messages.length === 0) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const msg = messages[0];
    const from = msg.from; // Phone number
    const contactName = value.contacts && value.contacts[0] ? value.contacts[0].profile.name : 'WhatsApp User';

    let textBody = '';

    if (msg.type === 'text') {
      textBody = msg.text.body;
    } else if (msg.type === 'button') {
      textBody = msg.button.text;
    } else if (msg.type === 'interactive') {
      const type = msg.interactive.type;
      if (type === 'button_reply') {
        textBody = msg.interactive.button_reply.title;
      } else if (type === 'list_reply') {
        textBody = msg.interactive.list_reply.title;
      }
    }

    if (!textBody) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    // Clean number to search in DB
    const cleanFrom = from.replace(/\s+/g, '').replace(/[-+]/g, '');

    // Resolve tenantId
    let tenantId = (req.query.tenantId as string) || (req.headers['x-tenant-id'] as string);

    if (!tenantId) {
      // Fallback: use first available tenant in DB for developer testing/simulations
      const defaultTenant = await Tenant.findOne({});
      if (defaultTenant) {
        tenantId = defaultTenant._id.toString();
      }
    }

    if (!tenantId) {
      console.error('No tenantId found for WhatsApp webhook. Using empty or throwing error.');
      // Meta requires 200 to not retry, but we can't save without tenant.
      return res.status(200).send('EVENT_RECEIVED');
    }

    // Search for lead
    let lead = await Lead.findOne({ tenantId, mobile: cleanFrom });

    if (!lead) {
      lead = new Lead({
        tenantId,
        name: contactName,
        mobile: cleanFrom,
        source: 'WhatsApp Ads',
        status: 'New',
        timeline: [
          {
            event: 'Lead Initiated WhatsApp',
            timestamp: new Date(),
            actor: 'Lead',
            details: 'First WhatsApp message received from number.',
          },
        ],
      });
      await lead.save();

      const io = getIO();
      if (io) {
        io.to('/crm').emit('lead:new', lead);
      }
    }

    // Trigger dynamic AI conversation chain via BullMQ
    const qualifyQueue = getQueue('qualify-lead');
    if (qualifyQueue) {
      await qualifyQueue.add('conversation-turn', {
        leadId: lead._id,
        message: textBody,
        actor: 'Lead',
      });
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error: any) {
    console.error('Error receiving WhatsApp webhook:', error);
    return res.status(500).send('Webhook process error');
  }
};
