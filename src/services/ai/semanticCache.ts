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
