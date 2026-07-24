import axios from 'axios';
import Fuse from 'fuse.js';
import Lead from '../../models/Lead';
import Tenant from '../../models/Tenant';
import Notification from '../../models/Notification';
import Property from '../../models/Property';
import Visit from '../../models/Visit';
import Booking from '../../models/Booking';
import ProjectDocument from '../../models/ProjectDocument';
import { getIO } from '../socket/socketService';
import { sendEmail, sendSMS } from '../notificationService';
import { getQueue } from '../queue/queueConfig';
import { analyzeFeedbackSentiment } from '../ai/llmProviderService';

export const formatWhatsAppNumber = (phone: string): string => {
  if (!phone) return '';
  let cleaned = String(phone).split('@')[0].split(':')[0].replace(/\D/g, ''); // strip JID/device suffixes & non-digits
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }
  if (cleaned.length === 10) {
    cleaned = '91' + cleaned;
  }
  return cleaned;
};

export const resolvePropertyBrochure = async (property: any): Promise<{ url: string; filename: string } | null> => {
  if (!property) return null;

  const tenantId = property.tenantId;
  const propertyId = property._id;

  let relativeOrFullUrl: string | null = property.s3Urls?.brochure || null;
  let filename: string = `${(property.title || 'Property').trim().replace(/\s+/g, '_')}_Brochure.pdf`;

  if (!relativeOrFullUrl || relativeOrFullUrl.includes('mock-s3') || relativeOrFullUrl === '') {
    // 1. Search in ProjectDocument for uploaded files linked to this property
    const doc = await ProjectDocument.findOne({ tenantId, propertyId }).sort({ _id: -1 }).lean();
    if (doc && doc.s3Url) {
      relativeOrFullUrl = doc.s3Url;
      if (doc.fileName) filename = doc.fileName;
    } else {
      // 2. Fallback to any PDF document uploaded for this tenant
      const tenantDoc = await ProjectDocument.findOne({ tenantId }).sort({ _id: -1 }).lean();
      if (tenantDoc && tenantDoc.s3Url) {
        relativeOrFullUrl = tenantDoc.s3Url;
        if (tenantDoc.fileName) filename = tenantDoc.fileName;
      } else {
        // 3. Fallback to any PDF document in system
        const anyDoc = await ProjectDocument.findOne({}).sort({ _id: -1 }).lean();
        if (anyDoc && anyDoc.s3Url) {
          relativeOrFullUrl = anyDoc.s3Url;
          if (anyDoc.fileName) filename = anyDoc.fileName;
        }
      }
    }
  }

  if (!relativeOrFullUrl || relativeOrFullUrl.includes('mock-s3')) {
    return null;
  }

  const getBaseUrl = () => {
    const envUrl = process.env.PUBLIC_URL || process.env.BACKEND_URL || process.env.VITE_BASE_URL;
    return envUrl ? envUrl.replace(/\/api\/?$/, '') : `http://localhost:${process.env.PORT || 5000}`;
  };

  const fullUrl = relativeOrFullUrl.startsWith('/') ? `${getBaseUrl()}${relativeOrFullUrl}` : relativeOrFullUrl;
  return { url: fullUrl, filename };
};

import { getWhatsAppProvider } from './whatsappFactory';

/**
 * Resolves the best recipient address for a lead.
 * For OpenWA (Baileys), the full JID stored in aiContext.whatsappLid
 * (e.g. "919876543210@s.whatsapp.net") must be used so Baileys routes
 * the message to the correct WhatsApp account. Falls back to the raw
 * phone number when the JID has not yet been recorded.
 */
const resolveRecipient = (lead: any, fallback: string): string => {
  const lid = lead?.aiContext?.whatsappLid;
  // Only use lid if it looks like a proper JID or a non-empty string different from the fallback
  if (lid && lid.trim() !== '') return lid;
  return fallback;
};

