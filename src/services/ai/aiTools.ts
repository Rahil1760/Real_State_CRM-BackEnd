import mongoose from 'mongoose';
import Fuse from 'fuse.js';
import Property from '../../models/Property';
import DocumentChunk from '../../models/DocumentChunk';

// Cosine Similarity calculator for local in-memory fallback
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

let embedPipeline: any = null;

export async function generateQueryEmbedding(query: string): Promise<number[]> {
  if (!embedPipeline) {
    const { pipeline } = require('@xenova/transformers');
    embedPipeline = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5');
  }
  const output = await embedPipeline(query, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// Tool 1: Search Project Documents (brochures, floor plans, pricing)
export const searchProjectDocs = async (
  tenantId: string,
  propertyId: string,
  query: string
): Promise<Array<{ text: string; pageNumber: number; score?: number }>> => {
  try {
    if (!mongoose.Types.ObjectId.isValid(propertyId)) {
      return [];
    }

    const queryEmbedding = await generateQueryEmbedding(query);

    // 1. Attempt MongoDB Atlas Vector Search
    try {
      const results = await DocumentChunk.aggregate([
        {
          $vectorSearch: {
            index: 'vector_index',
            path: 'embedding',
            queryVector: queryEmbedding,
            numCandidates: 100,
            limit: 5,
            filter: {
              tenantId: new mongoose.Types.ObjectId(tenantId),
              propertyId: new mongoose.Types.ObjectId(propertyId),
            },
          },
        },
        {
          $project: {
            text: 1,
            pageNumber: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ]);

      if (results && results.length > 0) {
        return results.map(r => ({
          text: r.text,
          pageNumber: r.pageNumber,
          score: r.score,
        }));
      }
    } catch (vectorSearchError: any) {
      console.warn('[Vector Search] Atlas Vector Search failed or index not found. Falling back to in-memory similarity.');
    }

    // 2. Local Fallback: Fetch all chunks for this property and rank in-memory
    const chunks = await DocumentChunk.find({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      propertyId: new mongoose.Types.ObjectId(propertyId),
    });

    if (chunks.length === 0) {
      return [];
    }

    const scoredChunks = chunks.map(chunk => {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      return {
        text: chunk.text,
        pageNumber: chunk.pageNumber,
        score,
      };
    });

    // Sort by score descending and return top 5
    scoredChunks.sort((a, b) => b.score - a.score);
    return scoredChunks.slice(0, 5);

  } catch (error: any) {
    console.error('[searchProjectDocs Error]:', error.message);
    return [];
  }
};

// Tool 2: Fuzzy match property name mentioned in chat to retrieve property ID
export const matchPropertyByName = async (
  tenantId: string,
  name: string
): Promise<Array<{ id: string; title: string; location: string; price: number }>> => {
  try {
    const properties = await Property.find({ tenantId });
    if (!name || name.trim() === '' || properties.length === 0) {
      return [];
    }

    const fuse = new Fuse(properties, {
      keys: ['title', 'location'],
      threshold: 0.4,
    });

    const results = fuse.search(name.trim());
    return results.map(res => ({
      id: res.item._id.toString(),
      title: res.item.title,
      location: res.item.location,
      price: res.item.price,
    }));
  } catch (error: any) {
    console.error('[matchPropertyByName Error]:', error.message);
    return [];
  }
};
