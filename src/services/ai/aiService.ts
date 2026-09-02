import mongoose from 'mongoose';
import Fuse from 'fuse.js';
import Lead, { ILead } from '../../models/Lead';
import Property from '../../models/Property';
import Visit from '../../models/Visit';
import Booking from '../../models/Booking';
import { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsAppDocument, resolvePropertyBrochure } from '../whatsapp/whatsappService';
import { getIO } from '../socket/socketService';
import { sendEmail } from '../notificationService';
import { getQueue } from '../queue/queueConfig';
import { checkFaqCache } from './semanticCache';
import { analyzeFeedbackSentiment } from './llmProviderService';
import User from '../../models/User';

// ─────────────────────────────────────────────────────────────
//  Numeric extractors used for state mutations only.
//  They never produce reply text.
// ─────────────────────────────────────────────────────────────

export const extractBudgetValue = (text: string): number => {
  const lower = text.toLowerCase();
  const m = lower.match(/(\d+(?:\.\d+)?)\s*(lakh|l\b|cr\b|crore|thousand\b|k\b)/);
  if (!m) return 0;
  let amt = parseFloat(m[1]);
  const unit = m[2];
  if (unit.startsWith('cr')) amt *= 10_000_000;
  else if (unit.startsWith('l')) amt *= 100_000;
  else amt *= 1_000;
  return amt;
};

export const extractPropertyType = (text: string): 'Apartment' | 'Villa' | 'Plot' | 'Commercial' | null => {
  const t = text.toLowerCase();
  if (t.includes('apartment') || t.includes('flat')) return 'Apartment';
  if (t.includes('villa') || t.includes('house')) return 'Villa';
  if (t.includes('plot') || t.includes('land')) return 'Plot';
  if (t.includes('commercial') || t.includes('shop') || t.includes('office')) return 'Commercial';
  return null;
};

export const extractPurpose = (text: string): 'Buy' | 'Invest' | null => {
  const t = text.toLowerCase();
  if (t.includes('buy') || t.includes('purchase') || t.includes('own')) return 'Buy';
  if (t.includes('invest')) return 'Invest';
  return null;
};

// Location extraction is handled by the LLM — no hardcoded city list.
export const extractLocation = (_text: string): string | null => null;

/**
 * Fuzzy-matches free text against the tenant's known property locations.
 * Returns the canonical location string from inventory, or null if no confident match.
 * Uses Fuse.js with the same pattern already used in searchProperties.
 */
export const extractLocationFromKnownList = (
  text: string,
  knownLocations: string[],
): string | null => {
  if (!knownLocations.length) return null;
  const fuse = new Fuse(knownLocations, { threshold: 0.35, includeScore: true });

  // Try matching the whole message first
  const wholeMatch = fuse.search(text);
  if (wholeMatch.length > 0 && (wholeMatch[0].score ?? 1) < 0.4) return wholeMatch[0].item;

  // Fall back to matching individual comma/newline-delimited tokens
  const tokens = text.split(/[,.\n]/).map(t => t.trim()).filter(Boolean);
  for (const token of tokens) {
    const r = fuse.search(token);
    if (r.length > 0 && (r[0].score ?? 1) < 0.4) return r[0].item;
  }
  return null;
};

// ─────────────────────────────────────────────────────────────
//  Property search
// ─────────────────────────────────────────────────────────────

export const searchProperties = async (tenantId: string, location?: string) => {
  const properties = await Property.find({ tenantId });
  if (!location || location.trim() === '') return properties;
  const fuse = new Fuse(properties, { keys: ['location'], threshold: 0.3, includeScore: true });
  return fuse.search(location.trim()).map(r => r.item);
};

// ─────────────────────────────────────────────────────────────
//  Visit scheduling tool
// ─────────────────────────────────────────────────────────────

