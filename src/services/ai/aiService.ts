import mongoose from 'mongoose';
import Fuse from 'fuse.js';
import Lead, { ILead } from '../../models/Lead';
import Property from '../../models/Property';
import Visit from '../../models/Visit';
import Booking from '../../models/Booking';
import { sendWhatsAppText, sendWhatsAppTemplate, sendWhatsAppDocument } from '../whatsapp/whatsappService';
import { getIO } from '../socket/socketService';
import { sendEmail, sendSMS } from '../notificationService';
import { getQueue } from '../queue/queueConfig';
import { checkFaqCache } from './semanticCache';
import { analyzeFeedbackSentiment } from './llmProviderService';
import User from '../../models/User';

const MOCK_PROPERTY_ID = '507f1f77bcf86cd799439011';

export const AURA_SYSTEM_PROMPT = `You are Kayra, the intelligent and welcoming AI assistant for NextLead real estate. 

Your primary goal is to qualify leads by collecting their property preferences (budget, location, property type, and intent) and seamlessly scheduling a site visit. 

Follow these strict rules for every response:

1. CONVERSATIONAL & CONCISE: You are chatting on WhatsApp. Keep your responses to 1-3 short sentences. Never send large blocks of text. 
2. ONE QUESTION AT A TIME: Never ask multiple questions in a single message. Never combine a "Yes/No" question with a multiple-choice menu. Wait for the user to answer the current question before moving forward.
3. FLEXIBLE SCHEDULING (CRITICAL): When it is time to schedule a site visit, you may suggest 3 available time slots (e.g., "1. Tomorrow at 11 AM", "2. Saturday at 10 AM"). However, if the user ignores the numbered list and suggests their own time (e.g., "Sunday at 4 PM" or "Next week"), YOU MUST ACCEPT THEIR TIME. Do not repeat the menu. Acknowledge their requested time, confirm the booking, and politely conclude the conversation.
4. NO HALLUCINATIONS: Do not invent properties, prices, or locations. If you need to search inventory, tell the user you are checking and simulate the next step. 
5. TONE: Be professional, empathetic, and highly accommodating. 
6. DO NOT REPEAT QUESTIONS: Do not repeat the same Yes/No question or qualification details request if the user has already answered. Move to the next step.

Your end goal is to confirm a site visit time without frustrating the user. Adapt to their conversational flow.`;

