import { Request, Response } from 'express';
import Lead from '../models/Lead';
import Tenant from '../models/Tenant';
import OpenWASession from '../models/OpenWASession';
import { getIO } from '../services/socket/socketService';
import { getQueue } from '../services/queue/queueConfig';
import { sendWhatsAppText, sendWhatsAppTemplate, formatWhatsAppNumber } from '../services/whatsapp/whatsappService';
import { processNormalizedInboundMessage } from '../services/whatsapp/openwaService';

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

    // Clean & format phone number (handles +91, 91, 0, or 10-digit numbers)
    mobile = formatWhatsAppNumber(mobile);

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
      // Check if lead limit is reached before creating!
      const tenant = await Tenant.findById(tenantId);
      if (tenant) {
        const currentCount = await Lead.countDocuments({ tenantId });
        if (currentCount >= tenant.maxLeads) {
          return res.status(429).json({
            message: `Lead limit reached (${currentCount}/${tenant.maxLeads}) for this workspace. Please contact support.`,
            limitReached: true,
          });
        }
      }

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

      // 1. Queue AI qualification background job
      let queueSuccess = false;
      try {
        const qualifyQueue = getQueue('qualify-lead');
        if (qualifyQueue) {
          await qualifyQueue.add('qualify', { leadId: lead._id });
          queueSuccess = true;
        }
      } catch (queueErr: any) {
        console.warn('[Lead Webhook] Queue error (Redis offline?):', queueErr.message);
      }

      // 2. Direct Welcome Template Dispatch (Fallback if Redis queue is unavailable)
      if (!queueSuccess) {
        const capturedLeadId = lead._id.toString();
        const capturedMobile = lead.mobile;
        const capturedName = lead.name;
        const capturedTenantId = lead.tenantId;

        setImmediate(async () => {
          try {
            const tenantObj = await Tenant.findById(capturedTenantId);
            const welcomeTemplate = tenantObj?.whatsappWelcomeTemplateName || 'welcome_massage';
            const firstName = capturedName ? capturedName.split(' ')[0] : 'there';

            await sendWhatsAppTemplate(
              capturedLeadId,
              capturedMobile,
              welcomeTemplate,
              [{ type: 'text', text: firstName }],
              'en_US'
            );
          } catch (dispatchErr: any) {
            console.error('[Lead Webhook Direct] Failed to send welcome template:', dispatchErr.message);
          }
        });
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

// Meta & OpenWA WhatsApp Message Webhook Receiver
export const receiveWhatsApp = async (req: Request, res: Response) => {
  console.log("===== WHATSAPP WEBHOOK HIT =====");
  console.log(JSON.stringify(req.body, null, 2));
  try {
    const { entry } = req.body;
    if (!entry || entry.length === 0) {
      // Check if this is an OpenWA or custom WhatsApp webhook payload
      const body = req.body || {};
      const extractStringOrId = (val: any): string => {
        if (!val) return '';
        if (typeof val === 'string') return val;
        if (typeof val === 'number') return String(val);
        if (typeof val === 'object') {
          return val.id || val.phone || val.mobile || val.jid || val.number || '';
        }
        return '';
      };

      const rawPhoneCandidate =
        extractStringOrId(body.leadPhone) ||
        extractStringOrId(body.from) ||
        extractStringOrId(body.phone) ||
        extractStringOrId(body.mobile) ||
        extractStringOrId(body.sender) ||
        extractStringOrId(body.data?.from) ||
        extractStringOrId(body.data?.phone) ||
        extractStringOrId(body.data?.mobile) ||
        extractStringOrId(body.data?.sender);

      const textMessage = body.message || body.body || body.text || body.data?.message || body.data?.body || body.data?.text;

      // Ignore group messages, broadcasts, or status updates
      const isGroup =
        body.isGroupMsg ||
        body.data?.isGroupMsg ||
        body.isGroup ||
        body.data?.isGroup ||
        rawPhoneCandidate.endsWith('@g.us') ||
        rawPhoneCandidate.includes('broadcast') ||
        rawPhoneCandidate.includes('status');

      if (isGroup) {
        console.log('[OpenWA Webhook] Ignored group message or broadcast');
        return res.status(200).send('EVENT_RECEIVED');
      }

      if (rawPhoneCandidate && textMessage) {
        const cleanPhone = formatWhatsAppNumber(rawPhoneCandidate);
        const last10 = cleanPhone.slice(-10);
        const mobileOrQuery = [
          { mobile: cleanPhone },
          { mobile: last10 },
          { mobile: `+${cleanPhone}` },
          { mobile: `0${last10}` },
          { mobile: `91${last10}` }
        ];

        let tenantId = body.tenantId || req.query.tenantId || req.headers['x-tenant-id'];

        // 1. Check if lead exists across ALL tenants using multi-format phone query
        if (!tenantId && cleanPhone) {
          const existingLead = await Lead.findOne({ $or: mobileOrQuery }).sort({ updatedAt: -1 });
          if (existingLead) {
            tenantId = existingLead.tenantId.toString();
            console.log(`[OpenWA Webhook] Matched existing lead (${existingLead._id}) in tenant (${tenantId}) for phone: ${cleanPhone}`);
          }
        }

        // 2. Check for active connected OpenWASession
        if (!tenantId) {
          const activeSession = await OpenWASession.findOne({ status: 'connected' });
          if (activeSession) {
            tenantId = activeSession.tenantId.toString();
            console.log(`[OpenWA Webhook] Resolved tenantId (${tenantId}) from connected OpenWASession`);
          }
        }

        // 3. Fallback to default tenant
        if (!tenantId) {
          const defaultTenant = await Tenant.findOne({});
          if (defaultTenant) {
            tenantId = defaultTenant._id.toString();
          }
        }

        if (tenantId) {
          const leadName =
            body.leadName ||
            body.name ||
            body.pushName ||
            body.senderName ||
            body.sender?.pushname ||
            body.sender?.name ||
            body.data?.pushName ||
            'WhatsApp User';

          await processNormalizedInboundMessage({
            tenantId: tenantId.toString(),
            leadPhone: rawPhoneCandidate,
            leadName,
            message: String(textMessage),
            timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
            source: 'openwa',
          });
          return res.status(200).send('EVENT_RECEIVED');
        }
      }

      return res.status(200).send('EVENT_RECEIVED');
    }

    const changes = entry[0].changes;
    if (!changes || changes.length === 0) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const value = changes[0].value;

    // Handle Meta status updates (sent, delivered, read, failed)
    const statuses = value.statuses;
    if (statuses && statuses.length > 0) {
      const statusObj = statuses[0];
      const recipientId = statusObj.recipient_id;
      const status = statusObj.status; // 'sent', 'delivered', 'read', 'failed'
      const errors = statusObj.errors;

      console.log(`[WhatsApp Webhook Status] Recipient: ${recipientId}, Status: ${status}`);

      if (recipientId) {
        const cleanRecipient = recipientId.replace(/\s+/g, '').replace(/[-+]/g, '');
        const lead = await Lead.findOne({ mobile: cleanRecipient }).sort({ updatedAt: -1 });
        if (lead) {
          const io = getIO();
          if (io) {
            io.to('/crm').emit('whatsapp:message', {
              leadId: lead._id.toString(),
              direction: 'outbound',
              channel: 'WhatsApp',
              status: status === 'failed' ? 'failed' : status,
              text: status === 'failed' && errors && errors[0] ? `Failed: ${errors[0].title || errors[0].message}` : `Status: ${status}`,
              timestamp: new Date(),
            });
            if (status === 'failed' && errors && errors[0]) {
              lead.timeline.push({
                event: 'WhatsApp Delivery Failed',
                timestamp: new Date(),
                actor: 'System',
                details: `Meta Cloud API Error: ${errors[0].title || errors[0].message} (Code: ${errors[0].code})`,
              });
              await lead.save();
              io.to('/crm').emit('lead:updated', lead);
            }
          }
        }
      }
    }

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
    const cleanFrom = formatWhatsAppNumber(from);
    const last10 = cleanFrom.slice(-10);
    const mobileOrQuery = [
      { mobile: cleanFrom },
      { mobile: last10 },
      { mobile: `+${cleanFrom}` },
      { mobile: `0${last10}` },
      { mobile: `91${last10}` }
    ];

    // Resolve tenantId
    let tenantId = (req.query.tenantId as string) || (req.headers['x-tenant-id'] as string);

    // Try resolving by phone number ID from Meta metadata
    const phone_number_id = value.metadata?.phone_number_id;
    if (!tenantId && phone_number_id) {
      const tenants = await Tenant.find({});
      const matchingTenant = tenants.find(
        (t) => t.whatsappPhoneId === phone_number_id || t.metaConfig?.phoneNumberId === phone_number_id
      );
      if (matchingTenant) {
        tenantId = matchingTenant._id.toString();
        console.log(`[WhatsApp Webhook] Resolved tenantId (${tenantId}) from phone_number_id: ${phone_number_id}`);
      }
    }

    // Try resolving by existing lead mobile number
    if (!tenantId) {
      const existingLead = await Lead.findOne({ $or: mobileOrQuery }).sort({ updatedAt: -1 });
      if (existingLead) {
        tenantId = existingLead.tenantId.toString();
        console.log(`[WhatsApp Webhook] Resolved tenantId (${tenantId}) from existing lead mobile: ${cleanFrom}`);
      }
    }

    // Fallback: use first available tenant in DB
    if (!tenantId) {
      const defaultTenant = await Tenant.findOne({});
      if (defaultTenant) {
        tenantId = defaultTenant._id.toString();
        console.log(`[WhatsApp Webhook] Falling back to default tenantId: ${tenantId}`);
      }
    }

    if (!tenantId) {
      console.error('No tenantId found for WhatsApp webhook. Using empty or throwing error.');
      // Meta requires 200 to not retry, but we can't save without tenant.
      return res.status(200).send('EVENT_RECEIVED');
    }

    // Search for lead using multi-format query
    let lead = await Lead.findOne({ tenantId, $or: mobileOrQuery }).sort({ updatedAt: -1 });

    if (!lead) {
      // Fallback cross-tenant search to prevent duplicate lead creation
      lead = await Lead.findOne({ $or: mobileOrQuery }).sort({ updatedAt: -1 });
      if (lead) {
        console.log(`[Meta WhatsApp Webhook] Matched existing lead (${lead._id}) in tenant (${lead.tenantId}) for mobile ${cleanFrom}`);
      }
    }

    if (!lead) {
      // Check if lead limit is reached before creating!
      const tenant = await Tenant.findById(tenantId);
      if (tenant) {
        const currentCount = await Lead.countDocuments({ tenantId });
        if (currentCount >= tenant.maxLeads) {
          console.warn(`[Limit Exceeded] Tenant ${tenantId} reached maxLeads limit (${currentCount}/${tenant.maxLeads}) via WhatsApp webhook intake.`);
          const limitMessage = `Thank you for contacting us! We are currently unable to register new requests. Please contact support.`;
          await sendWhatsAppText('', cleanFrom, limitMessage, true, tenantId);
          return res.status(200).send('EVENT_RECEIVED');
        }
      }

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

    // Save incoming message to Lead chat history immediately
    lead.chatHistory.push({ role: 'user', text: textBody });
    await lead.save();

    const io = getIO();
    if (io) {
      io.to('/crm').emit('lead:updated', lead);
      io.to('/crm').emit('whatsapp:message', {
        leadId: lead._id.toString(),
        direction: 'inbound',
        channel: 'WhatsApp',
        status: 'received',
        text: textBody,
        timestamp: new Date(),
      });
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
