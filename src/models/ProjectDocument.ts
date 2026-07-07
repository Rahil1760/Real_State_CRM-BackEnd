import mongoose, { Schema, Document } from 'mongoose';

export interface IProjectDocument extends Document {
  tenantId: mongoose.Types.ObjectId;
  propertyId: mongoose.Types.ObjectId;
  fileName: string;
  s3Url: string;
  uploadedBy?: mongoose.Types.ObjectId;
  uploadedAt: Date;
  status: 'processing' | 'ready' | 'failed';
  errorReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectDocumentSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
    fileName: { type: String, required: true },
    s3Url: { type: String, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ['processing', 'ready', 'failed'],
      default: 'processing',
    },
    errorReason: { type: String },
  },
  { timestamps: true }
);

// Indexes
ProjectDocumentSchema.index({ tenantId: 1, propertyId: 1 });
ProjectDocumentSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model<IProjectDocument>('ProjectDocument', ProjectDocumentSchema);
