import mongoose, { Schema, Document } from 'mongoose';

export interface ITimelineEvent {
  event: string;
  timestamp: Date;
  actor: 'System' | 'AI' | 'Sales Executive' | 'Sales Manager' | 'Admin' | 'Lead';
  details?: string;
}

export interface IChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface ILead extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  mobile: string;
  email: string;
  source: string;
  budget: number;
  location: string;
  propertyType: 'Apartment' | 'Villa' | 'Plot' | 'Commercial' | 'Any';
  purpose: 'Buy' | 'Invest' | 'Any';
  status:
  | 'New'
  | 'Qualifying'
  | 'Qualified'
  | 'Incomplete'
  | 'Slot Pending'
  | 'Visit Scheduled'
  | 'Visit Done'
  | 'Ready to Buy'
  | 'Booked'
  | 'Cold';
  score: 'Hot' | 'Warm' | 'Cold' | null;
  assignedTo: mongoose.Types.ObjectId | null;
  timeline: ITimelineEvent[];
  aiContext: {
    attempts: number;
    lastPromptedAt?: Date;
    chatHistory?: string;
    proposedPropertyId?: string;
    proposedSlots?: string[];
    selectedVisitDay?: string;
    selectedVisitPeriod?: string;
    welcomeSent?: boolean;
    welcomeSentAt?: Date;
  };
  chatHistory: IChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const LeadSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, default: 'Anonymous' },
    mobile: { type: String, required: true, index: true }, // unique scoped by tenant handled in code
    email: { type: String, default: '' },
    source: { type: String, default: 'Manual Entry' },
    budget: { type: Number, default: 0 },
    location: { type: String, default: '' },
    propertyType: {
      type: String,
      enum: ['Apartment', 'Villa', 'Plot', 'Commercial', 'Any'],
      default: 'Any',
    },
    purpose: {
      type: String,
      enum: ['Buy', 'Invest', 'Any'],
      default: 'Any',
    },
    status: {
      type: String,
      enum: [
        'New',
        'Qualifying',
        'Qualified',
        'Incomplete',
        'Slot Pending',
        'Visit Scheduled',
        'Visit Done',
        'Ready to Buy',
        'Booked',
        'Cold',
      ],
      default: 'New',
    },
    score: {
      type: String,
      enum: ['Hot', 'Warm', 'Cold', null],
      default: null,
    },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    timeline: [
      {
        event: { type: String, required: true },
        timestamp: { type: Date, default: Date.now },
        actor: {
          type: String,
          enum: ['System', 'AI', 'Sales Executive', 'Sales Manager', 'Admin', 'Lead'],
          required: true,
        },
        details: { type: String },
      },
    ],
    aiContext: {
      attempts: { type: Number, default: 0 },
      lastPromptedAt: { type: Date },
      chatHistory: { type: String, default: '' },
      proposedPropertyId: { type: String },
      proposedSlots: { type: [String], default: [] },
      selectedVisitDay: { type: String, default: '' },
      selectedVisitPeriod: { type: String, default: '' },
      welcomeSent: { type: Boolean, default: false },
      welcomeSentAt: { type: Date },
    },
    chatHistory: [
      {
        role: { type: String, enum: ['user', 'model'], required: true },
        text: { type: String, required: true },
      }
    ],
  },
  { timestamps: true }
);

// SaaS Compound Indexes
LeadSchema.index({ tenantId: 1, createdAt: -1 });
LeadSchema.index({ tenantId: 1, status: 1 });
LeadSchema.index({ tenantId: 1, mobile: 1 }, { unique: true }); // Mobile unique per tenant!

export default mongoose.model<ILead>('Lead', LeadSchema);
