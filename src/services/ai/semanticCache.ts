import mongoose from 'mongoose';
import FaqCache from '../../models/FaqCache';
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
    if (!mongoose.Types.ObjectId.isValid(tenantId) || !mongoose.Types.ObjectId.isValid(projectId)) {
      return null;
    }

    const queryEmbedding = await generateQueryEmbedding(message);

    const results = await FaqCache.aggregate([
      {
        $vectorSearch: {
          index: 'faq_vector_index', // Assuming they name the index faq_vector_index
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: 50,
          limit: 1,
          filter: {
            tenantId: new mongoose.Types.ObjectId(tenantId),
            projectId: new mongoose.Types.ObjectId(projectId),
          },
        },
      },
      {
        $project: {
          answer: 1,
          isGuardedFact: 1,
          category: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]);

    if (results && results.length > 0) {
      const topMatch = results[0];
      if (topMatch.score >= 0.90) {
        return {
          answer: topMatch.answer,
          isGuardedFact: topMatch.isGuardedFact,
          category: topMatch.category,
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
