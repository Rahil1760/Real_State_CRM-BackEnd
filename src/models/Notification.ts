import mongoose, { Schema, Document } from 'mongoose';

export interface INotification extends Document {
  tenantId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId | null;
  channel: 'WhatsApp' | 'Email' | 'SMS' | 'System';
  message: string;
  sentAt: Date;
  status: 'Sent' | 'Failed' | 'Pending';
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    channel: {
      type: String,
      enum: ['WhatsApp', 'Email', 'SMS', 'System'],
      required: true,
    },
    message: { type: String, required: true },
    sentAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ['Sent', 'Failed', 'Pending'],
      default: 'Sent',
    },
  },
  { timestamps: true }
);

// Indexes
NotificationSchema.index({ tenantId: 1, createdAt: -1 });

export default mongoose.model<INotification>('Notification', NotificationSchema);