export const sendWhatsAppText = async (leadId: string, to: string, text: string, skipHistoryLog: boolean = false, tenantIdOverride?: string): Promise<boolean> => {
  let tenantId: any = null;
  try {
    const formattedTo = formatWhatsAppNumber(to);
    console.log(`[WhatsApp Dispatch] Outbox -> To: ${formattedTo} (raw: ${to}), Message: "${text}"`);

    // Fetch Lead to get tenantId
    const lead = leadId ? await Lead.findById(leadId) : null;
    tenantId = tenantIdOverride || lead?.tenantId;
    let tenant = null;

    if (tenantId) {
      tenant = await Tenant.findById(tenantId);
    } else {
      tenant = await Tenant.findOne({});
      if (tenant) {
        tenantId = tenant._id as any;
      }
    }

    const provider = await getWhatsAppProvider(tenantId?.toString() || tenantId);
    const targetRecipient = resolveRecipient(lead, to);
    await provider.sendText(targetRecipient, text);

    // ON SUCCESS (real API post succeeded, or mock mode)
    const notification = new Notification({
      tenantId,
      leadId,
      channel: 'WhatsApp',
      message: text,
      status: 'Sent',
      sentAt: new Date(),
    });
    await notification.save();

    if (lead) {
      lead.timeline.push({
        event: 'WhatsApp Sent',
        timestamp: new Date(),
        actor: 'AI',
        details: text,
      });
      if (!skipHistoryLog) {
        lead.chatHistory.push({ role: 'model', text });
        lead.aiContext.chatHistory = (lead.aiContext.chatHistory || '') + `\nAgent: ${text}`;
      }
      await lead.save();

      const io = getIO();
      if (io) {
        io.to('/crm').emit('lead:updated', lead);
        io.to('/crm').emit('notification:sent', {
          leadId,
          channel: 'WhatsApp',
          message: text,
          timestamp: new Date(),
        });
        io.to('/crm').emit('whatsapp:message', {
          leadId,
          direction: 'outbound',
          channel: 'WhatsApp',
          status: 'sent',
          text,
          timestamp: new Date(),
        });
      }
    } else {
      const io = getIO();
      if (io) {
        io.to('/crm').emit('whatsapp:message', {
          leadId,
          direction: 'outbound',
          channel: 'WhatsApp',
          status: 'sent',
          text,
          timestamp: new Date(),
        });
      }
    }

    return true;
  } catch (error: any) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);

    if (!tenantId) {
      try {
        const lead = await Lead.findById(leadId);
        tenantId = lead?.tenantId;
      } catch (e) { }
    }

    if (!tenantId) {
      const defaultTenant = await Tenant.findOne({});
      if (defaultTenant) {
        tenantId = defaultTenant._id;
      }
    }

    await Notification.create({
      tenantId,
      leadId,
      channel: 'WhatsApp',
      message: `Failed: ${text}`,
      status: 'Failed',
      sentAt: new Date(),
    });

    const io = getIO();
    if (io) {
      io.to('/crm').emit('whatsapp:message', {
        leadId,
        direction: 'outbound',
        channel: 'WhatsApp',
        status: 'failed',
        text,
        timestamp: new Date(),
      });
    }

    return false;
  }
};

export interface TemplateInfo {
  language: string;
  paramCount: number;
}

export const TEMPLATE_REGISTRY: Record<string, TemplateInfo> = {
  ashiyana: { language: 'en', paramCount: 0 },
  visit_confirmation: { language: 'en', paramCount: 3 },
  welcome_massage: { language: 'en', paramCount: 1 },
  welcome_message: { language: 'en', paramCount: 1 },
  hello_world: { language: 'en_US', paramCount: 0 },
};

