import { Response } from 'express';
import { TenantRequest } from '../middleware/tenant';
import Lead from '../models/Lead';
import BaseRepository from '../repositories/BaseRepository';
import { getIO } from '../services/socket/socketService';
import { getQueue } from '../services/queue/queueConfig';

const leadRepository = new BaseRepository(Lead);

export const getLeads = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { source, score, status, assignedTo, search } = req.query;
    const filter: any = {};

    if (source) filter.source = source;
    if (score) filter.score = score === 'null' ? null : score;
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo === 'null' ? null : assignedTo;

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { mobile: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } },
      ];
    }

    const userRole = (req as any).user?.role;
    const userId = (req as any).user?.id;
    if (userRole === 'Sales Executive') {
      filter.assignedTo = userId;
    }

    // Isolated lookup
    const leads = await leadRepository.find(tenantId, filter, {
      path: 'assignedTo',
      select: 'name email role',
    });

    return res.status(200).json(leads);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const getLeadById = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const lead = await leadRepository.findOne(tenantId, { _id: req.params.id }, 'assignedTo');
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    return res.status(200).json(lead);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const createLead = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { name, mobile, email, source, budget, location, propertyType, purpose, status } = req.body;

    if (!mobile) {
      return res.status(400).json({ message: 'Mobile number is required' });
    }

    // Scope unique check to active tenant
    let lead = await leadRepository.findOne(tenantId, { mobile });

    if (lead) {
      lead.name = name || lead.name;
      lead.email = email || lead.email;
      lead.budget = budget || lead.budget;
      lead.location = location || lead.location;
      lead.propertyType = propertyType || lead.propertyType;
      lead.purpose = purpose || lead.purpose;
      if (status) lead.status = status;

      lead.timeline.push({
        event: 'Lead Re-entered / Updated',
        timestamp: new Date(),
        actor: 'System',
        details: `Lead matched existing record. Source updated to ${source || lead.source}`,
      });

      lead.source = source || lead.source;
      await lead.save();

      const io = getIO();
      if (io) {
        io.to('/crm').emit('lead:updated', lead);
      }

      return res.status(200).json({ message: 'Lead updated (deduplicated)', lead });
    } else {
      lead = await leadRepository.create(tenantId, {
        name,
        mobile,
        email,
        source,
        budget,
        location,
        propertyType,
        purpose,
        status: status || 'New',
        timeline: [
          {
            event: 'Lead Created',
            timestamp: new Date(),
            actor: 'System',
            details: `Lead imported or captured via ${source || 'Manual Entry'}`,
          },
        ],
      });

      const qualifyQueue = getQueue('qualify-lead');
      if (qualifyQueue) {
        await qualifyQueue.add('qualify', { leadId: lead._id });
      }

      const io = getIO();
      if (io) {
        io.to('/crm').emit('lead:new', lead);
      }

      return res.status(201).json({ message: 'Lead created successfully', lead });
    }
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const updateLead = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { name, email, budget, location, propertyType, purpose, status, score, assignedTo } = req.body;
    const lead = await leadRepository.findOne(tenantId, { _id: req.params.id });

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const changes: string[] = [];
    if (name && name !== lead.name) {
      changes.push(`Name: ${lead.name} -> ${name}`);
      lead.name = name;
    }
    if (email !== undefined && email !== lead.email) {
      changes.push(`Email: ${lead.email} -> ${email}`);
      lead.email = email;
    }
    if (budget !== undefined && budget !== lead.budget) {
      changes.push(`Budget: ${lead.budget} -> ${budget}`);
      lead.budget = budget;
    }
    if (location !== undefined && location !== lead.location) {
      changes.push(`Location: ${lead.location} -> ${location}`);
      lead.location = location;
    }
    if (propertyType && propertyType !== lead.propertyType) {
      changes.push(`Type: ${lead.propertyType} -> ${propertyType}`);
      lead.propertyType = propertyType;
    }
    if (purpose && purpose !== lead.purpose) {
      changes.push(`Purpose: ${lead.purpose} -> ${purpose}`);
      lead.purpose = purpose;
    }
    if (status && status !== lead.status) {
      changes.push(`Status: ${lead.status} -> ${status}`);
      lead.status = status;
      if (status === 'Qualified') {
        const followUpQueue = getQueue('follow-up');
        if (followUpQueue) {
          await followUpQueue.add('property-match', { leadId: lead._id });
        }
      }
    }
    if (score !== undefined && score !== lead.score) {
      changes.push(`Score: ${lead.score} -> ${score}`);
      lead.score = score;
    }
    if (assignedTo !== undefined && String(assignedTo) !== String(lead.assignedTo)) {
      changes.push(`AssignedTo: ${lead.assignedTo} -> ${assignedTo}`);
      lead.assignedTo = assignedTo || null;
    }

    if (changes.length > 0) {
      lead.timeline.push({
        event: 'Lead Details Updated',
        timestamp: new Date(),
        actor: (req as any).user?.role || 'System',
        details: changes.join(', '),
      });
      await lead.save();

      const io = getIO();
      if (io) {
        io.to('/crm').emit('lead:updated', lead);
      }
    }

    return res.status(200).json(lead);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const deleteLead = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const lead = await leadRepository.findByIdAndDelete(tenantId, req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    
    const io = getIO();
    if (io) {
      io.to('/crm').emit('lead:deleted', req.params.id);
    }

    return res.status(200).json({ message: 'Lead deleted successfully' });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const importLeads = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { csvText } = req.body;
    if (!csvText) {
      return res.status(400).json({ message: 'CSV text is required' });
    }

    const lines = csvText.split('\n');
    const headers = lines[0].split(',').map((h: string) => h.trim());

    const results = [];
    const io = getIO();
    const qualifyQueue = getQueue('qualify-lead');

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = line.split(',').map((v: string) => v.trim());
      const rowData: any = {};
      headers.forEach((header: string, index: number) => {
        rowData[header] = values[index];
      });

      const { name, mobile, email, source, budget, location, propertyType, purpose } = rowData;
      if (!mobile) continue;

      let lead = await leadRepository.findOne(tenantId, { mobile });
      if (!lead) {
        if (req.tenant) {
          const currentCount = await Lead.countDocuments({ tenantId });
          if (currentCount >= req.tenant.maxLeads) {
            break; // Stop importing once limit is reached
          }
        }

        lead = await leadRepository.create(tenantId, {
          name: name || 'Anonymous',
          mobile,
          email: email || '',
          source: source || 'CSV Import',
          budget: Number(budget) || 0,
          location: location || '',
          propertyType: propertyType || 'Any',
          purpose: purpose || 'Any',
          status: 'New',
          timeline: [
            {
              event: 'Lead Created',
              timestamp: new Date(),
              actor: 'System',
              details: 'Bulk imported via CSV upload',
            },
          ],
        });
        results.push(lead);

        if (qualifyQueue) {
          await qualifyQueue.add('qualify', { leadId: lead._id });
        }
        if (io) {
          io.to('/crm').emit('lead:new', lead);
        }
      }
    }

    return res.status(200).json({
      message: `Successfully imported ${results.length} new leads.`,
      importedCount: results.length,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
