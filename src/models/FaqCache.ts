import mongoose, { Schema, Document } from 'mongoose';

export interface IFaqCache extends Document {
  tenantId: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  question: string;
  answer: string;
  category: 'project_facts' | 'pricing' | 'amenities' | 'legal' | 'loan' | 'lead_flow' | 'objection_script' | 'hard_rule';
  embedding: number[];
  isGuardedFact: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FaqCacheSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
    question: { type: String, required: true },
    answer: { type: String, required: true },
    category: {
      type: String,
      enum: ['project_facts', 'pricing', 'amenities', 'legal', 'loan', 'lead_flow', 'objection_script', 'hard_rule'],
      required: true,
    },
    embedding: { type: [Number], required: true },
    isGuardedFact: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// SaaS Compound & Vector search support indexes
FaqCacheSchema.index({ tenantId: 1, projectId: 1 });

/*
 MongoDB Atlas Vector Search Index Definition for faqCache:
 {
   "fields": [
     {
       "type": "vector",
       "path": "embedding",
       "numDimensions": 384,
       "similarity": "cosine"
     },
     {
       "type": "filter",
       "path": "tenantId"
     },
     {
       "type": "filter",
       "path": "projectId"
     }
   ]
 }
*/

export default mongoose.model<IFaqCache>('FaqCache', FaqCacheSchema);