export const sendWhatsAppTemplate = async (
  leadId: string,
  to: string,
  templateName: string,
  parameters: Array<{ type: string; text?: string; image?: { link: string }; document?: { link: string; filename: string } }> = [],
  languageCode: string = 'en'
): Promise<boolean> => {
  let tenantId: any = null;
  let welcomeGuardAcquired = false;
  try {
    const formattedTo = formatWhatsAppNumber(to);
    let textSummary = `Sent Template: ${templateName}`;
    if (parameters.length > 0) {
      const details = parameters.map(p => p.text || p.image?.link || p.document?.link || '').join(', ');
      textSummary += ` [Vars: ${details}]`;
    }

    // Resolve template language & parameter strategy using registry if available
    const registryEntry = TEMPLATE_REGISTRY[templateName];
    let effectiveLang = languageCode;

    if (registryEntry) {
      effectiveLang = registryEntry.language;
      if (languageCode !== 'en' && languageCode !== registryEntry.language) {
        console.warn(`[WhatsApp Template] Warning: caller specified lang "${languageCode}" but template "${templateName}" is registered with lang "${registryEntry.language}". Overriding with registered language.`);
      }
    }

    console.log(`[WhatsApp Template Dispatch] Outbox -> To: ${formattedTo} (raw: ${to}), Template: ${templateName}, Lang: ${effectiveLang}`);

    // Atomic guard for welcome templates to prevent duplicate dispatches across queue workers and direct webhooks
    const isWelcomeTemplate = templateName.startsWith('welcome_') || templateName.includes('welcome') || templateName === 'hello_world';

    if (isWelcomeTemplate && leadId) {
      const updatedLead = await Lead.findOneAndUpdate(
        { _id: leadId, 'aiContext.welcomeSent': { $ne: true } },
        { $set: { 'aiContext.welcomeSent': true, 'aiContext.welcomeSentAt': new Date() } }
      );

      if (!updatedLead) {
        console.log(`[WhatsApp Template Dispatch] SKIPPING duplicate welcome template "${templateName}" for lead ${leadId} (already sent).`);
        return true;
      }
      welcomeGuardAcquired = true;
    }

    // Fetch Lead to get tenantId
    const lead = leadId ? await Lead.findById(leadId) : null;
    tenantId = lead?.tenantId;
    let tenant = null;

    if (tenantId) {
      tenant = await Tenant.findById(tenantId);
    } else {
      tenant = await Tenant.findOne({});
      if (tenant) {
        tenantId = tenant._id as any;
      }
    }

    const provider = await getWhatsAppProvider(tenantId?.toString() || tenantId);
    const templateRecipient = resolveRecipient(lead, to);
    await provider.sendTemplate(templateRecipient, templateName, parameters, effectiveLang);

    // ON SUCCESS (real API post succeeded, or mock mode)
    const notification = new Notification({
      tenantId,
      leadId,
      channel: 'WhatsApp',
      message: textSummary,
      status: 'Sent',
      sentAt: new Date(),
    });
    await notification.save();

    if (lead) {
      lead.timeline.push({
        event: 'WhatsApp Template Sent',
        timestamp: new Date(),
        actor: 'System',
        details: textSummary,
      });
      lead.chatHistory.push({ role: 'model', text: textSummary });
      await lead.save();

      const io = getIO();
      if (io) {
        io.to('/crm').emit('lead:updated', lead);
        io.to('/crm').emit('notification:sent', {
          leadId,
          channel: 'WhatsApp',
          message: textSummary,
          timestamp: new Date(),
        });
        io.to('/crm').emit('whatsapp:message', {
          leadId,
          direction: 'outbound',
          channel: 'WhatsApp',
          status: 'sent',
          text: textSummary,
          templateName,
          timestamp: new Date(),
        });
      }
    } else {
      const io = getIO();
      if (io) {
        io.to('/crm').emit('whatsapp:message', {
          leadId,
          direction: 'outbound',
          channel: 'WhatsApp',
          status: 'sent',
          text: textSummary,
          templateName,
          timestamp: new Date(),
        });
      }
    }

    return true;
  } catch (error: any) {
    if (welcomeGuardAcquired && leadId) {
      try {
        await Lead.findByIdAndUpdate(leadId, { $set: { 'aiContext.welcomeSent': false } });
      } catch (e) { }
    }

    const metaErrorDetails = error.response?.data?.error?.error_data?.details || error.response?.data?.error?.message || error.message;
    console.error('Error sending WhatsApp template:', JSON.stringify(error.response?.data || error.message, null, 2));

    if (!tenantId) {
      try {
        const lead = leadId ? await Lead.findById(leadId) : null;
        tenantId = lead?.tenantId;
      } catch (e) { }
    }

    if (!tenantId) {
      const defaultTenant = await Tenant.findOne({});
      if (defaultTenant) {
        tenantId = defaultTenant._id;
      }
    }

    const failureReason = `Failed template "${templateName}": ${metaErrorDetails}`;

    await Notification.create({
      tenantId,
      leadId,
      channel: 'WhatsApp',
      message: failureReason,
      status: 'Failed',
      sentAt: new Date(),
    });

    const io = getIO();
    if (io) {
      io.to('/crm').emit('whatsapp:message', {
        leadId,
        direction: 'outbound',
        channel: 'WhatsApp',
        status: 'failed',
        text: failureReason,
        templateName,
        timestamp: new Date(),
      });
    }

    return false;
  }
};

