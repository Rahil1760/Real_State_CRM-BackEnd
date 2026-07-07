import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  name: string;
  email: string;
  phone?: string;
  passwordHash: string;
  role: 'Admin' | 'Sales Manager' | 'Sales Executive' | 'AI' | 'SuperAdmin';
  tenantId: mongoose.Types.ObjectId | null;
  assignedLeads: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String, default: '' },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ['Admin', 'Sales Manager', 'Sales Executive', 'AI', 'SuperAdmin'],
      required: true,
    },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null },
    assignedLeads: [{ type: Schema.Types.ObjectId, ref: 'Lead' }],
  },
  { timestamps: true }
);

// Indexes for strict multi-tenant isolation
UserSchema.index({ tenantId: 1, createdAt: -1 });
UserSchema.index({ tenantId: 1, role: 1 });

export default mongoose.model<IUser>('User', UserSchema);
