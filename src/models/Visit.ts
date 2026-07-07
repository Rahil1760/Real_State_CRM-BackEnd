import mongoose, { Schema, Document } from 'mongoose';

export interface IVisit extends Document {
  tenantId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId;
  propertyId: mongoose.Types.ObjectId;
  scheduledAt: Date;
  status: 'Scheduled' | 'Completed' | 'No-Show' | 'Cancelled';
  feedback?: string;
  scoreAfterVisit?: 'Hot' | 'Warm' | 'Cold';
  createdAt: Date;
  updatedAt: Date;
}

const VisitSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
    scheduledAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ['Scheduled', 'Completed', 'No-Show', 'Cancelled'],
      default: 'Scheduled',
    },
    feedback: { type: String },
    scoreAfterVisit: { type: String, enum: ['Hot', 'Warm', 'Cold', null], default: null },
  },
  { timestamps: true }
);

// Indexes
VisitSchema.index({ tenantId: 1, createdAt: -1 });
VisitSchema.index({ tenantId: 1, status: 1 });

export default mongoose.model<IVisit>('Visit', VisitSchema);