export const scheduleVisit = async (
  leadId: string,
  propertyId: string,
  dateStr: string,
): Promise<{ success: boolean; message: string; visit?: any }> => {
  try {
    const scheduledDate = new Date(dateStr);
    if (isNaN(scheduledDate.getTime())) return { success: false, message: 'Invalid date format' };

    const hourStart = new Date(scheduledDate); hourStart.setMinutes(0, 0, 0);
    const hourEnd   = new Date(scheduledDate); hourEnd.setMinutes(59, 59, 999);

    if (!mongoose.Types.ObjectId.isValid(propertyId))
      return { success: false, message: 'Invalid property ID' };

    const property = await Property.findById(propertyId);
    if (!property) return { success: false, message: 'Property not found' };

    const existingVisit = await Visit.findOne({
      propertyId,
      scheduledAt: { $gte: hourStart, $lte: hourEnd },
      status: 'Scheduled',
    });
    if (existingVisit) return { success: false, message: 'Slot already booked. Choose another time slot.' };

    const lead = await Lead.findById(leadId);
    if (!lead) return { success: false, message: 'Lead not found' };

    const visit = new Visit({ tenantId: lead.tenantId, leadId, propertyId, scheduledAt: scheduledDate, status: 'Scheduled' });
    await visit.save();

    lead.status = 'Visit Scheduled';
    lead.timeline.push({ event: 'Visit Scheduled', timestamp: new Date(), actor: 'AI',
      details: `Scheduled visit for ${property.title} on ${scheduledDate.toLocaleString()}` });
    await lead.save();

    const msg = `Visit Confirmed: ${lead.name} — ${property.title} on ${scheduledDate.toLocaleString()}`;
    await sendWhatsAppTemplate(leadId, lead.mobile, 'visit_confirmation', [
      { type: 'text', text: lead.name },
      { type: 'text', text: property.title },
      { type: 'text', text: scheduledDate.toLocaleString() },
    ]);
    const adminUser = await User.findOne({ tenantId: lead.tenantId, role: 'admin' }).select('email');
    await sendEmail(leadId, adminUser?.email || '', 'Site Visit Scheduled', msg);

    const io = getIO();
    if (io) { io.to('/crm').emit('lead:updated', lead); io.to('/crm').emit('visit:scheduled', visit); }

    return { success: true, message: 'Visit scheduled successfully', visit };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
};

// ─────────────────────────────────────────────────────────────
//  Post-visit scoring tool
// ─────────────────────────────────────────────────────────────

export const scoreLeadPostVisit = async (leadId: string, feedbackText: string): Promise<string> => {
  const lead = await Lead.findById(leadId);
  if (!lead) return 'Lead not found';
  const score = await analyzeFeedbackSentiment(feedbackText);
  lead.score = score;
  lead.status = score === 'Cold' ? 'Cold' : 'Visit Done';
  lead.timeline.push({ event: 'Feedback Processed & Scored', timestamp: new Date(), actor: 'AI',
    details: `Score: ${score}. Feedback: "${feedbackText}"` });
  await lead.save();
  const io = getIO(); if (io) io.to('/crm').emit('lead:updated', lead);
  return score;
};

// ─────────────────────────────────────────────────────────────
//  Booking request tool
// ─────────────────────────────────────────────────────────────

export const createBookingRequest = async (leadId: string): Promise<boolean> => {
  const lead = await Lead.findById(leadId);
  if (!lead) return false;
  lead.status = 'Ready to Buy';
  lead.timeline.push({ event: 'Booking Request Raised', timestamp: new Date(), actor: 'AI',
    details: 'Lead ready to purchase. Needs Sales Manager approval.' });
  await lead.save();
  const io = getIO(); if (io) io.to('/crm').emit('lead:updated', lead);
  return true;
};

// ─────────────────────────────────────────────────────────────
//  Date helpers for visit scheduling
// ─────────────────────────────────────────────────────────────

// Bug 3 fix: full Hindi/Hinglish alias map so leads can reply in their language
const DAY_ALIASES: Record<string, string> = {
  monday: 'Monday',    somvar: 'Monday',    'som var': 'Monday',
  tuesday: 'Tuesday',  mangalvar: 'Tuesday', mangalwar: 'Tuesday',
  wednesday: 'Wednesday', budhvar: 'Wednesday', budhwar: 'Wednesday',
  thursday: 'Thursday', guruvar: 'Thursday',  brihaspativar: 'Thursday', brihaspatiwar: 'Thursday',
  friday: 'Friday',    shukravar: 'Friday',  shukrwar: 'Friday',
  saturday: 'Saturday', shanivar: 'Saturday', shaniwar: 'Saturday',
  sunday: 'Sunday',    ravivar: 'Sunday',    ravivaar: 'Sunday', itwaar: 'Sunday',
};

function extractDay(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [alias, canonical] of Object.entries(DAY_ALIASES)) {
    if (lower.includes(alias)) return canonical;
  }
  return null;
}

