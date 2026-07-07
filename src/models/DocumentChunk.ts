import mongoose, { Schema, Document } from 'mongoose';

export interface IDocumentChunk extends Document {
  tenantId: mongoose.Types.ObjectId;
  propertyId: mongoose.Types.ObjectId;
  documentId: mongoose.Types.ObjectId;
  pageNumber: number;
  chunkIndex: number;
  text: string;
  embedding: number[];
  createdAt: Date;
}

const DocumentChunkSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'ProjectDocument', required: true },
    pageNumber: { type: Number, required: true },
    chunkIndex: { type: Number, required: true },
    text: { type: String, required: true },
    embedding: { type: [Number], required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// SaaS Compound & Vector search support indexes
DocumentChunkSchema.index({ tenantId: 1, propertyId: 1 });
DocumentChunkSchema.index({ tenantId: 1, documentId: 1 });

export default mongoose.model<IDocumentChunk>('DocumentChunk', DocumentChunkSchema);
