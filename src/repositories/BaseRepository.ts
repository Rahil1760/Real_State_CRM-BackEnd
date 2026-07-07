import mongoose, { Document, Model, FilterQuery, UpdateQuery } from 'mongoose';

export class BaseRepository<T extends Document> {
  constructor(private model: Model<T>) {}

  private scopeQuery(tenantId: string | mongoose.Types.ObjectId, filter: FilterQuery<T> = {}): FilterQuery<T> {
    return { ...filter, tenantId };
  }

  async find(tenantId: string | mongoose.Types.ObjectId, filter: FilterQuery<T> = {}, populate: string | any = '') {
    return this.model.find(this.scopeQuery(tenantId, filter)).populate(populate);
  }

  async findOne(tenantId: string | mongoose.Types.ObjectId, filter: FilterQuery<T> = {}, populate: string | any = '') {
    return this.model.findOne(this.scopeQuery(tenantId, filter)).populate(populate);
  }

  async create(tenantId: string | mongoose.Types.ObjectId, data: any) {
    return this.model.create({ ...data, tenantId });
  }

  async findByIdAndUpdate(tenantId: string | mongoose.Types.ObjectId, id: string, update: UpdateQuery<T>) {
    return this.model.findOneAndUpdate(
      this.scopeQuery(tenantId, { _id: id } as any),
      update,
      { new: true }
    );
  }

  async findByIdAndDelete(tenantId: string | mongoose.Types.ObjectId, id: string) {
    return this.model.findOneAndDelete(this.scopeQuery(tenantId, { _id: id } as any));
  }

  async countDocuments(tenantId: string | mongoose.Types.ObjectId, filter: FilterQuery<T> = {}) {
    return this.model.countDocuments(this.scopeQuery(tenantId, filter));
  }

  async aggregate(tenantId: string | mongoose.Types.ObjectId, pipeline: any[]) {
    // Inject tenantId match stage at the very beginning of the aggregation pipeline
    const matchStage = { $match: { tenantId: new mongoose.Types.ObjectId(String(tenantId)) } };
    return this.model.aggregate([matchStage, ...pipeline]);
  }
}
export default BaseRepository;