function extractPeriod(text: string): 'Morning' | 'Afternoon' | 'Evening' | null {
  const lower = text.toLowerCase();
  // Bug 3 fix: add Hindi terms alongside English
  if (/morning|subah|savere/.test(lower)) return 'Morning';
  if (/afternoon|dopahar|dopehar/.test(lower)) return 'Afternoon';
  if (/evening|shaam|sham/.test(lower)) return 'Evening';
  return null;
}

function getDateForDayAndPeriod(dayName: string, period: 'Morning' | 'Afternoon' | 'Evening'): Date {
  const now = new Date();
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const targetDay = dayNames.indexOf(dayName.toLowerCase());
  let diff = (targetDay - now.getDay() + 7) % 7;
  if (diff === 0) {
    const periodHour = period === 'Morning' ? 10 : period === 'Afternoon' ? 14 : 17;
    if (now.getHours() >= periodHour) diff = 7;
  }
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  d.setHours(period === 'Morning' ? 10 : period === 'Afternoon' ? 14 : 17, 0, 0, 0);
  return d;
}

// ─────────────────────────────────────────────────────────────
//  STATE MUTATIONS — LLM Semantic Extraction & State Transitions
// ─────────────────────────────────────────────────────────────

export const applyStructuredLeadUpdates = async (
  lead: any,
  extractedData?: any,
  intent?: string
): Promise<void> => {
  if (!extractedData && !intent) return;
  lead.aiContext = lead.aiContext || {};

  // 1. Lead Qualification Fields
  if (extractedData?.budget && extractedData.budget > 0) {
    lead.budget = extractedData.budget;
  }
  if (extractedData?.propertyType && ['Apartment', 'Villa', 'Plot', 'Commercial'].includes(extractedData.propertyType)) {
    lead.propertyType = extractedData.propertyType;
  }
  if (extractedData?.purpose && ['Buy', 'Invest'].includes(extractedData.purpose)) {
    lead.purpose = extractedData.purpose;
  }
  if (extractedData?.location && typeof extractedData.location === 'string' && extractedData.location.trim()) {
    const allProps = await Property.find({ tenantId: lead.tenantId });
    const knownLocations = Array.from(new Set(allProps.map((p: any) => p.location).filter(Boolean))) as string[];
    const matched = extractLocationFromKnownList(extractedData.location, knownLocations);
    lead.location = matched || extractedData.location.trim();
  }

  // If newly contacted, advance to Qualifying
  if (lead.status === 'New') {
    lead.status = 'Qualifying';
  }

  // 2. Check if lead qualification is now complete
  if (
    (lead.status === 'New' || lead.status === 'Qualifying') &&
    lead.budget > 0 &&
    lead.location?.trim() &&
    lead.propertyType !== 'Any' &&
    lead.purpose !== 'Any'
  ) {
    lead.status = 'Qualified';
    lead.timeline.push({
      event: 'Lead Qualified',
      timestamp: new Date(),
      actor: 'AI',
      details: `Budget ₹${lead.budget}, Location: ${lead.location}, Type: ${lead.propertyType}, Purpose: ${lead.purpose}`,
    });

    const properties = await searchProperties(lead.tenantId, lead.location);
    if (properties.length > 0) {
      const prop = properties[0];
      lead.aiContext.proposedPropertyId = prop._id.toString();

      // Proactively send brochure PDF file
      const brochure = await resolvePropertyBrochure(prop);
      if (brochure) {
        setTimeout(() => {
          sendWhatsAppDocument(
            lead._id.toString(),
            lead.mobile,
            brochure.url,
            brochure.filename,
            `Brochure — ${prop.title}`
          ).catch(console.error);
        }, 1500);
      }
    }
  }

  // 3. User declines or expresses negative interest
  if (extractedData?.isDeclined || intent === 'declined') {
    lead.timeline.push({
      event: 'Lead Not Interested',
      timestamp: new Date(),
      actor: 'AI',
      details: 'Declined or expressed no interest. Queuing 3-day follow-up.',
    });
    const q = getQueue('follow-up');
    if (q) await q.add('re-engage-3d', { leadId: lead._id }, { delay: 3 * 24 * 60 * 60 * 1000 });
  }

  // 4. Visit scheduling intent
  if (extractedData?.isAffirmativeVisit || intent === 'schedule_visit') {
    if (lead.status === 'Qualified' || lead.status === 'Qualifying') {
      let propId = lead.aiContext.proposedPropertyId;
      if (!propId) {
        const props = await searchProperties(lead.tenantId, lead.location);
        if (props.length > 0) {
          propId = props[0]._id.toString();
          lead.aiContext.proposedPropertyId = propId;
        }
      }
      lead.status = 'Slot Pending';
      lead.timeline.push({
        event: 'Visit Interest Confirmed',
        timestamp: new Date(),
        actor: 'AI',
        details: `Lead wants to visit property ${propId || 'in inventory'}`,
      });
    }
  }

  // 5. Visit slot selection (Day & Time period)
  if (extractedData?.visitDay) {
    lead.aiContext.selectedVisitDay = extractedData.visitDay;
  }
  if (extractedData?.visitPeriod) {
    lead.aiContext.selectedVisitPeriod = extractedData.visitPeriod;
  }

  // If both day and period are known and we're in Slot Pending or schedule mode, book visit
  if (
    (lead.status === 'Slot Pending' || intent === 'visit_confirmed') &&
    lead.aiContext.selectedVisitDay &&
    lead.aiContext.selectedVisitPeriod
  ) {
    let propId = lead.aiContext.proposedPropertyId;
    if (!propId) {
      const props = await searchProperties(lead.tenantId, lead.location);
      if (props.length > 0) {
        propId = props[0]._id.toString();
        lead.aiContext.proposedPropertyId = propId;
      }
    }

    if (propId) {
      const targetDate = getDateForDayAndPeriod(
        lead.aiContext.selectedVisitDay,
        lead.aiContext.selectedVisitPeriod as any
      );
      const result = await scheduleVisit(lead._id.toString(), propId, targetDate.toISOString());
      if (result.success) {
        lead.status = 'Visit Scheduled';
      } else if (result.message === 'Slot already booked. Choose another time slot.') {
        lead.aiContext.selectedVisitPeriod = '';
      }
    }
  }

  await lead.save();
};