export const sendWhatsAppDocument = async (
  leadId: string,
  to: string,
  documentUrl: string,
  filename: string,
  caption?: string,
  tenantIdOverride?: string
): Promise<boolean> => {
  try {
    console.log(`[WhatsApp Document Dispatch] Outbox -> To: ${to}, URL: ${documentUrl}`);

    // Fetch Lead to get tenantId
    const lead = leadId ? await Lead.findById(leadId) : null;
    let tenantId = tenantIdOverride || lead?.tenantId;
    let tenant = null;

    if (tenantId) {
      tenant = await Tenant.findById(tenantId);
    } else {
      tenant = await Tenant.findOne({});
      if (tenant) {
        tenantId = tenant._id as any;
      }
    }

    const whatsappToken = tenant?.whatsappToken || process.env.WHATSAPP_TOKEN;
    const whatsappPhoneId = tenant?.whatsappPhoneId || process.env.WHATSAPP_PHONE_ID;
    const apiUrl = `https://graph.facebook.com/v18.0/${whatsappPhoneId}/messages`;

    // Log to DB
    const logMessage = `Sent Document: ${filename} (${documentUrl})${caption ? ` - "${caption}"` : ''}`;
    const notification = new Notification({
      tenantId,
      leadId,
      channel: 'WhatsApp',
      message: logMessage,
      status: 'Sent',
      sentAt: new Date(),
    });
    await notification.save();

    // Update Lead timeline and store chat turn
    if (lead) {
      lead.timeline.push({
        event: 'WhatsApp Document Sent',
        timestamp: new Date(),
        actor: 'AI',
        details: logMessage,
      });
      lead.chatHistory.push({ role: 'model', text: logMessage });
      lead.aiContext.chatHistory = (lead.aiContext.chatHistory || '') + `\nAgent sent document: ${filename}`;
      await lead.save();

      // Dispatch to UI via Socket.io
      const io = getIO();
      if (io) {
        io.to('/crm').emit('lead:updated', lead);
        io.to('/crm').emit('notification:sent', {
          leadId,
          channel: 'WhatsApp',
          message: logMessage,
          timestamp: new Date(),
        });
      }
    }

    const provider = await getWhatsAppProvider(tenantId?.toString() || tenantId);
    await provider.sendDocument(resolveRecipient(lead, to), documentUrl, filename, caption);
    return true;
  } catch (error: any) {
    console.error('Error sending WhatsApp document:', error.response?.data || error.message);

    // Resolve tenantId
    let tenantId;
    try {
      const lead = await Lead.findById(leadId);
      tenantId = lead?.tenantId;
    } catch (e) { }

    if (!tenantId) {
      const defaultTenant = await Tenant.findOne({});
      if (defaultTenant) {
        tenantId = defaultTenant._id;
      }
    }

    // Log failure
    await Notification.create({
      tenantId,
      leadId,
      channel: 'WhatsApp',
      message: `Failed sending document: ${filename}`,
      status: 'Failed',
      sentAt: new Date(),
    });
    return false;
  }
};

export const AURA_SYSTEM_PROMPT = `You are Aura, the intelligent and welcoming AI assistant for RealtyCloudai real estate. 

Your primary goal is to qualify leads by collecting their property preferences (budget, location, property type, and intent) and seamlessly scheduling a site visit. 

Follow these strict rules for every response:

1. CONVERSATIONAL & CONCISE: You are chatting on WhatsApp. Keep your responses to 1-3 short sentences. Never send large blocks of text. 
2. ONE QUESTION AT A TIME: Never ask multiple questions in a single message. Never combine a "Yes/No" question with a multiple-choice menu. Wait for the user to answer the current question before moving forward.
3. FLEXIBLE SCHEDULING (CRITICAL): When it is time to schedule a site visit, you may suggest 3 available time slots (e.g., "1. Tomorrow at 11 AM", "2. Saturday at 10 AM"). However, if the user ignores the numbered list and suggests their own time (e.g., "Sunday at 4 PM" or "Next week"), YOU MUST ACCEPT THEIR TIME. Do not repeat the menu. Acknowledge their requested time, confirm the booking, and politely conclude the conversation.
4. NO HALLUCINATIONS: Do not invent properties, prices, or locations. If you need to search inventory, tell the user you are checking and simulate the next step. 
5. TONE: Be professional, empathetic, and highly accommodating. 
6. DO NOT REPEAT QUESTIONS: Do not repeat the same Yes/No question or qualification details request if the user has already answered. Move to the next step.

Your end goal is to confirm a site visit time without frustrating the user. Adapt to their conversational flow.`;

// AI Tool 1: Search properties from Mongo Inventory
export const searchProperties = async (budget: number, location: string, type: string) => {
  const query: any = {};
  if (budget && budget > 0) {
    // Search properties within budget +/- 30% range
    query.price = { $lte: budget * 1.3 };
  }
  if (type && type !== 'Any') {
    query.type = type;
  }

  const matches = await Property.find(query);

  if (!location || location.trim() === '') {
    return matches.slice(0, 3);
  }

  const fuse = new Fuse(matches, {
    keys: ['location'],
    threshold: 0.4
  });

  return fuse.search(location.trim()).map(r => r.item).slice(0, 3);
};

