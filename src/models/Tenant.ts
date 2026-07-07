import mongoose, { Schema, Document } from 'mongoose';

export interface ITenant extends Document {
  name: string;
  slug: string;
  ownerEmail: string;
  phone: string;
  logo?: string;
  plan: 'free' | 'starter' | 'pro' | 'enterprise';
  subscriptionId?: string;
  subscriptionStatus: 'active' | 'paused' | 'cancelled' | 'trial';
  trialEndsAt: Date;
  billingCycle: 'monthly' | 'yearly';
  maxLeads: number;
  maxUsers: number;
  maxProperties: number;
  whatsappPhoneId?: string; // encrypted
  whatsappToken?: string;   // encrypted
  razorpayKeyId?: string;
  razorpaySecret?: string;
  whatsappWelcomeTemplateName?: string;
  senderDisplayName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TenantSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true, lowercase: true },
    ownerEmail: { type: String, required: true, lowercase: true },
    phone: { type: String, required: true },
    logo: { type: String },
    plan: {
      type: String,
      enum: ['free', 'starter', 'pro', 'enterprise'],
      default: 'free',
    },
    subscriptionId: { type: String },
    subscriptionStatus: {
      type: String,
      enum: ['active', 'paused', 'cancelled', 'trial'],
      default: 'trial',
    },
    trialEndsAt: {
      type: Date,
      default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days trial
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'yearly'],
      default: 'monthly',
    },
    maxLeads: { type: Number, default: 50 },
    maxUsers: { type: Number, default: 2 },
    maxProperties: { type: Number, default: 5 },
    whatsappPhoneId: { type: String },
    whatsappToken: { type: String },
    razorpayKeyId: { type: String },
    razorpaySecret: { type: String },
    whatsappWelcomeTemplateName: { type: String, default: 'lead_welcome_v1' },
    senderDisplayName: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model<ITenant>('Tenant', TenantSchema);