export const applyStateTransitions = async (lead: any, textMessage: string): Promise<void> => {
  const textLower = textMessage.toLowerCase();

  // ── Qualification field extraction fallback ──────────────────────────
  if (lead.status === 'New' || lead.status === 'Qualifying') {
    const budget = extractBudgetValue(textMessage);
    if (budget > 0 && (!lead.budget || lead.budget <= 0)) lead.budget = budget;

    const pType = extractPropertyType(textMessage);
    if (pType && (!lead.propertyType || lead.propertyType === 'Any')) lead.propertyType = pType;

    const purpose = extractPurpose(textMessage);
    if (purpose && (!lead.purpose || lead.purpose === 'Any')) lead.purpose = purpose;

    if (!lead.location?.trim()) {
      const allProps = await Property.find({ tenantId: lead.tenantId });
      const knownLocations = Array.from(new Set(allProps.map((p: any) => p.location).filter(Boolean))) as string[];
      const matchedLocation = extractLocationFromKnownList(textMessage, knownLocations);
      if (matchedLocation) {
        lead.location = matchedLocation;
      }
    }

    if (lead.status === 'New') lead.status = 'Qualifying';

    if (lead.budget > 0 && lead.location?.trim() && lead.propertyType !== 'Any' && lead.purpose !== 'Any') {
      lead.status = 'Qualified';
      lead.timeline.push({
        event: 'Lead Qualified',
        timestamp: new Date(),
        actor: 'AI',
        details: `Budget ₹${lead.budget}, Location: ${lead.location}, Type: ${lead.propertyType}, Purpose: ${lead.purpose}`,
      });

      const properties = await searchProperties(lead.tenantId, lead.location);
      if (properties.length > 0) {
        const prop = properties[0];
        lead.aiContext = lead.aiContext || {};
        lead.aiContext.proposedPropertyId = prop._id.toString();

        const brochure = await resolvePropertyBrochure(prop);
        if (brochure) {
          setTimeout(() => {
            sendWhatsAppDocument(lead._id.toString(), lead.mobile, brochure.url, brochure.filename, `Brochure — ${prop.title}`).catch(console.error);
          }, 1500);
        }
      }
    }
    await lead.save();
    return;
  }

  // ── Slot Pending: parse day then period, then book ──────────
  if (lead.status === 'Slot Pending') {
    const propertyId = lead.aiContext?.proposedPropertyId;
    if (!propertyId) return;

    if (!lead.aiContext?.selectedVisitDay) {
      const day = extractDay(textMessage);
      if (day) {
        lead.aiContext.selectedVisitDay = day;
        lead.timeline.push({ event: 'Visit Day Selected', timestamp: new Date(), actor: 'AI', details: `Day: ${day}` });
        await lead.save();
      }
      return;
    }

    const period = extractPeriod(textMessage);
    if (period) {
      lead.aiContext.selectedVisitPeriod = period;
      const targetDate = getDateForDayAndPeriod(lead.aiContext.selectedVisitDay, period);
      const result = await scheduleVisit(lead._id.toString(), propertyId, targetDate.toISOString());
      if (result.success) {
        lead.status = 'Visit Scheduled';
      } else if (result.message === 'Slot already booked. Choose another time slot.') {
        lead.aiContext.selectedVisitPeriod = '';
      }
      await lead.save();
    }
    return;
  }

  // ── Qualified: detect yes/no for visit interest ─────────────
  if (lead.status === 'Qualified') {
    const NEGATIVE_PHRASES = /\b(not\s+interested|no\s+thanks|nahi[n]?|nope|na\b)\b/;
    const AFFIRMATIVE_WORDS = /\b(yes|interested|sure|ok(ay)?|haan(ji)?|yep|yup|bilkul|chalega|theek\s*hai)\b/;

    const isNo  = NEGATIVE_PHRASES.test(textLower);
    const isYes = !isNo && AFFIRMATIVE_WORDS.test(textLower);

    if (isYes) {
      let propId = lead.aiContext?.proposedPropertyId;
      if (!propId) {
        const props = await searchProperties(lead.tenantId, lead.location);
        if (props.length > 0) {
          propId = props[0]._id.toString();
          lead.aiContext = lead.aiContext || {};
          lead.aiContext.proposedPropertyId = propId;
        }
      }
      lead.status = 'Slot Pending';
      lead.aiContext = lead.aiContext || {};
      lead.aiContext.selectedVisitDay = '';
      lead.aiContext.selectedVisitPeriod = '';
      lead.timeline.push({
        event: 'Visit Interest Confirmed',
        timestamp: new Date(),
        actor: 'AI',
        details: `Lead wants to visit property ${propId}`,
      });
      await lead.save();
    }

    if (isNo) {
      lead.timeline.push({
        event: 'Lead Not Interested',
        timestamp: new Date(),
        actor: 'AI',
        details: 'Declined visit. Queuing 3-day follow-up.',
      });
      await lead.save();
      const q = getQueue('follow-up');
      if (q) await q.add('re-engage-3d', { leadId: lead._id }, { delay: 3 * 24 * 60 * 60 * 1000 });
    }
    return;
  }

  // ── Visit Done: score feedback ───────────────────────────────
  if (lead.status === 'Visit Done') {
    await scoreLeadPostVisit(lead._id.toString(), textMessage);
    return;
  }
};

