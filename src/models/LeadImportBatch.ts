import mongoose, { Schema, Document } from 'mongoose';

export interface ILeadImportBatch extends Document {
  batchId: string;
  tenantId: mongoose.Types.ObjectId;
  status: 'processing' | 'completed' | 'failed';
  total: number;
  success: number;
  failed: number;
  rowErrors: Array<{
    row: number;
    error: string;
    details?: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const LeadImportBatchSchema: Schema = new Schema(
  {
    batchId: { type: String, required: true, unique: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    status: {
      type: String,
      enum: ['processing', 'completed', 'failed'],
      default: 'processing',
    },
    total: { type: Number, default: 0 },
    success: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    rowErrors: [
      {
        row: { type: Number, required: true },
        error: { type: String, required: true },
        details: { type: String },
      },
    ],
  },
  { timestamps: true }
);

// Isolated compound index
LeadImportBatchSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model<ILeadImportBatch>('LeadImportBatch', LeadImportBatchSchema);
