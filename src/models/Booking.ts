import mongoose, { Schema, Document } from 'mongoose';

export interface IBooking extends Document {
  tenantId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId;
  propertyId: mongoose.Types.ObjectId;
  amount: number;
  paymentId?: string;
  paymentLink?: string;
  status: 'Pending Approval' | 'Approved' | 'Paid' | 'Cancelled';
  approvedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const BookingSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
    amount: { type: Number, required: true },
    paymentId: { type: String, default: '' },
    paymentLink: { type: String, default: '' },
    status: {
      type: String,
      enum: ['Pending Approval', 'Approved', 'Paid', 'Cancelled'],
      default: 'Pending Approval',
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// Indexes
BookingSchema.index({ tenantId: 1, createdAt: -1 });
BookingSchema.index({ tenantId: 1, status: 1 });

export default mongoose.model<IBooking>('Booking', BookingSchema);