export const system_Prompt = async (lead: ILead): Promise<string> => {
  let teamContactsContext = '';
  try {
    const User = require('../../models/User').default;
    const Tenant = require('../../models/Tenant').default;

    let contactPerson: { name: string; role: string; phone: string } | null = null;

    // 1. Share mobile numbers to assigned sales executive or sales manager
    if (lead.assignedTo) {
      const assignedUser = await User.findById(lead.assignedTo);
      if (assignedUser && assignedUser.phone && ['Sales Executive', 'Sales Manager'].includes(assignedUser.role)) {
        contactPerson = {
          name: assignedUser.name,
          role: assignedUser.role,
          phone: assignedUser.phone
        };
      }
    }

    // 2. If no assigned user with a phone number, look for any Sales Executive under this tenant
    if (!contactPerson) {
      const exec = await User.findOne({
        tenantId: lead.tenantId,
        role: 'Sales Executive',
        phone: { $ne: '' }
      });
      if (exec) {
        contactPerson = {
          name: exec.name,
          role: 'Sales Executive',
          phone: exec.phone!
        };
      }
    }

    // 3. If no Sales Executive, look for any Sales Manager under this tenant
    if (!contactPerson) {
      const manager = await User.findOne({
        tenantId: lead.tenantId,
        role: 'Sales Manager',
        phone: { $ne: '' }
      });
      if (manager) {
        contactPerson = {
          name: manager.name,
          role: 'Sales Manager',
          phone: manager.phone!
        };
      }
    }

    // 4. If no Sales Executive or Sales Manager, share the Tenant Admin's number
    if (!contactPerson) {
      const tenant = await Tenant.findById(lead.tenantId);
      if (tenant && tenant.phone) {
        contactPerson = {
          name: tenant.name,
          role: 'Admin',
          phone: tenant.phone
        };
      }
    }

    if (contactPerson) {
      teamContactsContext = `
=== CONCERNED REPRESENTATIVE CONTACT ===
If the lead asks to speak to a human, call a representative, or escalate, share the following details so they can connect with the concerned person:
- Name: ${contactPerson.name}
- Role: ${contactPerson.role}
- Phone Number: ${contactPerson.phone}
`;
    }
  } catch (err) {
    console.error('Failed to fetch team contacts for prompt:', err);
  }

  const allProperties = await Property.find({ tenantId: lead.tenantId });
  const uniqueLocations = Array.from(new Set(allProperties.map(p => p.location).filter(Boolean)));
  const locationsStr = uniqueLocations.join(', ') || 'None';
  console.log(locationsStr, 'location')

  const locationConstraintText = `
=== PROJECT LOCATION LIMITATION ===
Active project locations for this tenant: [${locationsStr}]
CRITICAL RULE: When proposing, recommending, or discussing project locations, you MUST only suggest or mention locations from the active list above. Do NOT suggest or guess other locations if they are not in this list.
`;

  const isFirstInteraction = !lead.chatHistory || lead.chatHistory.length === 0;

  if (isFirstInteraction) {
    return `${AURA_SYSTEM_PROMPT}\n\n${teamContactsContext}\n\n${locationConstraintText}`;
  }
  const propertyDetails = await Property.findOne({ tenantId: lead.tenantId });

  let propertyContext = '';
  if (lead.aiContext?.proposedPropertyId) {
    const propId = lead.aiContext.proposedPropertyId;
    if (propId === MOCK_PROPERTY_ID || propId === 'mock_property_id') {
      propertyContext = `
Proposed Property Details (already presented to the lead â€” do NOT re-introduce it):
- Title: ${propertyDetails?.title}
- Location: ${propertyDetails?.location}
- Price: ${propertyDetails?.price.toLocaleString()}
- Amenities: ${propertyDetails?.amenities?.join(', ')}
- Description: ${propertyDetails?.description}
`;
    } else if (mongoose.Types.ObjectId.isValid(propId)) {
      try {
        const prop = await Property.findById(propId);
        if (prop) {
          propertyContext = `
Proposed Property Details (already presented to the lead â€” do NOT re-introduce it):
- Title: ${prop.title}
- Location: ${prop.location}
- Price: â‚¹${prop.price.toLocaleString()}
- Amenities: ${prop.amenities.join(', ')}
- Description: ${prop.description || 'N/A'}
`;
        }
      } catch (e) {
        console.error('Error fetching property description for prompt:', e);
      }
    }
  }

  const missingFields: string[] = [];
  if (!lead.budget || lead.budget <= 0) missingFields.push('budget');
  if (!lead.location || lead.location.trim() === '') missingFields.push('location');
  if (!lead.propertyType || lead.propertyType === 'Any') missingFields.push('property type');
  if (!lead.purpose || lead.purpose === 'Any') missingFields.push('purpose (buy/invest)');

  const collectedFields = [
    lead.budget ? `budget = â‚¹${lead.budget.toLocaleString()}` : null,
    lead.location ? `location = ${lead.location}` : null,
    lead.propertyType !== 'Any' ? `property type = ${lead.propertyType}` : null,
    lead.purpose !== 'Any' ? `purpose = ${lead.purpose}` : null,
  ].filter(Boolean).join(', ');

  const chatHistorySnippet = (lead.chatHistory || [])
    .slice(-10)
    .map((msg: any) => `${msg.role === 'user' ? 'User' : 'Aura'}: ${msg.text}`)
    .join('\n');

  return `${AURA_SYSTEM_PROMPT}

${teamContactsContext}

${locationConstraintText}

=== CURRENT LEAD STATE ===
- Name: ${lead.name}
- CRM Status: ${lead.status}
- Budget: ${lead.budget ? 'â‚¹' + lead.budget.toLocaleString() : 'Not provided'}
- Preferred Location: ${lead.location || 'Not provided'}
- Property Type: ${lead.propertyType}
- Purpose: ${lead.purpose}
${propertyContext}

=== ALREADY COLLECTED (CRITICAL â€” DO NOT ASK AGAIN) ===
${collectedFields || 'Nothing collected yet.'}

=== STILL MISSING (ask ONE at a time in order) ===
${missingFields.length > 0 ? missingFields.map((f, i) => `${i + 1}. ${f}`).join('\n') : 'All fields collected â€” proceed to property recommendation and visit scheduling.'}

=== RECENT CONVERSATION (last 10 messages) ===
${chatHistorySnippet}

=== INSTRUCTIONS FOR THIS TURN ===
- DO NOT re-ask for any field already listed under "ALREADY COLLECTED".
- DO NOT repeat the Yes/No site visit question if the lead has already answered it.
- The lead's current CRM status is "${lead.status}" â€” your response must be appropriate for this stage.
- If status is "Slot Pending" and the user hasn't chosen a day yet, only ask them to choose a preferred day (Monday to Sunday) â€” nothing else.
- If status is "Slot Pending" and the user has chosen a day (${lead.aiContext?.selectedVisitDay}) but not a period, only ask them to choose Morning, Afternoon, or Evening â€” nothing else.
- If status is "Qualified", only ask about site visit interest â€” nothing else.`;
};

