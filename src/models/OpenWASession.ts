import mongoose, { Schema, Document } from 'mongoose';

export interface IOpenWASession extends Document {
  tenantId: mongoose.Types.ObjectId;
  sessionId: string;
  qrCode: string;
  status: 'disconnected' | 'pending_scan' | 'connected' | 'expired';
  sessionToken?: string;
  phoneInfo?: {
    wid?: string;
    pushname?: string;
  };
  lastSeen?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OpenWASessionSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, unique: true, index: true },
    sessionId: { type: String, required: true },
    qrCode: { type: String, default: '' },
    status: {
      type: String,
      enum: ['disconnected', 'pending_scan', 'connected', 'expired'],
      default: 'disconnected',
    },
    sessionToken: { type: String, default: '' },
    phoneInfo: {
      wid: { type: String, default: '' },
      pushname: { type: String, default: '' },
    },
    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model<IOpenWASession>('OpenWASession', OpenWASessionSchema);
