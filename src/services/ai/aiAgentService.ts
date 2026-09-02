import Lead, { ILead } from '../../models/Lead';
import Property from '../../models/Property';
import Tenant from '../../models/Tenant';
import User from '../../models/User';
import { generateLLMResponse, generateStructuredLLMResponse, AgentResponsePayload } from './llmProviderService';
import { resolvePropertyBrochure } from '../whatsapp/whatsappService';

// ─────────────────────────────────────────────────────────────
//  Build a rich, fully-contextual system prompt from live DB data.
//  Nothing is hardcoded — company name, bot name, properties,
//  lead state, conversation history, and brochure availability
//  all come from the database.
// ─────────────────────────────────────────────────────────────

async function buildSystemPrompt(lead: ILead): Promise<string> {
  const tenantId = lead.tenantId.toString();

  // ── Tenant / company context ─────────────────────────────────
  const tenant = await Tenant.findById(tenantId);
  const companyName = tenant?.senderDisplayName || tenant?.name || 'our real estate company';

  // ── Available properties & locations ─────────────────────────
  const allProperties = await Property.find({ tenantId });
  const uniqueLocations = Array.from(new Set(allProperties.map(p => p.location).filter(Boolean)));
  const locationsStr = uniqueLocations.join(', ') || 'various locations';

  // ── Proposed property details + brochure availability ────────
  let proposedPropertySection = '';
  if (lead.aiContext?.proposedPropertyId && lead.aiContext.proposedPropertyId !== 'mock_property_id') {
    const prop = await Property.findById(lead.aiContext.proposedPropertyId);
    if (prop) {
      const brochure = await resolvePropertyBrochure(prop).catch(() => null);
      proposedPropertySection = `
=== PROPOSED PROPERTY (already shared with lead — do NOT re-introduce) ===
- Title: ${prop.title}
- Location: ${prop.location}
- Price: ₹${prop.price.toLocaleString()}
- Type: ${prop.type}
- Amenities: ${prop.amenities.join(', ') || 'N/A'}
- Description: ${prop.description || 'N/A'}
- Brochure: ${brochure ? 'ALREADY SENT as a PDF file' : 'Not available'}
`;
    }
  }

  // ── All available inventory (brief list for matching) ────────
  const inventoryList = allProperties.length > 0
    ? allProperties.map(p =>
        `  • ${p.title} | ${p.type} | ${p.location} | ₹${p.price.toLocaleString()}`
      ).join('\n')
    : '  (No properties in inventory yet)';

  // ── Contact escalation person ────────────────────────────────
  let contactSection = '';
  try {
    let contactPerson: { name: string; role: string; phone: string } | null = null;

    if (lead.assignedTo) {
      const u = await User.findById(lead.assignedTo);
      if (u?.phone && ['Sales Executive', 'Sales Manager'].includes(u.role)) {
        contactPerson = { name: u.name, role: u.role, phone: u.phone };
      }
    }
    if (!contactPerson) {
      const exec = await User.findOne({ tenantId, role: 'Sales Executive', phone: { $ne: '' } });
      if (exec) contactPerson = { name: exec.name, role: 'Sales Executive', phone: exec.phone! };
    }
    if (!contactPerson) {
      const mgr = await User.findOne({ tenantId, role: 'Sales Manager', phone: { $ne: '' } });
      if (mgr) contactPerson = { name: mgr.name, role: 'Sales Manager', phone: mgr.phone! };
    }
    if (!contactPerson && tenant?.phone) {
      contactPerson = { name: companyName, role: 'Admin', phone: tenant.phone };
    }

    if (contactPerson) {
      contactSection = `
=== HUMAN ESCALATION ===
If the lead asks to speak to a person, share:
- Name: ${contactPerson.name}
- Role: ${contactPerson.role}
- Phone: ${contactPerson.phone}
`;
    }
  } catch (_) {}

  // ── Qualification fields collected vs missing ────────────────
  const collected: string[] = [];
  const missing: string[] = [];

  if (lead.budget && lead.budget > 0) collected.push(`Budget = ₹${lead.budget.toLocaleString()}`);
  else missing.push('budget');

  if (lead.location?.trim()) collected.push(`Location = ${lead.location}`);
  else missing.push('preferred location');

  if (lead.propertyType && lead.propertyType !== 'Any') collected.push(`Property type = ${lead.propertyType}`);
  else missing.push('property type (Apartment/Villa/Plot/Commercial)');

  if (lead.purpose && lead.purpose !== 'Any') collected.push(`Purpose = ${lead.purpose}`);
  else missing.push('purpose (Buy or Invest)');

  // ── Visit scheduling state ───────────────────────────────────
  let visitSchedulingSection = '';
  if (lead.status === 'Slot Pending') {
    const day = (lead.aiContext as any)?.selectedVisitDay || '';
    const period = (lead.aiContext as any)?.selectedVisitPeriod || '';
    visitSchedulingSection = `
=== VISIT SCHEDULING IN PROGRESS ===
- Day selected by lead: ${day || 'Not yet selected — ask for a day (Monday to Sunday)'}
- Time period: ${period || 'Not yet selected — once day is confirmed, ask Morning / Afternoon / Evening'}
INSTRUCTION: If the user provides both day and time or a specific schedule, accept it gracefully.
`;
  }

  // ── Recent conversation ──────────────────────────────────────
  const recentChat = (lead.chatHistory || [])
    .slice(-14)
    .map((m: any) => `${m.role === 'user' ? 'Lead' : 'You'}: ${m.text}`)
    .join('\n');

  // ── Build the full prompt ────────────────────────────────────
  return `You are the friendly, intelligent AI real estate assistant for ${companyName} on WhatsApp.
Your goal is to converse naturally with the lead, answer their queries, understand their preferences, and help schedule site visits.

=== STRICT CONVERSATIONAL GUIDELINES ===
1. CONCISE & NATURAL: 1–3 short sentences per WhatsApp message. Friendly, helpful, and natural (avoid sounding robotic or like an interrogation script).
2. ANSWER QUESTIONS FIRST: If the lead asks a question about a project, price, amenities, or location, answer it directly using the available inventory and project details BEFORE asking any qualifying question.
3. NO REPETITIVE QUESTIONS: NEVER ask for information that is already in "ALREADY COLLECTED" or that the user already mentioned in recent conversation.
4. HANDLE CORRECTIONS & HINGLISH: If the lead changes their mind (e.g., "actually my budget is 80 Lakhs"), accept it and update the budget. Understand English, Hindi, and Hinglish.
5. NO HALLUCINATIONS: Only mention properties and locations present in inventory: [${locationsStr}]. Never invent nonexistent listings.
6. BROCHURE: If the lead asks for a brochure, confirm it has already been sent as a PDF file (or say one will be shared shortly). Never send arbitrary URLs in chat.
7. VISIT BOOKING: When the lead shows interest in visiting, help them schedule smoothly. If they give a day/time, confirm it.

${contactSection}

=== AVAILABLE INVENTORY ===
${inventoryList}

${proposedPropertySection}

=== CURRENT LEAD STATE ===
- Name: ${lead.name}
- Status: ${lead.status}
- Budget: ${lead.budget ? `₹${lead.budget.toLocaleString()}` : 'Not provided'}
- Location: ${lead.location || 'Not provided'}
- Property type: ${lead.propertyType}
- Purpose: ${lead.purpose}

=== ALREADY COLLECTED — DO NOT RE-ASK ===
${collected.length > 0 ? collected.join('\n') : 'Nothing yet'}

=== STILL MISSING (weaved naturally, at most ONE per message) ===
${missing.length > 0 ? missing.join(', ') : 'All collected — proceed to property recommendation and visit scheduling.'}

${visitSchedulingSection}

=== RECENT CONVERSATION ===
${recentChat || '(No history yet — this is the first message)'}

=== REQUIRED JSON OUTPUT FORMAT ===
You MUST respond with a valid JSON object with EXACTLY this structure:
{
  "reply": "Your concise, friendly WhatsApp message here (1-3 sentences)",
  "extractedData": {
    "budget": <number in INR e.g. 7500000 if mentioned/corrected, else null>,
    "location": <string matched location from inventory if mentioned/corrected, else null>,
    "propertyType": <"Apartment" | "Villa" | "Plot" | "Commercial" | null>,
    "purpose": <"Buy" | "Invest" | null>,
    "visitDay": <"Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday" | null>,
    "visitPeriod": <"Morning" | "Afternoon" | "Evening" | null>,
    "isDeclined": <true if user clearly said no/not interested/rejected, else false>,
    "isAffirmativeVisit": <true if user wants or agreed to a visit, else false>,
    "requestHumanAgent": <true if user wants to speak to a real person/manager, else false>
  },
  "intent": <"inquiry" | "qualifying" | "schedule_visit" | "visit_confirmed" | "declined" | "handoff" | "general">
}
`;
}

// ─────────────────────────────────────────────────────────────
//  Public entry points
// ─────────────────────────────────────────────────────────────

export const runAgentStructuredConversation = async (
  lead: ILead,
  textMessage: string
): Promise<AgentResponsePayload> => {
  const systemInstruction = await buildSystemPrompt(lead);
  const history = lead.chatHistory || [];
  return await generateStructuredLLMResponse(lead, textMessage, history, systemInstruction);
};

export const runAgentConversation = async (lead: ILead, textMessage: string): Promise<string> => {
  const systemInstruction = await buildSystemPrompt(lead);
  const history = lead.chatHistory || [];
  return await generateLLMResponse(lead, textMessage, history, systemInstruction, true);
};