export const searchProperties = async (tenantId: string, location?: string) => {
  const properties = await Property.find({ tenantId });
  if (!location || location.trim() === '') {
    return properties;
  }
  const fuse = new Fuse(properties, {
    keys: ['location'],
    threshold: 0.2,
    includeScore: true,
  });

  return fuse
    .search(location.trim())
    .filter(result => (result.score ?? 1) < 0.2)
    .map(result => result.item);
};

// AI Tool 2: Check slot & Schedule Visit
export const scheduleVisit = async (
  leadId: string,
  propertyId: string,
  dateStr: string,
): Promise<{ success: boolean; message: string; visit?: any }> => {
  try {
    const scheduledDate = new Date(dateStr);
    if (isNaN(scheduledDate.getTime())) return { success: false, message: 'Invalid date format' };

    const hourStart = new Date(scheduledDate);
    hourStart.setMinutes(0, 0, 0);
    const hourEnd = new Date(scheduledDate);
    hourEnd.setMinutes(59, 59, 999);

    let propObjId: any = propertyId;
    let property = null;

    if (propertyId === MOCK_PROPERTY_ID || propertyId === 'mock_property_id') {
      property = { title: 'Aura Premium Heights' };
      propObjId = new mongoose.Types.ObjectId(MOCK_PROPERTY_ID);
    } else if (mongoose.Types.ObjectId.isValid(propertyId)) {
      property = await Property.findById(propertyId);
    }

    if (!property) return { success: false, message: 'Property not found' };

    const existingVisit = await Visit.findOne({
      propertyId: propObjId,
      scheduledAt: { $gte: hourStart, $lte: hourEnd },
      status: 'Scheduled',
    });
    if (existingVisit) return { success: false, message: 'Slot already booked. Choose another time slot.' };

    const lead = await Lead.findById(leadId);
    if (!lead) return { success: false, message: 'Lead not found' };

    const visit = new Visit({
      tenantId: lead.tenantId,
      leadId,
      propertyId: propObjId,
      scheduledAt: scheduledDate,
      status: 'Scheduled',
    });
    await visit.save();

    lead.status = 'Visit Scheduled';
    lead.timeline.push({
      event: 'Visit Scheduled',
      timestamp: new Date(),
      actor: 'AI',
      details: `Scheduled visit for ${property.title} on ${scheduledDate.toLocaleString()}`,
    });
    await lead.save();

    const msg = `Visit Confirmed: Lead ${lead.name} has scheduled a site visit for property ${property.title} on ${scheduledDate.toLocaleString()}.`;
    await sendWhatsAppTemplate(leadId, lead.mobile, 'visit_confirmation', [
      { type: 'text', text: lead.name },
      { type: 'text', text: property.title },
      { type: 'text', text: scheduledDate.toLocaleString() },
    ]);
    const adminGmail = await User.findOne({ tenantId: lead.tenantId, role: 'admin' }).select('email');
    await sendEmail(leadId, adminGmail?.email || "", 'Site Visit Scheduled', msg);
    // await sendSMS(leadId, lead.mobile || "", msg);

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
  if (io) io.to('/crm').emit('lead:updated', lead);

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
  if (io) io.to('/crm').emit('lead:updated', lead);

  return true;
};

// --- Date Helpers ---
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
    targetDate.setHours(11, 0, 0, 0);
  }

  return targetDate;
}