// ─────────────────────────────────────────────────────────────
//  Legacy alias kept so existing callers (workers.ts) don't break
// ─────────────────────────────────────────────────────────────

/** @deprecated use applyStateTransitions */
export const determineBaseResponse = async (lead: any, textMessage: string): Promise<string> => {
  await applyStateTransitions(lead, textMessage);
  return ''; // text is always generated by LLM now
};

// ─────────────────────────────────────────────────────────────
//  Main entry point
// ─────────────────────────────────────────────────────────────

export const processIncomingMessage = async (leadId: string, textMessage: string): Promise<void> => {
  let lead = await Lead.findById(leadId);
  if (!lead) { console.error(`processIncomingMessage: lead ${leadId} not found`); return; }

  const io = getIO();
  const streamEvent = `ai:stream:${leadId}`;

  // ── Attempts limit — hand off to human ──────────────────────
  if ((lead as any).aiPaused) {
    console.log(`[AI Paused] Lead ${leadId} is paused. No automated reply sent.`);
    return;
  }

  const currentAttempts = lead.aiContext?.attempts || 0;
  if (currentAttempts >= 20) {
    const { runAgentConversation } = require('./aiAgentService');
    const handoffMsg = await runAgentConversation(lead, textMessage).catch(() =>
      'Our team will reach out to you shortly. Thank you for your patience.'
    );
    if (io) io.to('/crm').emit(streamEvent, { token: handoffMsg });
    await sendWhatsAppText(leadId, lead.mobile, handoffMsg, true);
    await Lead.findByIdAndUpdate(leadId, {
      aiPaused: true,
      escalationReason: 'Max AI attempts reached',
    });
    if (io) io.to('/crm').emit('lead:updated', await Lead.findById(leadId));
    return;
  }

  // ── Increment attempt counter ────────────────────────────────
  lead = await Lead.findByIdAndUpdate(leadId, { $inc: { 'aiContext.attempts': 1 } }, { new: true });
  if (!lead) return;

  if (io) io.to('/crm').emit(streamEvent, { token: '...' });

  const provider = process.env.LLM_PROVIDER || 'gemini';
  const hasLLMKey = provider === 'groq'
    ? Boolean(process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.startsWith('mock'))
    : Boolean(process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.startsWith('mock'));

  // ── FAQ semantic cache check ─────────────────────────────────
  const proposedPropertyId = lead.aiContext?.proposedPropertyId;
  if (proposedPropertyId && mongoose.Types.ObjectId.isValid(proposedPropertyId)) {
    const cacheResult = await checkFaqCache(textMessage, lead.tenantId.toString(), proposedPropertyId);
    if (cacheResult) {
      console.log(`[FAQ Cache Hit] category: ${cacheResult.category}, score: ${cacheResult.score}`);
      const fresh = await Lead.findById(leadId);
      if (fresh) { await applyStateTransitions(fresh, textMessage); lead = (await Lead.findById(leadId)) || lead; }

      const firstName = lead.name?.split(' ')[0] || '';
      const aiResponse = firstName ? `Hi ${firstName}, ${cacheResult.answer}` : cacheResult.answer;
      await persistAndSend(lead, leadId, textMessage, aiResponse, io, streamEvent);
      return;
    }
  }

  // ── LLM generates the reply & semantic state extraction ──────
  let aiResponse = '';
  if (hasLLMKey) {
    try {
      const { runAgentStructuredConversation } = require('./aiAgentService');
      const agentResult = await runAgentStructuredConversation(lead, textMessage);

      aiResponse = agentResult.reply || '';

      // Apply semantic lead updates to MongoDB
      const fresh = await Lead.findById(leadId);
      if (fresh) {
        await applyStructuredLeadUpdates(fresh, agentResult.extractedData, agentResult.intent);
        lead = (await Lead.findById(leadId)) || lead;
      }
    } catch (err: any) {
      console.error('[LLM Structured Error] Fallback to standard conversation:', err.message);
      try {
        const { runAgentConversation } = require('./aiAgentService');
        aiResponse = await runAgentConversation(lead, textMessage);
      } catch (fbErr: any) {
        console.error('[LLM Error] Fallback failed:', fbErr.message);
        aiResponse = '';
      }
    }
  }

  // If LLM produced nothing, skip sending
  if (!aiResponse.trim()) {
    console.warn(`[processIncomingMessage] No LLM response for lead ${leadId}. No message sent.`);
    return;
  }

  // ── Final save + send ────────────────────────────────────────
  lead = (await Lead.findById(leadId)) || lead;
  await persistAndSend(lead, leadId, textMessage, aiResponse, io, streamEvent);
};

