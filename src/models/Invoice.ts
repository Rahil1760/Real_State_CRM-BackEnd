import mongoose, { Schema, Document } from 'mongoose';

export interface IInvoice extends Document {
  tenantId: mongoose.Types.ObjectId;
  amount: number;
  razorpayPaymentId: string;
  plan: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  status: 'paid' | 'unpaid';
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceSchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    amount: { type: Number, required: true },
    razorpayPaymentId: { type: String, required: true },
    plan: { type: String, required: true },
    billingPeriodStart: { type: Date, required: true },
    billingPeriodEnd: { type: Date, required: true },
    status: { type: String, enum: ['paid', 'unpaid'], default: 'paid' },
  },
  { timestamps: true }
);

export default mongoose.model<IInvoice>('Invoice', InvoiceSchema);
