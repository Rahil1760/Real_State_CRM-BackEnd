import mongoose, { Schema, Document } from 'mongoose';
import { encrypt, decrypt } from '../services/tenant/crypto';

export interface ITenant extends Document {
  name: string;
  slug: string;
  ownerEmail: string;
  phone: string;
  logo?: string;
  plan: 'free' | 'starter' | 'pro' | 'growth' | 'enterprise';
  subscriptionId?: string;
  subscriptionStatus: 'active' | 'paused' | 'cancelled' | 'trial';
  trialEndsAt: Date;
  billingCycle: 'monthly' | 'yearly';
  maxLeads: number;
  maxUsers: number;
  maxProperties: number;
  whatsappPhoneId?: string; // encrypted
  whatsappToken?: string;   // encrypted
  whatsappProvider?: 'meta' | 'openwa';
  metaConfig?: {
    phoneNumberId?: string;
    accessToken?: string;
    businessAccountId?: string;
  };
  openwaConfig?: {
    sessionId?: string;
    qrCode?: string;
    isConnected?: boolean;
    lastSeen?: Date;
  };
  razorpayKeyId?: string;
  razorpaySecret?: string;
  whatsappWelcomeTemplateName?: string;
  senderDisplayName?: string;
  marketingSpend?: number;
  marketingSpendBreakdown?: {
    meta: number;
    google: number;
    other: number;
  };
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
      enum: ['free', 'starter', 'pro', 'growth', 'enterprise'],
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
    whatsappPhoneId: { 
      type: String,
      get: (val: string) => val ? decrypt(val) : val,
      set: (val: string) => val ? encrypt(val) : val
    },
    whatsappToken: { 
      type: String,
      get: (val: string) => val ? decrypt(val) : val,
      set: (val: string) => val ? encrypt(val) : val
    },
    whatsappProvider: {
      type: String,
      enum: ['meta', 'openwa'],
      default: 'meta',
    },
    metaConfig: {
      phoneNumberId: { 
        type: String, 
        default: '',
        get: (val: string) => val ? decrypt(val) : val,
        set: (val: string) => val ? encrypt(val) : val
      },
      accessToken: { 
        type: String, 
        default: '',
        get: (val: string) => val ? decrypt(val) : val,
        set: (val: string) => val ? encrypt(val) : val
      },
      businessAccountId: { type: String, default: '' },
    },
    openwaConfig: {
      sessionId: { type: String, default: '' },
      qrCode: { type: String, default: '' },
      isConnected: { type: Boolean, default: false },
      lastSeen: { type: Date, default: null },
    },
    razorpayKeyId: { type: String },
    razorpaySecret: { type: String },
    whatsappWelcomeTemplateName: { type: String, default: 'welcome_massage' },
    senderDisplayName: { type: String, default: '' },
    marketingSpend: { type: Number, default: 0 },
    marketingSpendBreakdown: {
      meta: { type: Number, default: 0 },
      google: { type: Number, default: 0 },
      other: { type: Number, default: 0 },
    },
  },
  { 
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true }
  }
);

export default mongoose.model<ITenant>('Tenant', TenantSchema);