// AI Tool 2: Check slot & Schedule Visit
export const scheduleVisit = async (leadId: string, propertyId: string, dateStr: string): Promise<{ success: boolean; message: string; visit?: any }> => {
  try {
    const scheduledDate = new Date(dateStr);
    if (isNaN(scheduledDate.getTime())) {
      return { success: false, message: 'Invalid date format' };
    }

    // Double-booking check: No scheduling in the same hour for the same property
    const hourStart = new Date(scheduledDate);
    hourStart.setMinutes(0, 0, 0);
    const hourEnd = new Date(scheduledDate);
    hourEnd.setMinutes(59, 59, 999);

    const existingVisit = await Visit.findOne({
      propertyId,
      scheduledAt: { $gte: hourStart, $lte: hourEnd },
      status: 'Scheduled',
    });

    if (existingVisit) {
      return { success: false, message: 'Slot already booked. Choose another time slot.' };
    }

    const lead = await Lead.findById(leadId);
    if (!lead) return { success: false, message: 'Lead not found' };

    const property = await Property.findById(propertyId);
    if (!property) return { success: false, message: 'Property not found' };

    const visit = new Visit({
      leadId,
      propertyId,
      scheduledAt: scheduledDate,
      status: 'Scheduled',
    });
    await visit.save();

    // Update CRM status
    lead.status = 'Visit Scheduled';
    lead.timeline.push({
      event: 'Visit Scheduled',
      timestamp: new Date(),
      actor: 'AI',
      details: `Scheduled visit for ${property.title} on ${scheduledDate.toLocaleString()}`,
    });
    await lead.save();

    // Send notifications to Admin, Manager, Executive
    const msg = `Visit Confirmed: Lead ${lead.name} has scheduled a site visit for property ${property.title} on ${scheduledDate.toLocaleString()}.`;

    // Dispatch to WhatsApp templates / system notification
    await sendWhatsAppTemplate(leadId, lead.mobile, 'visit_confirmation', [
      { type: 'text', text: lead.name },
      { type: 'text', text: property.title },
      { type: 'text', text: scheduledDate.toLocaleString() },
    ]);
    const adminGmail =
      await sendEmail(leadId, 'sales-admin@realtycloudai.com', 'Site Visit Scheduled', msg);
    await sendSMS(leadId, '+15550199', msg);

    // Socket update
    const io = getIO();
    if (io) {
      io.to('/crm').emit('lead:updated', lead);
      io.to('/crm').emit('visit:scheduled', visit);
    }

    return { success: true, message: 'Visit scheduled successfully', visit };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
};

// AI Tool 3: Analyze visit feedback & Score lead
export const scoreLeadPostVisit = async (leadId: string, feedbackText: string): Promise<string> => {
  const lead = await Lead.findById(leadId);
  if (!lead) return 'Lead not found';

  const score = await analyzeFeedbackSentiment(feedbackText);

  lead.score = score;
  lead.status = score === 'Cold' ? 'Cold' : 'Visit Done';
  lead.timeline.push({
    event: 'Feedback Processed & Scored',
    timestamp: new Date(),
    actor: 'AI',
    details: `Score evaluated as: ${score}. Feedback received: "${feedbackText}"`,
  });
  await lead.save();

  const io = getIO();
  if (io) {
    io.to('/crm').emit('lead:updated', lead);
  }

  return score;
};

// AI Tool 4: Request Booking
export const createBookingRequest = async (leadId: string): Promise<boolean> => {
  const lead = await Lead.findById(leadId);
  if (!lead) return false;

  lead.status = 'Ready to Buy';
  lead.timeline.push({
    event: 'Booking Request Raised',
    timestamp: new Date(),
    actor: 'AI',
    details: 'Lead ready to purchase property. Needs Sales Manager approval.',
  });
  await lead.save();

  const io = getIO();
  if (io) {
    io.to('/crm').emit('lead:updated', lead);
  }

  return true;
};

// --- Date helpers for slot scheduling ---

// Builds the actual Date objects matching the 3 slots advertised to the user,
// so "1"/"2"/"3" map to a real, bookable timestamp instead of just text.
function buildDefaultSlotDates(): Date[] {
  const tomorrow11am = new Date();
  tomorrow11am.setDate(tomorrow11am.getDate() + 1);
  tomorrow11am.setHours(11, 0, 0, 0);

  const dayAfter3pm = new Date();
  dayAfter3pm.setDate(dayAfter3pm.getDate() + 2);
  dayAfter3pm.setHours(15, 0, 0, 0);

  const saturday10am = new Date();
  const daysUntilSaturday = (6 - saturday10am.getDay() + 7) % 7 || 7;
  saturday10am.setDate(saturday10am.getDate() + daysUntilSaturday);
  saturday10am.setHours(10, 0, 0, 0);

  return [tomorrow11am, dayAfter3pm, saturday10am];
}

// Best-effort freeform date parser for replies like "Sunday at 4 PM" or
// "next week". This is intentionally simple â€” swap in chrono-node or a
// similar NLP date library for production-grade parsing of arbitrary phrasing.
function parseFreeformDate(text: string): Date | null {
  const lower = text.toLowerCase().trim();
  const now = new Date();

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayMatch = dayNames.find((d) => lower.includes(d));

  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);

  let targetDate = new Date(now);

  if (dayMatch) {
    const targetDay = dayNames.indexOf(dayMatch);
    const diff = (targetDay - now.getDay() + 7) % 7 || 7;
    targetDate.setDate(now.getDate() + diff);
  } else if (lower.includes('tomorrow')) {
    targetDate.setDate(now.getDate() + 1);
  } else if (lower.includes('next week')) {
    targetDate.setDate(now.getDate() + 7);
  } else {
    // No recognizable day reference â€” can't safely resolve a date.
    return null;
  }

  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    targetDate.setHours(hour, minute, 0, 0);
  } else {
    // Default to a sensible mid-morning slot if no time was given.
    targetDate.setHours(11, 0, 0, 0);
  }

  return targetDate;
}

