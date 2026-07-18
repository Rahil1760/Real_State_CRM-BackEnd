import Lead, { ILead } from '../../models/Lead';
import Property from '../../models/Property';
import { generateLLMResponse } from './llmProviderService';

export const runAgentConversation = async (lead: ILead, textMessage: string): Promise<string> => {
  // Build system instruction prompt with lead context
  const allProperties = await Property.find({ tenantId: lead.tenantId });
  const uniqueLocations = Array.from(new Set(allProperties.map(p => p.location).filter(Boolean)));
  const locationsStr = uniqueLocations.join(', ') || 'None';

  const locationConstraintText = `
=== PROJECT LOCATION LIMITATION ===
Active project locations for this tenant: [${locationsStr}]
CRITICAL RULE: When proposing, recommending, or discussing project locations, you MUST only suggest or mention locations from the active list above. Do NOT suggest or guess other locations (such as College Road, Gangapur Road, etc.) if they are not in this list.
`;

  let proposedPropertyContext = '';

  if (lead.aiContext?.proposedPropertyId) {
    const prop = await Property.findById(lead.aiContext.proposedPropertyId);
    if (prop) {
      proposedPropertyContext = `
Proposed Property Details:
- ID: ${prop._id}
- Title: ${prop.title}
- Location: ${prop.location}
- Price: â‚¹${prop.price.toLocaleString()}
`;
    }
  }

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
    console.error('Failed to fetch team contacts for agent prompt:', err);
  }

  const systemInstruction = `You are Aura, the intelligent and Welcoming AI assistant for RealtyCloudai real estate. 
Your primary goal is to qualify leads by collecting their property preferences (budget, location, property type, and intent) and scheduling a site visit.

Follow these strict rules for every response:
1. CONVERSATIONAL & CONCISE: You are chatting on WhatsApp. Keep your responses to 1-3 short sentences. Never send large blocks of text.
2. ONE QUESTION AT A TIME: Ask one question at a time. Do not overwhelm the user.
3. NO HALLUCINATIONS: If property details, pricing, amenities, or document excerpts are provided in the context below, use them precisely. Never invent numbers, names, or locations.
4. USE PROVIDED CONTEXT: All relevant property data and document excerpts will be injected into this prompt before you respond. If you see "PROJECT DOCUMENT EXCERPTS" or "PROPOSED PROPERTY" sections below, cite them directly.
5. QUALIFY LEADS: If context is missing, collect missing details (budget, location, property type, intent) one question at a time before proceeding.

${teamContactsContext}

${locationConstraintText}

=== CURRENT LEAD STATE ===
- Lead Name: ${lead.name}
- Lead ID: ${lead._id}
- Tenant ID: ${lead.tenantId}
- Current Status: ${lead.status}
- Budget: ${lead.budget ? 'â‚¹' + lead.budget.toLocaleString() : 'Not provided'}
- Preferred Location: ${lead.location || 'Not provided'}
- Property Type: ${lead.propertyType}
- Purpose: ${lead.purpose}
${proposedPropertyContext}
`;

  // Route to provider service
  const history = lead.chatHistory || [];
  return await generateLLMResponse(lead, textMessage, history, systemInstruction, true);
};