function extractDay(text: string): string | null {
  const lower = text.toLowerCase();
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const d of days) {
    if (lower.includes(d)) {
      return d.charAt(0).toUpperCase() + d.slice(1);
    }
  }
  return null;
}

function extractPeriod(text: string): 'Morning' | 'Afternoon' | 'Evening' | null {
  const lower = text.toLowerCase();
  if (lower.includes('morning')) return 'Morning';
  if (lower.includes('afternoon')) return 'Afternoon';
  if (lower.includes('evening')) return 'Evening';
  return null;
}

function getScheduledDateForDayAndPeriod(dayName: string, period: 'Morning' | 'Afternoon' | 'Evening'): Date {
  const now = new Date();
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const targetDay = dayNames.indexOf(dayName.toLowerCase());

  let targetDate = new Date(now);
  const currentDay = now.getDay();

  let diff = (targetDay - currentDay + 7) % 7;
  if (diff === 0) {
    const currentHour = now.getHours();
    let targetHour = 10;
    if (period === 'Afternoon') targetHour = 14;
    if (period === 'Evening') targetHour = 17;

    if (currentHour >= targetHour) {
      diff = 7;
    }
  }

  targetDate.setDate(now.getDate() + diff);

  let hour = 10;
  if (period === 'Afternoon') hour = 14;
  if (period === 'Evening') hour = 17;

  targetDate.setHours(hour, 0, 0, 0);
  return targetDate;
}