// ─────────────────────────────────────────────────────────────
//  Helper: save chat history and send WhatsApp message
// ─────────────────────────────────────────────────────────────

async function persistAndSend(
  lead: any,
  leadId: string,
  textMessage: string,
  aiResponse: string,
  io: any,
  streamEvent: string,
): Promise<void> {
  const history = lead.chatHistory || [];
  const last = history[history.length - 1];
  const items: any[] = [];
  if (!last || last.role !== 'user' || last.text !== textMessage) items.push({ role: 'user', text: textMessage });
  items.push({ role: 'model', text: aiResponse });

  if (lead.status !== 'Visit Scheduled') {
    lead.chatHistory.push(...items);
    await lead.save();
  } else {
    await Lead.findByIdAndUpdate(leadId, { $push: { chatHistory: { $each: items } } });
  }

  if (io) { io.to('/crm').emit(streamEvent, { token: aiResponse }); io.to('/crm').emit('lead:updated', lead); }
  await sendWhatsAppText(leadId, lead.mobile, aiResponse, true);
}

// ─────────────────────────────────────────────────────────────
//  Deprecated re-exports for backwards compatibility
// ─────────────────────────────────────────────────────────────

export const runRuleBasedAssistant = async (lead: any, _t: string, _io: any, _e: string) => {
  console.warn('runRuleBasedAssistant is deprecated — use processIncomingMessage');
  await processIncomingMessage(lead._id.toString(), _t);
};

export const processAIConversation = async (leadId: string, textMessage: string) => {
  console.warn('processAIConversation is deprecated — use processIncomingMessage');
  await processIncomingMessage(leadId, textMessage);
};
