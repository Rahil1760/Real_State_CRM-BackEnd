import Property from '../../models/Property';
import Lead from '../../models/Lead';
import { searchProjectDocs, matchPropertyByName } from './aiTools';

// ─────────────────────────────────────────────────────────────
//  RAG Pre-Execution Layer
//  Pre-fetches tool data BEFORE the LLM call so we make
//  exactly ONE API call per user message.
// ─────────────────────────────────────────────────────────────

const PROPERTY_QUERY_KEYWORDS = [
  'price', 'cost', 'rate', 'budget', 'brochure', 'floor plan', 'layout',
  'amenity', 'amenities', 'location', 'possession', 'rera', 'loan',
  'size', 'bhk', 'sqft', 'sq ft', 'area', 'maintenance', 'parking',
  'discount', 'offer', 'scheme', 'booking', 'unit', 'configuration',
];

function looksLikePropertyQuery(text: string): boolean {
  const lower = text.toLowerCase();
  return PROPERTY_QUERY_KEYWORDS.some(kw => lower.includes(kw));
}

async function buildRagContext(lead: any, textMessage: string): Promise<string> {
  const sections: string[] = [];
  const tenantId = lead.tenantId.toString();

  // ── 1. Resolve which property to use ───────────────────────
  let resolvedPropertyId: string | null = lead.aiContext?.proposedPropertyId || null;

  // Try to detect a property name in the message
  if (!resolvedPropertyId) {
    const lower = textMessage.toLowerCase();
    const properties = await Property.find({ tenantId });
    for (const p of properties) {
      if (lower.includes(p.title.toLowerCase())) {
        // Auto-link lead to detected property
        await Lead.findByIdAndUpdate(lead._id, {
          'aiContext.proposedPropertyId': p._id.toString(),
        });
        lead.aiContext.proposedPropertyId = p._id.toString();
        resolvedPropertyId = p._id.toString();
        sections.push(`=== PROPERTY MATCHED FROM MESSAGE ===\n- ID: ${p._id}\n- Title: ${p.title}\n- Location: ${p.location}\n- Price: ₹${p.price.toLocaleString()}\n`);
        break;
      }
    }
  }

  // Fuzzy match via matchPropertyByName helper
  if (!resolvedPropertyId) {
    const words = textMessage.split(/\s+/).filter(w => w.length > 3);
    for (const word of words) {
      const matched = await matchPropertyByName(tenantId, word);
      if (matched.length === 1) {
        await Lead.findByIdAndUpdate(lead._id, {
          'aiContext.proposedPropertyId': matched[0].id,
        });
        lead.aiContext.proposedPropertyId = matched[0].id;
        resolvedPropertyId = matched[0].id;
        sections.push(`=== PROPERTY MATCHED FROM MESSAGE ===\n- ID: ${matched[0].id}\n- Title: ${matched[0].title}\n`);
        break;
      }
    }
  }

  // ── 2. Always inject known project context if available ─────
  if (resolvedPropertyId) {
    const prop = await Property.findById(resolvedPropertyId);
    if (prop) {
      sections.push(`=== PROPOSED PROPERTY ===
- ID: ${prop._id}
- Title: ${prop.title}
- Location: ${prop.location}
- Price: ₹${prop.price.toLocaleString()}
- Amenities: ${(prop as any).amenities || 'Not listed'}
`);
    }

    // ── 3. Fetch RAG doc chunks if message looks like a property query ─
    if (looksLikePropertyQuery(textMessage)) {
      try {
        const docs = await searchProjectDocs(tenantId, resolvedPropertyId, textMessage);
        if (docs && docs.length > 0) {
          const docSnippets = docs.slice(0, 3).map((d: any) => `[Page ${d.page}] ${d.text}`).join('\n\n');
          sections.push(`=== PROJECT DOCUMENT EXCERPTS ===\n${docSnippets}`);
        }
      } catch (err: any) {
        console.warn('[RAG Fetch] searchProjectDocs failed (non-fatal):', err.message);
      }
    }
  }

  return sections.join('\n');
}

// ─────────────────────────────────────────────────────────────
//  Single-call LLM Invocation via Groq (OpenAI-compatible SDK)
// ─────────────────────────────────────────────────────────────

async function callGroq(
  systemInstruction: string,
  history: any[],
  textMessage: string
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured.');

  const OpenAI = require('openai');
  const groq = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
  const modelName = process.env.LLM_MODEL || 'llama-3.3-70b-versatile';

  const messages: any[] = [
    { role: 'system', content: systemInstruction },
    ...history.slice(-20).map((msg: any) => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.text,
    })),
    { role: 'user', content: textMessage },
  ];

  let retries = 3;
  while (retries > 0) {
    try {
      const startTime = Date.now();
      // NO tools parameter — data is pre-injected in system prompt
      const response = await groq.chat.completions.create({
        model: modelName,
        messages,
        temperature: 0.5,
      });

      const ms = Date.now() - startTime;
      const usage = response.usage;
      console.log(
        `[LLM API Call] Provider: groq | Model: ${modelName} | Time: ${ms}ms | Tokens: ${usage?.total_tokens ?? 0} (In: ${usage?.prompt_tokens ?? 0}, Out: ${usage?.completion_tokens ?? 0})`
      );

      return (response.choices[0].message.content || '').trim();
    } catch (err: any) {
      retries--;
      console.error(`[Groq API Error] Retries left: ${retries}.`, err.message);
      if (retries === 0) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return '';
}

// ─────────────────────────────────────────────────────────────
//  Single-call LLM Invocation via Google Gemini
// ─────────────────────────────────────────────────────────────

async function callGemini(
  systemInstruction: string,
  history: any[],
  textMessage: string
): Promise<string> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey || geminiApiKey.startsWith('mock')) {
    throw new Error('Gemini API key is not configured.');
  }

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

  const model = genAI.getGenerativeModel({ model: modelName, systemInstruction }, { apiVersion: 'v1beta' });

  // Gemini history must start with 'user'
  let formattedHistory = history.slice(-20).map((msg: any) => ({
    role: msg.role === 'user' ? ('user' as const) : ('model' as const),
    parts: [{ text: msg.text }],
  }));
  while (formattedHistory.length > 0 && formattedHistory[0].role !== 'user') {
    formattedHistory.shift();
  }

  const chat = model.startChat({ history: formattedHistory });

  const startTime = Date.now();
  // NO tools passed — context is pre-injected in system prompt
  const result = await chat.sendMessage(textMessage);
  const ms = Date.now() - startTime;
  console.log(`[LLM API Call] Provider: gemini | Model: ${modelName} | Time: ${ms}ms`);

  return result.response.text().trim();
}

// ─────────────────────────────────────────────────────────────
//  Public Interface — always exactly 1 API call
// ─────────────────────────────────────────────────────────────

export const generateLLMResponse = async (
  lead: any,
  textMessage: string,
  history: any[],
  systemInstruction: string,
  _toolsEnabled = true           // flag kept for API compatibility; RAG is now pre-injected
): Promise<string> => {
  // Step 1: Pre-execute retrieval and inject into system prompt
  const ragContext = await buildRagContext(lead, textMessage);
  const enrichedInstruction = ragContext
    ? `${systemInstruction}\n\n${ragContext}`
    : systemInstruction;

  // Step 2: Single LLM call
  const provider = process.env.LLM_PROVIDER || 'gemini';
  if (provider === 'groq') {
    return await callGroq(enrichedInstruction, history, textMessage);
  } else {
    return await callGemini(enrichedInstruction, history, textMessage);
  }
};