// --- Extractors ---
export const extractBudgetValue = (text: string): number => {
  const textLower = text.toLowerCase();
  const budgetMatch = textLower.match(/(\d+(?:\.\d+)?)\s*(lakh|l|cr|crore|thousand|k)/);
  if (budgetMatch) {
    let amt = parseFloat(budgetMatch[1]);
    const unit = budgetMatch[2];
    if (unit.includes('cr') || unit.includes('crore')) amt *= 10000000;
    else if (unit.startsWith('l')) amt *= 100000;
    else if (unit.startsWith('k') || unit.includes('thousand')) amt *= 1000;
    return amt;
  }
  return 0;
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

export const extractLocation = (text: string): string | null => {
  const t = text.toLowerCase();
  const locations = ['downtown', 'whitefield', 'brookfield', 'indiranagar', 'uptown', 'suburb', 'koramangala', 'nashik', 'nasik'];
  for (const loc of locations) {
    if (t.includes(loc)) return loc.charAt(0).toUpperCase() + loc.slice(1);
  }
  return null;
};

// --- Rule Engine ---
export const determineBaseResponse = async (lead: any, textMessage: string): Promise<string> => {
  const textLower = textMessage.toLowerCase();

  if (lead.status === 'New' || lead.status === 'Qualifying') {
    const extractedBudget = extractBudgetValue(textMessage);
    if (extractedBudget > 0 && (!lead.budget || lead.budget <= 0)) lead.budget = extractedBudget;

    const extractedType = extractPropertyType(textMessage);
    if (extractedType && (!lead.propertyType || lead.propertyType === 'Any')) lead.propertyType = extractedType;

    const extractedPurpose = extractPurpose(textMessage);
    if (extractedPurpose && (!lead.purpose || lead.purpose === 'Any')) lead.purpose = extractedPurpose;

    const extractedLoc = extractLocation(textMessage);
    if (extractedLoc && (!lead.location || lead.location.trim() === '')) lead.location = extractedLoc;

    if (lead.status === 'New') lead.status = 'Qualifying';

    if (!lead.budget || lead.budget <= 0)
      return "Could you please tell me your budget (e.g., 50 Lakhs, 1 Crore)?";
    if (!lead.location || lead.location.trim() === '')
      return "What is your preferred location for the property?";
    if (!lead.propertyType || lead.propertyType === 'Any')
      return "What type of property are you looking for? (Apartment, Villa, Plot, or Commercial)";
    if (!lead.purpose || lead.purpose === 'Any')
      return "Are you looking to buy or invest?";

    lead.status = 'Qualified';
    lead.timeline.push({
      event: 'Lead Qualified',
      timestamp: new Date(),
      actor: 'AI',
      details: `Requirements: Budget â‚¹${lead.budget}, Location: ${lead.location}, Type: ${lead.propertyType}, Purpose: ${lead.purpose}`,
    });

    const properties = await searchProperties(lead.tenantId);
    if (properties.length > 0) {
      const prop = properties[0];
      lead.aiContext = lead.aiContext || {};
      lead.aiContext.proposedPropertyId = prop._id.toString();
      const getBaseUrl = () => {
        const envUrl = process.env.VITE_BASE_URL || process.env.BACKEND_URL;
        return envUrl ? envUrl.replace(/\/api\/?$/, '') : `http://localhost:${process.env.PORT || 5000}`;
      };
      const brochureUrl = prop.s3Urls?.brochure 
        ? (prop.s3Urls.brochure.startsWith('/') 
            ? `${getBaseUrl()}${prop.s3Urls.brochure}` 
            : prop.s3Urls.brochure)
        : null;

      if (brochureUrl) {
        setTimeout(async () => {
          await sendWhatsAppDocument(
            lead._id.toString(),
            lead.mobile,
            brochureUrl,
            `${prop.title.replace(/\s+/g, '_')}_Brochure.pdf`,
            `Brochure for ${prop.title}`
          );
        }, 1000);
      }

      return `Great news! I found a match: *${prop.title}* at ${prop.location} for \u20b9${prop.price.toLocaleString()}.\nAmenities: ${prop.amenities.join(', ')}.\n\nIf you'd like to visit this property, please share a suitable date and time. I'll help schedule a site visit according to your convenience.`;
    }
    lead.aiContext = lead.aiContext || {};
    lead.aiContext.proposedPropertyId = MOCK_PROPERTY_ID;
    return `Great news! I found a match: *Aura Premium Heights* at Downtown for â‚¹1.5 Cr.\nAmenities: Gym, Pool.\nBrochure: http://mock-s3.com/brochure.pdf\n\nWould you like to schedule a site visit? Reply with *Yes* or *No*.`;
  }

  if (lead.status === 'Qualified') {
    const isYes = ['yes', 'interested', 'sure', 'ok', 'okay', 'haan', 'yep', 'yup'].some((w) => textLower.includes(w));
    const isNo = ['no', 'not interested', 'nope', 'nahi'].some((w) => textLower.includes(w));

    if (isYes) {
      let propId = lead.aiContext?.proposedPropertyId;
      let propTitle = 'Aura Premium Heights';

      if (!propId) {
        const properties = await searchProperties(lead.tenantId);
        const prop = properties[0];
        if (prop) {
          propId = prop._id.toString();
          propTitle = prop.title;
        } else {
          propId = MOCK_PROPERTY_ID;
          propTitle = 'Aura Premium Heights';
        }
        lead.aiContext = lead.aiContext || {};
        lead.aiContext.proposedPropertyId = propId;
      } else {
        if (propId === MOCK_PROPERTY_ID || propId === 'mock_property_id') {
          propTitle = 'Aura Premium Heights';
        } else if (mongoose.Types.ObjectId.isValid(propId)) {
          try {
            const prop = await Property.findById(propId);
            if (prop) propTitle = prop.title;
          } catch (_) { }
        }
      }

      lead.status = 'Slot Pending';
      lead.aiContext = lead.aiContext || {};
      lead.aiContext.selectedVisitDay = '';
      lead.aiContext.selectedVisitPeriod = '';
      lead.timeline.push({
        event: 'Site Visit Day Request',
        timestamp: new Date(),
        actor: 'AI',
        details: `Lead expressed interest. Requesting visit day choice for property ${propId}`,
      });

      return `Great! Which day of the week (Monday to Sunday) would you prefer for the site visit to *${propTitle}*?`;
    }

    if (isNo) {
      lead.timeline.push({
        event: 'Lead Not Interested',
        timestamp: new Date(),
        actor: 'AI',
        details: 'Lead declined property match recommendation. Queuing 3-day follow-up.',
      });

      const followUpQueue = getQueue('follow-up');
      if (followUpQueue) {
        await followUpQueue.add('re-engage-3d', { leadId: lead._id }, { delay: 3 * 24 * 60 * 60 * 1000 });
      }

      return `No problem! I will look for more options matching your profile and check back in a few days. Thank you.`;
    }

    return `Would you be interested in visiting this property? Please reply with *Yes* or *No*.`;
  }

  if (lead.status === 'Slot Pending') {
    const propertyId = lead.aiContext?.proposedPropertyId || MOCK_PROPERTY_ID;

    // Step 1: If day is not selected, parse day name
    if (!lead.aiContext?.selectedVisitDay) {
      const matchedDay = extractDay(textMessage);
      if (!matchedDay) {
        return `Please choose a day from Monday to Sunday for your site visit.`;
      }

      lead.aiContext = lead.aiContext || {};
      lead.aiContext.selectedVisitDay = matchedDay;
      lead.timeline.push({
        event: 'Site Visit Day Selected',
        timestamp: new Date(),
        actor: 'AI',
        details: `Selected visit day: ${matchedDay}`,
      });

      return `Perfect, ${matchedDay} is noted. What time of day works best for you? Please reply with *Morning*, *Afternoon*, or *Evening*.`;
    }

    // Step 2: If day is selected, parse period
    const matchedPeriod = extractPeriod(textMessage);
    if (!matchedPeriod) {
      return `Which time of day works best for you? Please reply with *Morning*, *Afternoon*, or *Evening*.`;
    }

    lead.aiContext.selectedVisitPeriod = matchedPeriod;
    lead.timeline.push({
      event: 'Site Visit Period Selected',
      timestamp: new Date(),
      actor: 'AI',
      details: `Selected period: ${matchedPeriod}`,
    });

    const targetDate = getScheduledDateForDayAndPeriod(lead.aiContext.selectedVisitDay, matchedPeriod);

    const result = await scheduleVisit(lead._id.toString(), propertyId, targetDate.toISOString());
    if (result.success) {
      lead.status = 'Visit Scheduled';
      return `Your site visit is confirmed for ${lead.aiContext.selectedVisitDay} (${matchedPeriod}) on ${targetDate.toLocaleString()}. We look forward to meeting you! ðŸ¡`;
    }
    if (result.message === 'Slot already booked. Choose another time slot.') {
      lead.aiContext.selectedVisitPeriod = '';
      return `That slot on ${lead.aiContext.selectedVisitDay} (${matchedPeriod}) is already booked. Could you pick a different time of day (*Morning*, *Afternoon*, or *Evening*)?`;
    }
    return `Sorry, something went wrong scheduling your visit (${result.message}). Could you try again?`;
  }

  if (lead.status === 'Visit Scheduled') {
    return `Your site visit is already confirmed! We look forward to meeting you.`;
  }

  if (lead.status === 'Visit Done') {
    const score = await scoreLeadPostVisit(lead._id.toString(), textMessage);
    return `Thank you for your feedback! We have scored your interest level as *${score}*. Let us know when you are ready to book.`;
  }

  if (lead.status === 'Ready to Buy') {
    return `Your booking request has been submitted to our Sales Manager. Once approved, we will send you the document checklist and payment link.`;
  }

  if (lead.status === 'Booked') {
    return `Welcome to the NextLead family! Your booking is confirmed. We will share construction updates and EMI statements here.`;
  }

  return `Hi ${lead.name}, how can I assist you with your real estate needs today?`;
};

// --- AI Polisher (Gemini / OpenAI) ---
const polishWithAI = async (lead: ILead, baseResponse: string): Promise<string> => {
  if (process.env.ENABLE_AI_POLISH === 'false') {
    return baseResponse;
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  const rewritePrompt = `Rewrite the following message naturally for WhatsApp. Keep it under 2 sentences. Do NOT include any introductory text, prefix, or explanation. Return only the rewritten message.\n\n"${baseResponse}"`;

  // Try Gemini first
  if (geminiApiKey && !geminiApiKey.startsWith('mock')) {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(geminiApiKey);
      const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
      const systemInstruction = await system_Prompt(lead);

      const model = genAI.getGenerativeModel({ model: modelName, systemInstruction });

      let formattedHistory = (lead.chatHistory || [])
        .slice(-20)
        .map((msg: any) => ({
          role: msg.role === 'user' ? ('user' as const) : ('model' as const),
          parts: [{ text: msg.text }],
        }));

      // Gemini requires the history to start with a 'user' message
      while (formattedHistory.length > 0 && formattedHistory[0].role !== 'user') {
        formattedHistory.shift();
      }

      if (formattedHistory.length > 0) {
        const chat = model.startChat({ history: formattedHistory });
        const result = await chat.sendMessage(rewritePrompt);
        const polished = result.response.text().trim();
        if (polished) return polished;
      } else {
        const result = await model.generateContent(rewritePrompt);
        const polished = result.response.text().trim();
        if (polished) return polished;
      }
    } catch (err: any) {
      console.error('Gemini polish failed, using rule-engine response:', err.message);
    }
  }

  // Fallback to OpenAI
  if (openaiApiKey && !openaiApiKey.startsWith('mock')) {
    try {
      const { ChatOpenAI } = require('@langchain/openai');
      const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');

      const model = new ChatOpenAI({ openAIApiKey: openaiApiKey, modelName: 'gpt-4o', temperature: 0.7 });
      const systemInstruction = await system_Prompt(lead);

      const messages = [
        new SystemMessage(systemInstruction),
        ...(lead.chatHistory || []).slice(-20).map((msg: any) =>
          msg.role === 'user' ? new HumanMessage(msg.text) : new AIMessage(msg.text),
        ),
        new HumanMessage(rewritePrompt),
      ];

      const response = await model.call(messages);
      const polished = response.content.trim();
      if (polished) return polished;
    } catch (err: any) {
      console.error('OpenAI polish failed, using rule-engine response:', err.message);
    }
  }

  return baseResponse;
};

// --- Main Entry Point ---
export const processIncomingMessage = async (leadId: string, textMessage: string): Promise<void> => {
  let lead = await Lead.findById(leadId);
  if (!lead) {
    console.error(`processIncomingMessage: lead ${leadId} not found`);
    return;
  }

  const io = getIO();
  const streamEvent = `ai:stream:${leadId}`;

  // Check if attempts already reached 20
  const currentAttempts = lead.aiContext?.attempts || 0;
  if (currentAttempts >= 20) {
    console.log(`[Limit Exceeded] Lead ${leadId} has reached ${currentAttempts} attempts. Bypassing AI.`);

    // Resolve contacts
    const User = require('../../models/User').default;
    const Tenant = require('../../models/Tenant').default;

    let contactPerson: { name: string; role: string; phone: string } | null = null;

    if (lead.assignedTo) {
      const assignedUser = await User.findById(lead.assignedTo);
      if (assignedUser && assignedUser.phone && ['Sales Executive', 'Sales Manager'].includes(assignedUser.role)) {
        contactPerson = {
          name: assignedUser.name,
          role: assignedUser.role,
          phone: assignedUser.phone
        };
      }
    }

    if (!contactPerson) {
      const exec = await User.findOne({
        tenantId: lead.tenantId,
        role: 'Sales Executive',
        phone: { $ne: '' }
      });
      if (exec) {
        contactPerson = {
          name: exec.name,
          role: 'Sales Executive',
          phone: exec.phone!
        };
      }
    }

    if (!contactPerson) {
      const manager = await User.findOne({
        tenantId: lead.tenantId,
        role: 'Sales Manager',
        phone: { $ne: '' }
      });
      if (manager) {
        contactPerson = {
          name: manager.name,
          role: 'Sales Manager',
          phone: manager.phone!
        };
      }
    }

    if (!contactPerson) {
      const tenant = await Tenant.findById(lead.tenantId);
      if (tenant && tenant.phone) {
        contactPerson = {
          name: tenant.name,
          role: 'Admin',
          phone: tenant.phone
        };
      }
    }

    let limitMessage = 'Please contact to proceed.';
    if (contactPerson) {
      limitMessage = `Please contact the concern person to get more fetails about this: ${contactPerson.name} (${contactPerson.role}) at ${contactPerson.phone}.`;
    }

    if (io) io.to('/crm').emit(streamEvent, { token: limitMessage });
    await sendWhatsAppText(leadId, lead.mobile, limitMessage, true);
    return;
  }

  // Not exceeded -> increment and save
  lead = await Lead.findByIdAndUpdate(
    leadId,
    { $inc: { 'aiContext.attempts': 1 } },
    { new: true },
  );
  if (!lead) return;

  if (io) io.to('/crm').emit(streamEvent, { token: '...' });

  let aiResponse = '';
  const provider = process.env.LLM_PROVIDER || 'gemini';
  const hasProviderKey = provider === 'groq'
    ? (process.env.GROQ_API_KEY && !process.env.GROQ_API_KEY.startsWith('mock'))
    : (process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.startsWith('mock'));

  // Semantic FAQ Cache Check
  const proposedPropertyId = lead.aiContext?.proposedPropertyId;
  if (proposedPropertyId && mongoose.Types.ObjectId.isValid(proposedPropertyId) && proposedPropertyId !== MOCK_PROPERTY_ID) {
    const cacheResult = await checkFaqCache(textMessage, lead.tenantId.toString(), proposedPropertyId);
    if (cacheResult) {
      console.log(`[FAQ Cache Hit] Tenant: ${lead.tenantId}, Project: ${proposedPropertyId}, Category: ${cacheResult.category}, Score: ${cacheResult.score}`);

      const firstName = lead.name ? lead.name.split(' ')[0] : '';
      aiResponse = firstName ? `Hi ${firstName}, ${cacheResult.answer}` : cacheResult.answer;

      if (lead.status !== 'Visit Scheduled') {
        lead.chatHistory.push(
          { role: 'user', text: textMessage },
          { role: 'model', text: aiResponse },
        );
        await lead.save();
      } else {
        await Lead.findByIdAndUpdate(leadId, {
          $push: {
            chatHistory: {
              $each: [
                { role: 'user', text: textMessage },
                { role: 'model', text: aiResponse },
              ],
            },
          },
        });
      }

      if (io) io.to('/crm').emit(streamEvent, { token: aiResponse });
      await sendWhatsAppText(leadId, lead.mobile, aiResponse, true);
      return;
    } else {
      console.log(`[FAQ Cache Miss] Tenant: ${lead.tenantId}, Project: ${proposedPropertyId}, Query: "${textMessage}"`);
    }
  }

  if (hasProviderKey) {
    try {
      const { runAgentConversation } = require('./aiAgentService');
      aiResponse = await runAgentConversation(lead, textMessage);
    } catch (err: any) {
      console.error('[AI Agent Fallback Triggered] Error in Agent Conversation:', err.message);
      aiResponse = await determineBaseResponse(lead, textMessage);
    }
  } else {
    const baseResponse = await determineBaseResponse(lead, textMessage);
    aiResponse = await polishWithAI(lead, baseResponse);
  }

  if (lead.status !== 'Visit Scheduled') {
    lead.chatHistory.push(
      { role: 'user', text: textMessage },
      { role: 'model', text: aiResponse },
    );
    await lead.save();
  } else {
    await Lead.findByIdAndUpdate(leadId, {
      $push: {
        chatHistory: {
          $each: [
            { role: 'user', text: textMessage },
            { role: 'model', text: aiResponse },
          ],
        },
      },
    });
  }

  if (io) io.to('/crm').emit(streamEvent, { token: aiResponse });
  await sendWhatsAppText(leadId, lead.mobile, aiResponse, true);
};

// --- Deprecated exports kept for backwards compatibility ---
export const runRuleBasedAssistant = async (lead: any, textMessage: string, io: any, streamEvent: string) => {
  console.warn('runRuleBasedAssistant is deprecated â€” use processIncomingMessage');
  await processIncomingMessage(lead._id.toString(), textMessage);
};

export const processAIConversation = async (leadId: string, textMessage: string) => {
  console.warn('processAIConversation is deprecated â€” use processIncomingMessage');
  await processIncomingMessage(leadId, textMessage);
};