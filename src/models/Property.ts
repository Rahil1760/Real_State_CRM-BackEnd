import mongoose, { Schema, Document } from 'mongoose';

export interface IProperty extends Document {
  tenantId: mongoose.Types.ObjectId;
  title: string;
  type: 'Apartment' | 'Villa' | 'Plot' | 'Commercial';
  location: string;
  price: number;
  amenities: string[];
  s3Urls: {
    brochure: string;
    floorPlan: string;
  };
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

const PropertySchema: Schema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    title: { type: String, required: true },
    type: {
      type: String,
      enum: ['Apartment', 'Villa', 'Plot', 'Commercial'],
      required: true,
    },
    location: { type: String, required: true, lowercase: true, trim: true },
    price: { type: Number, required: true },
    amenities: [{ type: String }],
    s3Urls: {
      brochure: { type: String, default: '' },
      floorPlan: { type: String, default: '' },
    },
    description: { type: String, default: '' },
  },
  { timestamps: true }
);

// Indexes
PropertySchema.index({ tenantId: 1, createdAt: -1 });
PropertySchema.index({ tenantId: 1, location: 1 });
PropertySchema.index({ location: "text" })

export default mongoose.model<IProperty>('Property', PropertySchema);
