import mongoose, { Schema, Document } from 'mongoose';

export interface ICampaignStep {
  delay: number; // in hours
  channel: 'WhatsApp' | 'Email' | 'SMS';
  template: string;
}

export interface ICampaign extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  trigger: 'Immediate' | 'EMI Schedule' | 'Construction Update' | 'Possession' | 'Referral Program';
  steps: ICampaignStep[];
  createdAt: Date;
  updatedAt: Date;
}

const CampaignSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true },
    trigger: {
      type: String,
      enum: ['Immediate', 'EMI Schedule', 'Construction Update', 'Possession', 'Referral Program'],
      required: true,
    },
    steps: [
      {
        delay: { type: Number, required: true },
        channel: { type: String, enum: ['WhatsApp', 'Email', 'SMS'], required: true },
        template: { type: String, required: true },
      },
    ],
  },
  { timestamps: true }
);

// Indexes
CampaignSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model<ICampaign>('Campaign', CampaignSchema);
