import { Index } from '@upstash/vector';

export interface IFaqCache extends Record<string, unknown> {
  id?: string;
  tenantId: string;
  projectId: string;
  question: string;
  answer: string;
  category: 'project_facts' | 'pricing' | 'amenities' | 'legal' | 'loan' | 'lead_flow' | 'objection_script' | 'hard_rule';
  isGuardedFact: boolean;
}

// Check for required environment variables
const url = process.env.UPSTASH_VECTOR_REST_URL;
const token = process.env.UPSTASH_VECTOR_REST_TOKEN || 'placeholder_token_replace_me_in_env';

let realIndex: Index | null = null;

if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
  try {
    realIndex = new Index({
      url,
      token,
    });
  } catch (err: any) {
    console.warn('Failed to initialize Upstash Vector Index:', err.message);
  }
} else {
  console.warn('UPSTASH_VECTOR_REST_URL is missing or invalid. FaqCache vector operations will be bypassed.');
}

export const faqVectorIndex = realIndex || ({
  query: async () => [],
  upsert: async () => {},
  delete: async () => {},
} as unknown as Index);

