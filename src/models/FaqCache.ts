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

if (!url) {
  console.warn('UPSTASH_VECTOR_REST_URL is missing. FaqCache vector operations will fail.');
}

export const faqVectorIndex = new Index({
  url: url || '',
  token: token,
});
