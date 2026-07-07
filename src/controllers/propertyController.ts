import { Response } from 'express';
import { TenantRequest } from '../middleware/tenant';
import Property from '../models/Property';
import BaseRepository from '../repositories/BaseRepository';

const propertyRepository = new BaseRepository(Property);

export const getProperties = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { type, location, minPrice, maxPrice, search } = req.query;
    const filter: any = {};

    if (type) filter.type = type;
    if (location) filter.location = { $regex: location as string, $options: 'i' };
    
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const properties = await propertyRepository.find(tenantId, filter);
    return res.status(200).json(properties);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const getPropertyById = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const property = await propertyRepository.findOne(tenantId, { _id: req.params.id });
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }
    return res.status(200).json(property);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const createProperty = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { title, type, location, price, amenities, brochureUrl, floorPlanUrl, description } = req.body;

    if (!title || !type || !location || !price) {
      return res.status(400).json({ message: 'Title, type, location, and price are required' });
    }

    const s3Urls = {
      brochure: brochureUrl || 'https://mock-s3-bucket.s3.amazonaws.com/brochures/default.pdf',
      floorPlan: floorPlanUrl || 'https://mock-s3-bucket.s3.amazonaws.com/floorplans/default.png',
    };

    const property = await propertyRepository.create(tenantId, {
      title,
      type,
      location,
      price,
      amenities: Array.isArray(amenities) ? amenities : amenities ? [amenities] : [],
      s3Urls,
      description,
    });

    return res.status(201).json(property);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const updateProperty = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { title, type, location, price, amenities, brochureUrl, floorPlanUrl, description } = req.body;
    const property = await propertyRepository.findOne(tenantId, { _id: req.params.id });

    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    property.title = title || property.title;
    property.type = type || property.type;
    property.location = location || property.location;
    property.price = price !== undefined ? price : property.price;
    property.description = description || property.description;

    if (amenities) {
      property.amenities = Array.isArray(amenities) ? amenities : [amenities];
    }

    if (brochureUrl || floorPlanUrl) {
      property.s3Urls = {
        brochure: brochureUrl || property.s3Urls.brochure,
        floorPlan: floorPlanUrl || property.s3Urls.floorPlan,
      };
    }

    await property.save();
    return res.status(200).json(property);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const deleteProperty = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const property = await propertyRepository.findByIdAndDelete(tenantId, req.params.id);
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }
    return res.status(200).json({ message: 'Property deleted successfully' });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