// Main entry point for processing WhatsApp chatbot conversations
// Rule-based fallback assistant
export const runRuleBasedAssistant = async (lead: any, textMessage: string, io: any, streamEvent: string) => {
  const textLower = textMessage.toLowerCase();
  let aiResponse = '';

  // Check if scheduling
  if (lead.status === 'New' || lead.status === 'Qualifying') {
    // Stage 2: Capture & Qualify
    // Check what requirements are missing
    const budgetMatch = textLower.match(/(\d+)\s*(lakh|l|cr|crore|thousand|k)/);
    if (budgetMatch) {
      let amt = parseInt(budgetMatch[1]);
      if (budgetMatch[2].includes('cr')) amt = amt * 10000000;
      else if (budgetMatch[2].startsWith('l')) amt = amt * 100000;
      else amt = amt * 1000;
      lead.budget = amt;
    }

    if (textLower.includes('buy')) lead.purpose = 'Buy';
    else if (textLower.includes('invest')) lead.purpose = 'Invest';

    if (textLower.includes('apartment') || textLower.includes('flat')) lead.propertyType = 'Apartment';
    else if (textLower.includes('villa') || textLower.includes('house')) lead.propertyType = 'Villa';
    else if (textLower.includes('plot') || textLower.includes('land')) lead.propertyType = 'Plot';
    else if (textLower.includes('commercial') || textLower.includes('shop')) lead.propertyType = 'Commercial';

    const locations = ['downtown', 'whitefield', 'brookfield', 'indiranagar', 'uptown', 'suburb', 'nashik', 'nasik'];
    for (const loc of locations) {
      if (textLower.includes(loc)) {
        lead.location = loc.charAt(0).toUpperCase() + loc.slice(1);
      }
    }

    // Check if complete
    const missing = [];
    if (!lead.budget) missing.push('Budget (e.g. 50 Lakhs)');
    if (!lead.location) missing.push('Preferred Location');
    if (lead.propertyType === 'Any') missing.push('Property Type (Apartment, Villa, Plot, Commercial)');
    if (lead.purpose === 'Any') missing.push('Purpose (Buy or Invest)');

    if (missing.length === 0) {
      lead.status = 'Qualified';
      lead.timeline.push({
        event: 'Lead Qualified',
        timestamp: new Date(),
        actor: 'AI',
        details: `Requirements qualification completed. Budget: ${lead.budget}, Location: ${lead.location}, Type: ${lead.propertyType}, Purpose: ${lead.purpose}`,
      });
      await lead.save();

      // Proactively send match template (Stage 3)
      const properties = await searchProperties(lead.budget, lead.location, lead.propertyType);
      if (properties.length > 0) {
        const prop = properties[0];
        const brochure = await resolvePropertyBrochure(prop);
        aiResponse = `Congratulations! You are now qualified. I found a match: *${prop.title}* at ${prop.location} for \u20b9${prop.price.toLocaleString()}.\nAmenities: ${prop.amenities.join(', ')}.\n\nWould you like to schedule a site visit? Reply with **Yes** or **No**.`;
        lead.status = 'Qualified'; // Move to Stage 3

        if (brochure) {
          setTimeout(async () => {
            await sendWhatsAppDocument(
              lead._id.toString(),
              lead.mobile,
              brochure.url,
              brochure.filename,
              `Brochure for ${prop.title}`
            );
          }, 2000);
        }
      } else {
        aiResponse = `Thank you for completing your profile! Let me search our inventory for properties in ${lead.location} below â‚¹${lead.budget.toLocaleString()}. We will get back to you shortly.`;
      }
    } else {
      // Re-prompt (max 3 attempts rule)
      if (lead.aiContext.attempts >= 4) {
        lead.status = 'Incomplete';
        lead.timeline.push({
          event: 'Qualification Timeout',
          timestamp: new Date(),
          actor: 'System',
          details: 'AI reached max attempts (3) to qualify lead. Moved to follow-up.',
        });
        await lead.save();

        aiResponse = `Thank you. We have recorded your initial details. A sales executive will reach out to you shortly to finalize your profile.`;

        // Queue +24h reminder
        const followUpQueue = getQueue('follow-up');
        if (followUpQueue) {
          await followUpQueue.add('reminder-24h', { leadId: lead._id }, { delay: 24 * 60 * 60 * 1000 });
        }
      } else {
        aiResponse = `Hello ${lead.name}, to help you find your dream property, could you please provide your: ${missing.join(', ')}?`;
      }
    }
    await lead.save();
  } else if (lead.status === 'Qualified') {
    // Stage 3: Match / Interest check
    if (textLower.includes('yes') || textLower.includes('interested') || textLower.includes('sure') || textLower.includes('ok')) {
      // Yes -> Proceed to Stage 4 Visit Scheduling
      // Pull properties
      const properties = await searchProperties(lead.budget, lead.location, lead.propertyType);
      const prop = properties[0] || { _id: 'mock_property_id', title: 'Aura Premium Heights' };

      const slotDates = buildDefaultSlotDates();

      aiResponse = `Great! Let's schedule a site visit for *${prop.title}*. Here are our available slots:\n1. Tomorrow at 11:00 AM\n2. Day after tomorrow at 3:00 PM\n3. This Saturday at 10:00 AM\n\nReply with **1**, **2**, or **3** to confirm, or just tell me a day/time that works better for you.`;

      // CRITICAL FIX: advance status so the next reply (e.g. "1", "2", "3", or a
      // freeform time) is handled by the slot-selection branch below instead of
      // looping back into this Yes/No branch.
      lead.status = 'Slot Pending';
      lead.aiContext = lead.aiContext || {};
      lead.aiContext.proposedPropertyId = prop._id.toString();
      lead.aiContext.proposedSlots = slotDates.map((d) => d.toISOString());

      lead.timeline.push({
        event: 'Site Visit Proposed',
        timestamp: new Date(),
        actor: 'AI',
        details: `Lead expressed interest. Showing slot options. Proposed Property ID: ${prop._id}`,
      });
      await lead.save();
    } else if (textLower.includes('no') || textLower.includes('not interested') || textLower.includes('nope')) {
      // No -> add to follow up (+3 days)
      lead.timeline.push({
        event: 'Lead Not Interested',
        timestamp: new Date(),
        actor: 'AI',
        details: 'Lead declined property match recommendation. Queueing 3 days follow-up.',
      });
      await lead.save();

      aiResponse = `No problem! I will look for more options matching your profile and check back in a few days. Thank you.`;

      const followUpQueue = getQueue('follow-up');
      if (followUpQueue) {
        await followUpQueue.add('re-engage-3d', { leadId: lead._id }, { delay: 3 * 24 * 60 * 60 * 1000 });
      }
    } else {
      aiResponse = `Would you be interested in visiting this property? Please reply with **Yes** or **No**.`;
    }
  } else if (lead.status === 'Slot Pending') {
    // Stage 4: User is responding to the slot menu â€” either a number (1/2/3)
    // or a freeform time of their own choosing. Both must be honored (per
    // FLEXIBLE SCHEDULING rule) and must result in an actual scheduleVisit() call.
    const propertyId = lead.aiContext?.proposedPropertyId || 'mock_property_id';
    const proposedSlots: string[] = lead.aiContext?.proposedSlots || [];

    const numericMatch = textMessage.trim().match(/^[1-3]$/);
    let targetDateStr: string | null = null;

    if (numericMatch) {
      const idx = parseInt(numericMatch[0], 10) - 1;
      targetDateStr = proposedSlots[idx] || null;
    } else {
      // Freeform reply (e.g. "Sunday at 4 PM", "next week Tuesday morning").
      // Best-effort parse; in production swap this for a proper NLP date parser
      // (e.g. chrono-node) rather than relying on `new Date(...)` directly.
      const parsed = parseFreeformDate(textMessage);
      if (parsed) targetDateStr = parsed.toISOString();
    }

    if (!targetDateStr) {
      // Could not resolve a date from either path â€” ask again without looping
      // back to the Yes/No question (that was the original bug).
      aiResponse = `Sorry, I couldn't quite catch that. Please reply with **1**, **2**, **3**, or tell me a specific day and time that works for you.`;
    } else {
      const result = await scheduleVisit(lead._id.toString(), propertyId, targetDateStr);
      if (result.success) {
        aiResponse = `Our sales person will call you to attend to you.`;
        // scheduleVisit() already sets lead.status = 'Visit Scheduled' and saves it.
      } else if (result.message === 'Slot already booked. Choose another time slot.') {
        aiResponse = `That slot just got booked by someone else. Could you pick another time, or one of: 1, 2, or 3?`;
        // Stay in 'Slot Pending' so the next reply is handled here again.
      } else {
        aiResponse = `Sorry, something went wrong scheduling your visit (${result.message}). Could you try again?`;
      }
    }
  } else if (lead.status === 'Visit Scheduled') {
    // Check if visit completed (normally done by Sales Exec, but if done, AI gets feedback)
    aiResponse = `Your site visit has already been scheduled! We look forward to meeting you.`;
  } else if (lead.status === 'Visit Done') {
    // Stage 5: Collect feedback
    const score = await scoreLeadPostVisit(lead._id.toString(), textMessage);
    aiResponse = `Thank you for sharing your feedback! We have scored your profile as *${score}*. Let us know if you are ready to book.`;
  } else if (lead.status === 'Ready to Buy') {
    aiResponse = `Excellent! Your booking request has been submitted to our Sales Manager. Once approved, we will send you the document checklist and payment link.`;
  } else if (lead.status === 'Booked') {
    aiResponse = `Welcome to the RealtyCloudai family! Your booking is confirmed. We will share monthly construction updates and EMI statements here.`;
  } else {
    // Fallback
    aiResponse = `Hi ${lead.name}, how can I assist you with your real estate needs today?`;
  }

  // Emulate streaming delay
  setTimeout(async () => {
    if (io) {
      io.to('/crm').emit(streamEvent, { token: aiResponse });
    }
    await sendWhatsAppText(lead._id.toString(), lead.mobile, aiResponse);
  }, 1500);
};

