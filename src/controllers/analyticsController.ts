import { Response } from 'express';
import { TenantRequest } from '../middleware/tenant';
import Lead from '../models/Lead';
import Visit from '../models/Visit';
import Booking from '../models/Booking';
import mongoose from 'mongoose';

export const getAggregatedStats = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { startDate, endDate } = req.query;
    
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate as string);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate as string);
    }

    const tenantFilter = { tenantId, ...dateFilter };

    const totalLeads = await Lead.countDocuments(tenantFilter);
    const totalVisits = await Visit.countDocuments({
      ...tenantFilter,
      status: { $in: ['Scheduled', 'Completed'] },
    });
    const paidBookingsCount = await Booking.countDocuments({ ...tenantFilter, status: 'Paid' });

    // Calculate revenue scoped by tenant
    const revenueAggregate = await Booking.aggregate([
      { 
        $match: { 
          tenantId: new mongoose.Types.ObjectId(String(tenantId)), 
          status: 'Paid',
          ...(dateFilter.createdAt ? { createdAt: dateFilter.createdAt } : {})
        } 
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const totalRevenue = revenueAggregate[0]?.total || 0;

    const conversionRate = totalLeads > 0 ? (paidBookingsCount / totalLeads) * 100 : 0;

    const customMarketingSpend = req.tenant?.marketingSpend || 0;
    const simulatedMarketingSpend = customMarketingSpend > 0 ? customMarketingSpend : (totalLeads * 10000);
    const roi = simulatedMarketingSpend > 0 ? ((totalRevenue - simulatedMarketingSpend) / simulatedMarketingSpend) * 100 : 0;

    // Leads by source breakdown scoped by tenant
    const leadsBySource = await Lead.aggregate([
      { 
        $match: { 
          tenantId: new mongoose.Types.ObjectId(String(tenantId)),
          ...(dateFilter.createdAt ? { createdAt: dateFilter.createdAt } : {})
        } 
      },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]);

    // Leads by status pipeline breakdown scoped by tenant
    const leadsByStatus = await Lead.aggregate([
      { 
        $match: { 
          tenantId: new mongoose.Types.ObjectId(String(tenantId)),
          ...(dateFilter.createdAt ? { createdAt: dateFilter.createdAt } : {})
        } 
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    return res.status(200).json({
      summary: {
        totalLeads,
        totalVisits,
        bookings: paidBookingsCount,
        revenue: totalRevenue,
        conversionRate: Number(conversionRate.toFixed(2)),
        roi: Number(roi.toFixed(2)),
        marketingSpend: simulatedMarketingSpend,
        customMarketingSpend: customMarketingSpend,
        customMarketingSpendBreakdown: req.tenant?.marketingSpendBreakdown || { meta: 0, google: 0, other: 0 },
      },
      sources: leadsBySource.map(s => ({ name: s._id, count: s.count })),
      pipeline: leadsByStatus.map(p => ({ name: p._id, count: p.count })),
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const exportLeadsCSV = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const leads = await Lead.find({ tenantId }).select('name mobile email source budget location propertyType purpose status score createdAt');
    
    let csv = 'Name,Mobile,Email,Source,Budget,Location,Type,Purpose,Status,Score,CreatedDate\n';
    
    leads.forEach((l) => {
      csv += `"${l.name}","${l.mobile}","${l.email}","${l.source}",${l.budget},"${l.location}","${l.propertyType}","${l.purpose}","${l.status}","${l.score || 'None'}","${l.createdAt.toISOString()}"\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment('CRM_Leads_Report.csv');
    return res.status(200).send(csv);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
