import mongoose from 'mongoose';
import { faqVectorIndex, IFaqCache } from '../../models/FaqCache';
import { generateQueryEmbedding } from './aiTools';

export interface CacheResult {
  answer: string;
  isGuardedFact: boolean;
  category: string;
  score: number;
}

export const checkFaqCache = async (
  message: string,
  tenantId: string,
  projectId: string
): Promise<CacheResult | null> => {
  try {
    if (!tenantId || !projectId) {
      return null;
    }

    const queryEmbedding = await generateQueryEmbedding(message);

    const results = await faqVectorIndex.query<IFaqCache>({
      vector: queryEmbedding,
      topK: 1,
      includeMetadata: true,
      filter: `tenantId = '${tenantId}' AND projectId = '${projectId}'`,
    });

    if (results && results.length > 0) {
      const topMatch = results[0];
      if (topMatch.score >= 0.90 && topMatch.metadata) {
        return {
          answer: topMatch.metadata.answer,
          isGuardedFact: topMatch.metadata.isGuardedFact,
          category: topMatch.metadata.category,
          score: topMatch.score,
        };
      }
    }

    return null;
  } catch (error: any) {
    console.error('[checkFaqCache Error]:', error.message);
    return null;
  }
};

export const MAX_FAQ_LIMIT = 20;

export interface SaveFaqInput {
  id?: string;
  tenantId: string;
  projectId: string;
  question: string;
  answer: string;
  category: 'project_facts' | 'pricing' | 'amenities' | 'legal' | 'loan' | 'lead_flow' | 'objection_script' | 'hard_rule';
  isGuardedFact?: boolean;
}

export const saveFaqToCache = async (
  faq: SaveFaqInput
): Promise<{ success: boolean; message: string; id?: string }> => {
  try {
    const { tenantId, projectId, question, answer, category, isGuardedFact = false } = faq;

    if (!tenantId || !projectId || !question || !answer) {
      return { success: false, message: 'tenantId, projectId, question, and answer are required.' };
    }

    const queryEmbedding = await generateQueryEmbedding(`${question}\n${answer}`);

    // Query existing vectors for this tenant & project to enforce the 20 question limit
    const existingFaqs = await faqVectorIndex.query<IFaqCache>({
      vector: queryEmbedding,
      topK: MAX_FAQ_LIMIT + 1,
      includeMetadata: true,
      filter: `tenantId = '${tenantId}' AND projectId = '${projectId}'`,
    });

    const isUpdate = faq.id && existingFaqs.some((item) => item.id === faq.id);

    if (!isUpdate && existingFaqs && existingFaqs.length >= MAX_FAQ_LIMIT) {
      return {
        success: false,
        message: `Cannot save FAQ. Maximum limit of ${MAX_FAQ_LIMIT} questions reached for project ${projectId}.`,
      };
    }

    const faqId = faq.id || `${tenantId}-${projectId}-${Date.now()}`;

    await faqVectorIndex.upsert({
      id: faqId,
      vector: queryEmbedding,
      metadata: {
        tenantId,
        projectId,
        question,
        answer,
        category,
        isGuardedFact,
      },
    });

    return {
      success: true,
      message: `FAQ vector successfully cached (${(existingFaqs?.length || 0) + (isUpdate ? 0 : 1)}/${MAX_FAQ_LIMIT}).`,
      id: faqId,
    };
  } catch (error: any) {
    console.error('[saveFaqToCache Error]:', error.message);
    return { success: false, message: error.message };
  }
};