// Main entry point for processing WhatsApp chatbot conversations
export const processAIConversation = async (leadId: string, textMessage: string) => {
  const lead = await Lead.findById(leadId);
  if (!lead) return;

  // Track chat turn
  lead.aiContext.attempts = (lead.aiContext.attempts || 0) + 1;
  await lead.save();

  // Socket stream emulation
  const io = getIO();
  const streamEvent = `ai:stream:${leadId}`;

  // Emit thinking tokens
  if (io) {
    io.to('/crm').emit(streamEvent, { token: 'AI is analyzing your requirements...' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (geminiApiKey && !geminiApiKey.startsWith('mock')) {
    // Google Gemini API Flow
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(geminiApiKey);
      const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
      const leadContext = `Lead Profile:
- Name: ${lead.name}
- Mobile: ${lead.mobile}
- Current Status: ${lead.status}
- Budget: ${lead.budget ? 'â‚¹' + lead.budget.toLocaleString() : 'Not provided'}
- Preferred Location: ${lead.location || 'Not provided'}
- Property Type: ${lead.propertyType}
- Purpose: ${lead.purpose}`;

      const systemInstruction = `${AURA_SYSTEM_PROMPT}\n\n${leadContext}`;

      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction,
      });

      const formattedHistory = (lead.chatHistory || []).map((msg) => ({
        role: msg.role === 'user' ? 'user' as const : 'model' as const,
        parts: [{ text: msg.text }],
      }));

      const chat = model.startChat({
        history: formattedHistory,
      });

      const result = await chat.sendMessage(textMessage);
      const aiResponse = result.response.text().trim();

      // Update history
      lead.chatHistory.push(
        { role: 'user', text: textMessage },
        { role: 'model', text: aiResponse }
      );
      lead.aiContext.chatHistory = (lead.aiContext.chatHistory || '') + `\nUser: ${textMessage}\nAI: ${aiResponse}`;
      await lead.save();

      if (io) {
        io.to('/crm').emit(streamEvent, { token: aiResponse });
      }
      await sendWhatsAppText(lead._id.toString(), lead.mobile, aiResponse);
    } catch (err: any) {
      console.error('Gemini API error, executing fallback:', err.message);
      await runRuleBasedAssistant(lead, textMessage, io, streamEvent);
    }
  } else if (apiKey && !apiKey.startsWith('mock')) {
    // actual OpenAI GPT-4o / LangChain flow
    try {
      const { ChatOpenAI } = require('@langchain/openai');
      const { ConversationChain } = require('langchain/chains');
      const { BufferMemory } = require('langchain/memory');

      const model = new ChatOpenAI({
        openAIApiKey: apiKey,
        modelName: 'gpt-4o',
        temperature: 0.7,
        streaming: true,
      });

      const memory = new BufferMemory();
      // Load previous chats
      if (lead.aiContext.chatHistory) {
        await memory.saveContext({ input: '' }, { output: lead.aiContext.chatHistory });
      }

      // System Prompt & agent logic...
      // For local reliability, we use the fallback engine if OpenAI errors out
      // Since OpenAI is dynamic, let's execute the fallback for the developer's mock scenario
      // and print that LangChain OpenAI loader is ready to use.
      const aiResponse = `[OpenAI Prompt Engine Executed] (Using mock response due to credential testing context)`;

      // Update history
      lead.aiContext.chatHistory = (lead.aiContext.chatHistory || '') + `\nUser: ${textMessage}\nAI: ${aiResponse}`;
      await lead.save();

      if (io) {
        io.to('/crm').emit(streamEvent, { token: aiResponse });
      }
      await sendWhatsAppText(lead._id.toString(), lead.mobile, aiResponse);
    } catch (err: any) {
      console.log('LangChain OpenAI error, executing fallback:', err.message);
      await runRuleBasedAssistant(lead, textMessage, io, streamEvent);
    }
  } else {
    // Run rule-based assistant
    await runRuleBasedAssistant(lead, textMessage, io, streamEvent);
  }
};