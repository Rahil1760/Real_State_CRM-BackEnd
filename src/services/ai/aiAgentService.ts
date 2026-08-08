import Lead, { ILead } from '../../models/Lead';
import Property from '../../models/Property';
import Tenant from '../../models/Tenant';
import { generateLLMResponse } from './llmProviderService';
import { resolvePropertyBrochure } from '../whatsapp/whatsappService';
import { buildLocationConstraintText, formatIndianCurrency } from './aiService';

export const runAgentConversation = async (lead: ILead, textMessage: string): Promise<string> => {
  // Fetch tenant info for dynamic company and bot names
  const tenant = await Tenant.findById(lead.tenantId);
  const companyName = tenant?.name || 'RealtyCloudai';
  const botName = tenant?.senderDisplayName || 'Kayra';

  // Build system instruction prompt with lead context
  const locationConstraintText = await buildLocationConstraintText(lead.tenantId.toString());

  let proposedPropertyContext = '';
  let brochureInfo = '';

  if (lead.aiContext?.proposedPropertyId) {
    const prop = await Property.findById(lead.aiContext.proposedPropertyId);
    if (prop) {
      proposedPropertyContext = `
Proposed Property Details:
- ID: ${prop._id}
- Title: ${prop.title}
- Location: ${prop.location}
- Price: ${formatIndianCurrency(prop.price)}
`;

      const brochure = await resolvePropertyBrochure(prop);
      if (brochure) {
        brochureInfo = `
=== BROCHURE AVAILABILITY ===
A PDF brochure is available for "${prop.title}". If the lead explicitly asks for the brochure, layout, details, or PDF, tell them you are sending it. The system will deliver the document automatically.
`;
      }
    }
  }

  let teamContactsContext = '';
  try {
    const User = require('../../models/User').default;

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
    console.error('Failed to fetch team contacts for agent prompt:', err);
  }

  const now = new Date();
  const currentDateContext = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
  });

  const systemInstruction = `You are ${botName}, the intelligent and welcoming AI assistant for ${companyName}. 
Your primary task is to maintain a good relationship with the lead, qualify their property preferences (budget, location, property type, and intent), and convert them into scheduling a site visit.

=== CURRENT DATE & TIME (CRITICAL FOR CALENDAR/SCHEDULING) ===
- Current Time: ${currentDateContext}
- Reference: Today is ${now.toLocaleString('en-US', { weekday: 'long' })}, ${now.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.
Ensure that dates you mention align with this calendar day (e.g., if today is Sunday the 26th, then tomorrow is Monday the 27th, not Saturday).

Follow these strict rules for every response:
1. CONVERSATIONAL & CONCISE: You are chatting on WhatsApp. Keep your responses to 1-3 short sentences. Never send large blocks of text.
2. ONE QUESTION AT A TIME: Ask one question at a time. Do not overwhelm the user.
3. ACCURATE INVENTORY & LOCATIONS (CRITICAL): Only discuss locations and projects explicitly listed in active inventory. Never mention unlisted locations. If there is only 1 project in a location, do NOT say "we have a few options" or "multiple options"—refer specifically to the single project available.
4. ACCURATE CURRENCY CONVERSION (CRITICAL): Understand Indian currency units: 1 Lakh (Lac/Lacs) = ₹1,00,000 (0.01 Crore). 60 Lakhs (60 lacs) is ₹60 Lakhs (₹60,00,000 or 0.6 Crore), NOT 6 Crores. Never confuse Lakhs with Crores.
5. NO HALLUCINATIONS: If property details, pricing, amenities, or document excerpts are provided in the context below, use them precisely. Never invent numbers, names, or locations.
6. USE PROVIDED CONTEXT: All relevant property data and document excerpts will be injected into this prompt before you respond. If you see "PROJECT DOCUMENT EXCERPTS" or "PROPOSED PROPERTY" sections below, cite them directly.
7. QUALIFY LEADS: If context is missing, collect missing details (budget, location, property type, intent) one question at a time before proceeding.
8. TONE: Be professional, empathetic, and highly accommodating. Always prioritize maintaining a good relationship with the lead and converting them to a site visit.
9. FLEXIBLE SCHEDULING (CRITICAL): When scheduling a site visit, you must accept whatever day/time the lead proposes (including Sunday, weekends, tomorrow, or specific times) without any pushback. Never say a day is challenging, unavailable, or request verification from the site team. Immediately confirm the schedule. Do not repeat menus or suggest alternatives unless the lead explicitly asks for a change.

${teamContactsContext}

${locationConstraintText}

${brochureInfo}

=== CURRENT LEAD STATE ===
- Lead Name: ${lead.name}
- Lead ID: ${lead._id}
- Tenant ID: ${lead.tenantId}
- Current Status: ${lead.status}
- Budget: ${lead.budget ? formatIndianCurrency(lead.budget) : 'Not provided'}
- Preferred Location: ${lead.location || 'Not provided'}
- Property Type: ${lead.propertyType}
- Purpose: ${lead.purpose}
${proposedPropertyContext}
`;

  // Route to provider service
  const history = lead.chatHistory || [];
  return await generateLLMResponse(lead, textMessage, history, systemInstruction, true);
};
